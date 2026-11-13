//! Branches, tags, remotes, stashes, submodules, ahead/behind and the per-repo summary.

use std::collections::HashMap;
use std::path::Path;

use crate::error::GitError;
use crate::model::*;
use crate::runner::Git;
use crate::state;

fn path_of(repo: &RepoInfo) -> &Path {
    Path::new(&repo.path)
}

struct RefLine {
    oid: String,
    peeled: String,
    name: String,
    is_head: bool,
    upstream: String,
    track: String,
    object_type: String,
}

const REF_FORMAT: &str = "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(objecttype)";

fn list_ref_lines(git: &Git, repo: &RepoInfo, patterns: &[&str]) -> Result<Vec<RefLine>, GitError> {
    let mut args = vec!["for-each-ref", REF_FORMAT];
    args.extend_from_slice(patterns);
    let out = git.run(path_of(repo), Some(&repo.id), &args, false)?;
    let mut lines = Vec::new();
    for line in out.stdout.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() != 7 {
            return Err(GitError::Parse(format!("for-each-ref line: {line:?}")));
        }
        lines.push(RefLine {
            oid: f[0].to_string(),
            peeled: f[1].to_string(),
            name: f[2].to_string(),
            is_head: f[3] == "*",
            upstream: f[4].to_string(),
            track: f[5].to_string(),
            object_type: f[6].to_string(),
        });
    }
    Ok(lines)
}

fn parse_track(track: &str) -> (u32, u32, bool) {
    let (mut ahead, mut behind, mut gone) = (0, 0, false);
    for part in track.split(',').map(str::trim) {
        if part == "gone" {
            gone = true;
        } else if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, gone)
}

/// All refs of a repo: local and remote branches, tags, stashes, remotes and submodules.
pub fn read_refs(git: &Git, repo: &RepoInfo) -> Result<Refs, GitError> {
    let remotes = read_remotes(git, repo)?;
    let mut refs = Refs {
        remotes,
        ..Refs::default()
    };
    for l in list_ref_lines(git, repo, &["refs/heads", "refs/remotes", "refs/tags"])? {
        if let Some(name) = l.name.strip_prefix("refs/heads/") {
            let (ahead, behind, gone) = parse_track(&l.track);
            refs.local.push(LocalBranch {
                name: name.to_string(),
                oid: l.oid,
                upstream: (!l.upstream.is_empty()).then_some(l.upstream),
                ahead,
                behind,
                is_head: l.is_head,
                gone,
            });
        } else if let Some(full) = l.name.strip_prefix("refs/remotes/") {
            if full.ends_with("/HEAD") {
                continue;
            }
            let (remote, name) = split_remote(&refs.remotes, full);
            refs.remote.push(RemoteBranch {
                remote,
                name,
                full_name: full.to_string(),
                oid: l.oid,
            });
        } else if let Some(name) = l.name.strip_prefix("refs/tags/") {
            let annotated = l.object_type == "tag";
            refs.tags.push(Tag {
                name: name.to_string(),
                oid: if l.peeled.is_empty() { l.oid } else { l.peeled },
                annotated,
            });
        }
    }
    refs.stashes = read_stashes(git, repo)?;
    refs.submodules = read_submodules(git, repo);
    Ok(refs)
}

/// Splits "origin/feature/x" into ("origin", "feature/x"), preferring a configured remote name.
fn split_remote(remotes: &[Remote], full: &str) -> (String, String) {
    let configured = remotes
        .iter()
        .filter(|r| {
            full.strip_prefix(r.name.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
        })
        .max_by_key(|r| r.name.len());
    let remote_len = match configured {
        Some(r) => r.name.len(),
        None => full.find('/').unwrap_or(full.len()),
    };
    let remote = full[..remote_len].to_string();
    let name = full.get(remote_len + 1..).unwrap_or("").to_string();
    (remote, name)
}

pub(crate) fn read_remotes(git: &Git, repo: &RepoInfo) -> Result<Vec<Remote>, GitError> {
    let out = git.run(path_of(repo), Some(&repo.id), &["remote", "-v"], false)?;
    let mut remotes: Vec<Remote> = Vec::new();
    for line in out.stdout.lines() {
        // "origin\thttps://example.com/x.git (fetch)"
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let Some(url) = rest.strip_suffix(" (fetch)") else {
            continue;
        };
        if !remotes.iter().any(|r| r.name == name) {
            remotes.push(Remote {
                name: name.to_string(),
                url: url.to_string(),
            });
        }
    }
    Ok(remotes)
}

fn read_stashes(git: &Git, repo: &RepoInfo) -> Result<Vec<Stash>, GitError> {
    // NUL separated: a stash message can hold any other control character.
    let out = git.run(
        path_of(repo),
        Some(&repo.id),
        &["stash", "list", "-z", "--format=%H%x00%gd%x00%gs%x00%ct"],
        false,
    )?;
    let mut tokens: Vec<&str> = out.stdout.split('\0').collect();
    if tokens.len() % 4 == 1 && tokens.last().is_some_and(|t| t.is_empty()) {
        tokens.pop();
    }
    let mut stashes = Vec::new();
    for f in tokens.as_chunks::<4>().0 {
        // A record whose selector does not parse is skipped instead of failing the whole list.
        let Some(index) = f[1]
            .trim_start_matches('\n')
            .strip_prefix("stash@{")
            .and_then(|s| s.strip_suffix('}'))
            .and_then(|s| s.parse().ok())
        else {
            continue;
        };
        stashes.push(Stash {
            index,
            message: f[2].to_string(),
            oid: f[0].trim_start_matches('\n').to_string(),
            time: f[3].parse().unwrap_or(0),
        });
    }
    Ok(stashes)
}

/// Errors are swallowed: a broken `.gitmodules` must not hide the other refs.
fn read_submodules(git: &Git, repo: &RepoInfo) -> Vec<Submodule> {
    let Ok(out) = git.run(
        path_of(repo),
        Some(&repo.id),
        &["submodule", "status"],
        false,
    ) else {
        return Vec::new();
    };
    out.stdout
        .lines()
        .filter_map(|line| {
            let status = line.chars().next()?;
            let rest = line.get(1..)?;
            let (oid, rest) = rest.split_once(' ')?;
            // "path (describe)": the describe part is optional.
            let path = match rest.rfind(" (") {
                Some(i) if rest.ends_with(')') => &rest[..i],
                _ => rest,
            };
            Some(Submodule {
                path: path.to_string(),
                oid: oid.to_string(),
                status,
            })
        })
        .collect()
}

/// Ref labels of a repo indexed by commit oid, plus what the log needs to pick its default refs.
pub struct LabelIndex {
    pub by_oid: HashMap<String, Vec<RefLabel>>,
    /// Some branch, remote branch or tag exists.
    pub has_refs: bool,
    /// Set when HEAD is detached: the commit it points at.
    pub detached_head: Option<String>,
}

fn kind_rank(k: RefKind) -> u8 {
    match k {
        RefKind::Head => 0,
        RefKind::Local => 1,
        RefKind::Remote => 2,
        RefKind::Tag => 3,
        RefKind::Stash => 4,
    }
}

pub fn label_index(git: &Git, repo: &RepoInfo) -> Result<LabelIndex, GitError> {
    let lines = list_ref_lines(
        git,
        repo,
        &["refs/heads", "refs/remotes", "refs/tags", "refs/stash"],
    )?;
    let mut by_oid: HashMap<String, Vec<RefLabel>> = HashMap::new();
    let mut has_refs = false;
    let mut head_on_branch = false;
    for l in lines {
        let (kind, name, is_current, oid) = if let Some(n) = l.name.strip_prefix("refs/heads/") {
            head_on_branch |= l.is_head;
            (RefKind::Local, n.to_string(), l.is_head, l.oid)
        } else if let Some(n) = l.name.strip_prefix("refs/remotes/") {
            if n.ends_with("/HEAD") {
                continue;
            }
            (RefKind::Remote, n.to_string(), false, l.oid)
        } else if let Some(n) = l.name.strip_prefix("refs/tags/") {
            let oid = if l.peeled.is_empty() { l.oid } else { l.peeled };
            (RefKind::Tag, n.to_string(), false, oid)
        } else if l.name == "refs/stash" {
            (RefKind::Stash, "stash".to_string(), false, l.oid)
        } else {
            continue;
        };
        if kind != RefKind::Stash {
            has_refs = true;
        }
        by_oid.entry(oid).or_default().push(RefLabel {
            kind,
            name,
            is_current,
        });
    }
    let mut detached_head = None;
    if !head_on_branch {
        let out = git.run_unchecked(
            path_of(repo),
            Some(&repo.id),
            &["rev-parse", "-q", "--verify", "HEAD"],
            false,
            None,
        )?;
        let oid = out.stdout.trim();
        if out.code == 0 && !oid.is_empty() {
            by_oid.entry(oid.to_string()).or_default().push(RefLabel {
                kind: RefKind::Head,
                name: "HEAD".to_string(),
                is_current: true,
            });
            detached_head = Some(oid.to_string());
        }
    }
    for labels in by_oid.values_mut() {
        labels.sort_by(|a, b| {
            kind_rank(a.kind)
                .cmp(&kind_rank(b.kind))
                .then(b.is_current.cmp(&a.is_current))
                .then(a.name.cmp(&b.name))
        });
    }
    Ok(LabelIndex {
        by_oid,
        has_refs,
        detached_head,
    })
}

/// Branch, ahead/behind, working tree counts, in-progress state and stash count of one repo.
pub fn repo_summary(git: &Git, repo: &RepoInfo) -> Result<RepoSummary, GitError> {
    let out = git.run(
        path_of(repo),
        Some(&repo.id),
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
        false,
    )?;
    let mut s = RepoSummary {
        repo_id: repo.id.clone(),
        branch: None,
        head_oid: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        state: RepoStateKind::Clean,
        stash_count: 0,
    };
    let mut tokens = out.stdout.split('\0').filter(|t| !t.is_empty());
    while let Some(tok) = tokens.next() {
        if let Some(h) = tok.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.oid ") {
                s.head_oid = (v != "(initial)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.head ") {
                s.branch = (v != "(detached)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                s.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                let mut it = v.split_whitespace();
                s.ahead = it
                    .next()
                    .and_then(|a| a.trim_start_matches('+').parse().ok())
                    .unwrap_or(0);
                s.behind = it
                    .next()
                    .and_then(|b| b.trim_start_matches('-').parse().ok())
                    .unwrap_or(0);
            }
            continue;
        }
        let mut chars = tok.chars();
        match chars.next() {
            Some('1') | Some('2') => {
                let xy: Vec<char> = tok.chars().skip(2).take(2).collect();
                if xy.len() == 2 {
                    s.staged += u32::from(xy[0] != '.');
                    s.unstaged += u32::from(xy[1] != '.');
                }
                if tok.starts_with('2') {
                    tokens.next(); // original path of a rename/copy
                }
            }
            Some('u') => s.conflicted += 1,
            Some('?') => s.untracked += 1,
            _ => {}
        }
    }
    s.state = state::repo_state(path_of(repo))?;
    let stash = git.run(path_of(repo), Some(&repo.id), &["stash", "list"], false)?;
    s.stash_count = stash.stdout.lines().filter(|l| !l.is_empty()).count() as u32;
    Ok(s)
}

/// Names of the local ("main") and remote ("origin/main") branches containing `oid`.
pub fn branches_containing(git: &Git, repo: &RepoInfo, oid: &str) -> Result<Vec<String>, GitError> {
    crate::error::check_name("commit", oid)?;
    let contains = format!("--contains={oid}");
    let out = git.run(
        path_of(repo),
        Some(&repo.id),
        &[
            "for-each-ref",
            "--format=%(refname)",
            &contains,
            "refs/heads",
            "refs/remotes",
        ],
        false,
    )?;
    Ok(out
        .stdout
        .lines()
        .filter_map(|l| {
            if let Some(n) = l.strip_prefix("refs/heads/") {
                Some(n.to_string())
            } else {
                l.strip_prefix("refs/remotes/")
                    .filter(|n| !n.ends_with("/HEAD"))
                    .map(str::to_string)
            }
        })
        .collect())
}

/// Commits of the local branch that are on no remote: `git rev-list --count refs/heads/<branch> --not --remotes`.
/// The branch is a full ref, so a tag with the same name is never used. A missing branch is an error.
pub fn unpushed_count(git: &Git, repo: &RepoInfo, branch: &str) -> Result<u32, GitError> {
    crate::error::check_push_branch("branch name", branch)?;
    if branch.contains("..") {
        return Err(GitError::Invalid(format!(
            "Invalid branch name {branch:?}: it cannot contain '..'."
        )));
    }
    let full = format!("refs/heads/{branch}");
    let out = git.run(
        path_of(repo),
        Some(&repo.id),
        &["rev-list", "--count", &full, "--not", "--remotes"],
        false,
    )?;
    out.stdout.trim().parse().map_err(|_| {
        GitError::Invalid(format!("Unexpected output of rev-list: {:?}", out.stdout))
    })
}
