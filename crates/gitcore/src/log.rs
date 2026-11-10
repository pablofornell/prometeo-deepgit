//! `git log` loading for one or more repos, k-way merge and graph layout (PLAN.md section 7).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use crate::error::{check_name, GitError};
use crate::graph;
use crate::model::*;
use crate::refs::{self, LabelIndex};
use crate::runner::Git;

/// Fields are NUL separated (`-z` ends each record with a NUL too): a subject or a name can hold
/// any other control character, but never a NUL.
const LOG_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s";
const LOG_FIELDS: usize = 7;
const MAX_PARALLEL: usize = 8;

/// One commit of one repo before the merge.
struct Raw {
    oid: String,
    parents: Vec<String>,
    author_name: String,
    author_email: String,
    author_time: i64,
    committer_time: i64,
    subject: String,
    refs: Vec<RefLabel>,
}

/// Graph key: repo index and oid, so repos never share lanes.
type Key<'a> = (usize, &'a str);

struct RepoLog {
    rows: Vec<Raw>,
    truncated: bool,
}

/// Loads the log of `repos` (restricted to `q.repo_ids` when it is not empty), merges them by
/// committer time and computes the graph. Returns `(rows, max_lanes, truncated, skipped)`.
///
/// A repo that fails to load (folder gone, git error) is skipped and listed in `skipped`; the
/// error is returned only when every selected repo failed.
pub fn load(
    git: &Git,
    repos: &[RepoInfo],
    q: &LogQuery,
) -> Result<(Vec<CommitRow>, u16, bool, Vec<SkippedRepo>), GitError> {
    let selected: Vec<&RepoInfo> = repos
        .iter()
        .filter(|r| q.repo_ids.is_empty() || q.repo_ids.contains(&r.id))
        .collect();
    let max_count = if q.max_count == 0 {
        DEFAULT_MAX_COUNT
    } else {
        q.max_count
    };

    let results = parallel_map(&selected, |repo| load_repo(git, repo, q, max_count));
    let mut ok: Vec<(&RepoInfo, RepoLog)> = Vec::with_capacity(selected.len());
    let mut failed: Vec<(&RepoInfo, GitError)> = Vec::new();
    for (repo, result) in selected.iter().zip(results) {
        match result {
            Ok(log) => ok.push((repo, log)),
            Err(e) => failed.push((repo, e)),
        }
    }
    if ok.is_empty() && !failed.is_empty() {
        return Err(failed.swap_remove(0).1);
    }
    let skipped: Vec<SkippedRepo> = failed
        .into_iter()
        .map(|(repo, e)| SkippedRepo {
            repo_id: repo.id.clone(),
            message: ApiError::from(e).message,
        })
        .collect();
    let (selected, logs): (Vec<&RepoInfo>, Vec<RepoLog>) = ok.into_iter().unzip();
    let truncated = logs.iter().any(|l| l.truncated);

    // k-way merge: only fronts are popped, which keeps each repo's own order.
    let total: usize = logs.iter().map(|l| l.rows.len()).sum();
    let mut lists: Vec<std::vec::IntoIter<Raw>> =
        logs.into_iter().map(|l| l.rows.into_iter()).collect();
    let mut fronts: Vec<Option<Raw>> = lists.iter_mut().map(Iterator::next).collect();
    let mut merged: Vec<(usize, Raw)> = Vec::with_capacity(total);
    loop {
        let best = fronts
            .iter()
            .enumerate()
            .filter_map(|(i, f)| f.as_ref().map(|r| (i, r.committer_time)))
            .fold(None::<(usize, i64)>, |acc, cand| match acc {
                Some(a) if a.1 >= cand.1 => Some(a),
                _ => Some(cand),
            });
        let Some((i, _)) = best else { break };
        if let Some(raw) = fronts[i].take() {
            merged.push((i, raw));
        }
        fronts[i] = lists[i].next();
    }

    // Graph. Parents that are not in the list (history cut by max-count or filters) are dropped so
    // no lane runs to the bottom for them.
    let present: HashSet<Key> = merged.iter().map(|(i, r)| (*i, r.oid.as_str())).collect();
    let graph_rows: Vec<(Key, Vec<Key>)> = merged
        .iter()
        .map(|(i, r)| {
            let parents = r
                .parents
                .iter()
                .map(|p| (*i, p.as_str()))
                .filter(|k| present.contains(k))
                .collect();
            ((*i, r.oid.as_str()), parents)
        })
        .collect();
    let hints: Vec<Option<u16>> = merged.iter().map(|(_, r)| branch_hint(&r.refs)).collect();
    let layout = graph::layout_with_hints(&graph_rows, &hints);
    let max_lanes = layout.iter().map(|g| g.width).max().unwrap_or(0);

    let rows = merged
        .into_iter()
        .zip(layout)
        .map(|((i, r), graph)| CommitRow {
            repo_id: selected[i].id.clone(),
            oid: r.oid,
            parents: r.parents,
            author_name: r.author_name,
            author_email: r.author_email,
            author_time: r.author_time,
            committer_time: r.committer_time,
            subject: r.subject,
            refs: r.refs,
            graph,
        })
        .collect();
    Ok((rows, max_lanes, truncated, skipped))
}

/// Stable colour from the first branch label of a commit ("origin/x" shares the colour of "x").
fn branch_hint(labels: &[RefLabel]) -> Option<u16> {
    labels.iter().find_map(|l| match l.kind {
        RefKind::Local => Some(graph::stable_color(&l.name)),
        RefKind::Remote => {
            let short = l.name.split_once('/').map_or(l.name.as_str(), |(_, n)| n);
            Some(graph::stable_color(short))
        }
        _ => None,
    })
}

/// Runs `f` over `items` on a small pool of scoped threads, keeping the input order. Each item
/// has its own result so one failure does not hide the others.
fn parallel_map<T: Sync, R: Send>(
    items: &[T],
    f: impl Fn(&T) -> Result<R, GitError> + Sync,
) -> Vec<Result<R, GitError>> {
    let slots: Vec<Mutex<Option<Result<R, GitError>>>> =
        items.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    let workers = items.len().clamp(1, MAX_PARALLEL);
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(item) = items.get(i) else { break };
                let r = f(item);
                if let Ok(mut slot) = slots[i].lock() {
                    *slot = Some(r);
                }
            });
        }
    });
    let mut out = Vec::with_capacity(items.len());
    for slot in slots {
        out.push(
            slot.into_inner()
                .ok()
                .flatten()
                .unwrap_or_else(|| Err(GitError::Parse("log worker panicked".into()))),
        );
    }
    out
}

fn is_hex_hash(t: &str) -> bool {
    (4..=40).contains(&t.len()) && t.chars().all(|c| c.is_ascii_hexdigit())
}

fn load_repo(
    git: &Git,
    repo: &RepoInfo,
    q: &LogQuery,
    max_count: u32,
) -> Result<RepoLog, GitError> {
    let path = Path::new(&repo.path);
    let labels = refs::label_index(git, repo)?;

    let Some(ref_args) = ref_args(git, repo, q, &labels)? else {
        return Ok(RepoLog {
            rows: Vec::new(),
            truncated: false,
        });
    };

    let count_arg = format!("--max-count={max_count}");
    let mut owned: Vec<String> = Vec::new();
    if let Some(t) = q.text.as_deref().filter(|t| !t.is_empty()) {
        owned.push(format!("--grep={t}"));
        owned.push("--fixed-strings".into());
        owned.push("--regexp-ignore-case".into());
    }
    if let Some(a) = q.author.as_deref().filter(|a| !a.is_empty()) {
        owned.push(format!("--author={a}"));
        if q.text.as_deref().is_none_or(str::is_empty) {
            owned.push("--fixed-strings".into());
            owned.push("--regexp-ignore-case".into());
        }
    }
    if let Some(s) = q.since {
        owned.push(format!("--since=@{s}"));
    }
    if let Some(u) = q.until {
        owned.push(format!("--until=@{u}"));
    }
    let path_filter = q.path.as_deref().filter(|p| !p.is_empty());
    if path_filter.is_some() {
        owned.push("--parents".into());
    }

    let mut args: Vec<&str> = vec![
        "log",
        "-z",
        "--topo-order",
        "--date-order",
        "--no-color",
        &count_arg,
        LOG_FORMAT,
    ];
    args.extend(owned.iter().map(String::as_str));
    if !q.refs.is_empty() {
        // Only explicit refs: the default `--branches --remotes ...` are options themselves.
        args.extend(git.end_of_options());
    }
    args.extend(ref_args.iter().map(String::as_str));
    if let Some(p) = path_filter {
        args.push("--");
        args.push(p);
    }
    let out = git.run(path, Some(&repo.id), &args, false)?;
    let mut rows = parse_log(&out.stdout, &labels)?;
    let truncated = rows.len() >= max_count as usize;

    // A hash typed in the search box also matches by oid prefix, on top of message matches.
    let unfiltered =
        q.author.is_none() && q.path.is_none() && q.since.is_none() && q.until.is_none();
    if let Some(t) = q.text.as_deref().filter(|t| is_hex_hash(t)) {
        if unfiltered {
            add_oid_match(git, repo, t, &labels, &mut rows)?;
        }
    }
    Ok(RepoLog { rows, truncated })
}

/// Revision arguments for `git log`, or `None` when the repo has nothing to show.
fn ref_args(
    git: &Git,
    repo: &RepoInfo,
    q: &LogQuery,
    labels: &LabelIndex,
) -> Result<Option<Vec<String>>, GitError> {
    if q.refs.is_empty() {
        if !labels.has_refs && labels.detached_head.is_none() {
            return Ok(None);
        }
        let mut v: Vec<String> = ["--branches", "--remotes", "--tags"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        if labels.detached_head.is_some() {
            v.push("HEAD".into());
        }
        return Ok(Some(v));
    }
    // Explicit refs: keep those that resolve in this repo (a branch may exist in only some repos).
    let mut v = Vec::new();
    for r in &q.refs {
        check_name("ref", r)?;
        let spec = format!("{r}^{{commit}}");
        let mut args = vec!["rev-parse", "-q", "--verify"];
        args.extend(git.end_of_options());
        args.push(&spec);
        let out = git.run_unchecked(Path::new(&repo.path), Some(&repo.id), &args, false, None)?;
        if out.code == 0 {
            v.push(r.clone());
        }
    }
    Ok(if v.is_empty() { None } else { Some(v) })
}

fn parse_log(text: &str, labels: &LabelIndex) -> Result<Vec<Raw>, GitError> {
    let mut tokens: Vec<&str> = text.split('\0').collect();
    // `-z` terminates the last record, which leaves one empty token at the end.
    if tokens.len() % LOG_FIELDS == 1 && tokens.last().is_some_and(|t| t.is_empty()) {
        tokens.pop();
    }
    // A record that does not look like one is skipped: one odd commit must not hide the log.
    Ok(tokens
        .as_chunks::<LOG_FIELDS>()
        .0
        .iter()
        .filter_map(|f| parse_record(f, labels))
        .collect())
}

fn parse_record(f: &[&str], labels: &LabelIndex) -> Option<Raw> {
    let oid = f[0].trim_start_matches('\n');
    if !(oid.len() == 40 || oid.len() == 64) || !oid.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let oid = oid.to_string();
    Some(Raw {
        refs: labels.by_oid.get(&oid).cloned().unwrap_or_default(),
        parents: f[1].split_whitespace().map(str::to_string).collect(),
        author_name: f[2].to_string(),
        author_email: f[3].to_string(),
        author_time: f[4].parse().unwrap_or(0),
        committer_time: f[5].parse().unwrap_or(0),
        subject: f[6].to_string(),
        oid,
    })
}

/// Inserts the commit whose oid starts with `prefix` (when there is exactly one and it is not
/// already listed), at the position its committer time gives. Its parents are kept only if listed.
fn add_oid_match(
    git: &Git,
    repo: &RepoInfo,
    prefix: &str,
    labels: &LabelIndex,
    rows: &mut Vec<Raw>,
) -> Result<(), GitError> {
    if rows.iter().any(|r| r.oid.starts_with(prefix)) {
        return Ok(());
    }
    let spec = format!("{prefix}^{{commit}}");
    let out = git.run_unchecked(
        Path::new(&repo.path),
        Some(&repo.id),
        &["log", "-1", "-z", "--no-color", LOG_FORMAT, &spec],
        false,
        None,
    )?;
    if out.code != 0 {
        return Ok(());
    }
    let mut parsed = parse_log(&out.stdout, labels)?;
    let Some(mut extra) = parsed.pop() else {
        return Ok(());
    };
    if rows.iter().any(|r| r.oid == extra.oid) {
        return Ok(());
    }
    let listed: HashMap<&str, ()> = rows.iter().map(|r| (r.oid.as_str(), ())).collect();
    extra.parents.retain(|p| listed.contains_key(p.as_str()));
    let pos = rows
        .iter()
        .position(|r| r.committer_time < extra.committer_time)
        .unwrap_or(rows.len());
    rows.insert(pos, extra);
    Ok(())
}
