//! Commit details, per-file diffs and the unified diff parser.

use std::io::Read;
use std::path::{Component, Path};

use crate::error::{check_name, GitError};
use crate::model::*;
use crate::refs;
use crate::runner::Git;
use crate::status;

/// The empty tree, used as the "parent" of a root commit.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/// Diffs longer than this many lines are not parsed (`FileDiff::too_large`).
pub const MAX_DIFF_LINES: usize = 20_000;
/// `file_content` returns at most this many bytes.
pub const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;

fn repo_path(repo: &RepoInfo) -> &Path {
    Path::new(&repo.path)
}

fn person(name: &str, email: &str, raw_date: &str) -> Person {
    // `--date=raw`: "<unix seconds> <+hhmm>"
    let (time, tz) = raw_date.split_once(' ').unwrap_or((raw_date, "+0000"));
    Person {
        name: name.to_string(),
        email: email.to_string(),
        time: time.parse().unwrap_or(0),
        tz: tz.to_string(),
    }
}

/// Metadata, ref labels and changed files (versus the first parent) of a commit.
pub fn commit_details(git: &Git, repo: &RepoInfo, oid: &str) -> Result<CommitDetails, GitError> {
    check_name("commit", oid)?;
    let path = repo_path(repo);
    let rev = format!("{oid}^{{commit}}");
    // NUL separates the fields: the subject and body can hold any other control character.
    let mut show_args = vec![
        "show",
        "-s",
        "--date=raw",
        "--format=%H%x00%P%x00%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%s%x00%b",
    ];
    show_args.extend(git.end_of_options());
    show_args.push(&rev);
    let meta = git.run(path, Some(&repo.id), &show_args, false)?;
    let f: Vec<&str> = meta.stdout.splitn(10, '\0').collect();
    if f.len() != 10 {
        return Err(GitError::Parse(format!(
            "commit metadata for {oid}: {} fields",
            f.len()
        )));
    }
    let full_oid = f[0].trim().to_string();
    let parents: Vec<String> = f[1].split_whitespace().map(str::to_string).collect();

    let mut diff_args = vec!["diff-tree", "-r", "-z", "-M", "--root", "--no-commit-id"];
    let mut numstat_args = diff_args.clone();
    diff_args.push("--name-status");
    numstat_args.push("--numstat");
    for args in [&mut diff_args, &mut numstat_args] {
        if let Some(p) = parents.first() {
            args.push(p);
        }
        args.push(&full_oid);
    }
    let names = git.run(path, Some(&repo.id), &diff_args, false)?;
    let counts = git.run(path, Some(&repo.id), &numstat_args, false)?;
    let mut files = parse_name_status(&names.stdout)?;
    let counts = status::parse_numstat(&counts.stdout);
    for file in &mut files {
        if let Some((a, d)) = counts.get(&file.path) {
            file.additions = *a;
            file.deletions = *d;
            file.binary = a.is_none() && d.is_none();
        }
    }

    let labels = refs::label_index(git, repo)?;
    Ok(CommitDetails {
        repo_id: repo.id.clone(),
        refs: labels.by_oid.get(&full_oid).cloned().unwrap_or_default(),
        oid: full_oid,
        parents,
        author: person(f[2], f[3], f[4]),
        committer: person(f[5], f[6], f[7]),
        subject: f[8].to_string(),
        body: f[9].trim().to_string(),
        files,
    })
}

/// Untracked files of a stash, or `None` when the stash has no third parent.
pub fn stash_untracked(
    git: &Git,
    repo: &RepoInfo,
    oid: &str,
) -> Result<Option<StashUntracked>, GitError> {
    check_name("commit", oid)?;
    let rev = format!("{oid}^3^{{commit}}");
    let mut args = vec!["rev-parse", "-q", "--verify"];
    args.extend(git.end_of_options());
    args.push(&rev);
    let out = git.run_unchecked(repo_path(repo), Some(&repo.id), &args, false, None)?;
    let u = out.stdout.trim();
    if out.code != 0 || u.is_empty() {
        return Ok(None);
    }
    let u = u.to_string();
    let d = commit_details(git, repo, &u)?;
    Ok(Some(StashUntracked {
        oid: u,
        files: d.files,
    }))
}

/// Parses `git diff-tree --name-status -z` output.
pub fn parse_name_status(text: &str) -> Result<Vec<FileChange>, GitError> {
    let mut files = Vec::new();
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    while let Some(code) = tokens.next() {
        let letter = code.chars().next().unwrap_or('?');
        let status = match letter {
            'A' => FileStatus::Added,
            'M' => FileStatus::Modified,
            'D' => FileStatus::Deleted,
            'R' => FileStatus::Renamed,
            'C' => FileStatus::Copied,
            'T' => FileStatus::TypeChanged,
            'U' => FileStatus::Conflicted,
            _ => return Err(GitError::Parse(format!("name-status code: {code:?}"))),
        };
        let first = tokens
            .next()
            .ok_or_else(|| GitError::Parse("name-status: missing path".into()))?;
        let (path, old_path) = if matches!(letter, 'R' | 'C') {
            let new = tokens
                .next()
                .ok_or_else(|| GitError::Parse("name-status: missing new path".into()))?;
            (new, Some(first.to_string()))
        } else {
            (first, None)
        };
        files.push(FileChange {
            path: path.to_string(),
            old_path,
            status,
            additions: None,
            deletions: None,
            binary: false,
        });
    }
    Ok(files)
}

/// First parent of `oid`, or the empty tree for a root commit.
fn first_parent_or_empty(git: &Git, repo: &RepoInfo, oid: &str) -> Result<String, GitError> {
    check_name("commit", oid)?;
    let rev = format!("{oid}^");
    let mut args = vec!["rev-parse", "-q", "--verify"];
    args.extend(git.end_of_options());
    args.push(&rev);
    let out = git.run_unchecked(repo_path(repo), Some(&repo.id), &args, false, None)?;
    let p = out.stdout.trim();
    Ok(if out.code == 0 && !p.is_empty() {
        p.to_string()
    } else {
        EMPTY_TREE.to_string()
    })
}

/// Raw unified diff bytes of one file (also used by the hunk operations, which need the exact
/// bytes). For an untracked file the diff is against `/dev/null`. `for_patch` turns textconv off
/// so the hunks are those of the real file content.
pub(crate) fn raw_file_diff(
    git: &Git,
    repo: &RepoInfo,
    spec: &DiffSpec,
    path: &str,
    old_path: Option<&str>,
    context: u32,
    for_patch: bool,
) -> Result<Vec<u8>, GitError> {
    let rp = repo_path(repo);
    let unified = format!("-U{context}");
    // Fixed prefixes and no colour / external tools whatever the user configured, so the text
    // parses and applies the same on every machine.
    let mut args: Vec<&str> = vec![
        "--literal-pathspecs",
        "diff",
        &unified,
        "--no-color",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-M",
    ];
    if for_patch || !matches!(spec, DiffSpec::Commit { .. }) {
        args.push("--no-textconv");
    }
    let old = old_path.filter(|o| *o != path);
    let (parent, commit_oid);
    match spec {
        DiffSpec::Commit { oid, parent: p } => {
            check_name("commit", oid)?;
            parent = match p {
                Some(p) => {
                    check_name("parent commit", p)?;
                    p.clone()
                }
                None => first_parent_or_empty(git, repo, oid)?,
            };
            commit_oid = oid.clone();
            args.extend(git.end_of_options());
            args.push(&parent);
            args.push(&commit_oid);
        }
        DiffSpec::Staged => args.push("--cached"),
        DiffSpec::Unstaged => {}
    }
    args.push("--");
    if !matches!(spec, DiffSpec::Unstaged) {
        if let Some(o) = old {
            args.push(o);
        }
    }
    args.push(path);
    let out = git.run_raw(rp, Some(&repo.id), &args, false, &[])?;
    if !out.stdout.is_empty() || !matches!(spec, DiffSpec::Unstaged) {
        return Ok(out.stdout);
    }

    // Empty unstaged diff: the file may be untracked, which `git diff` ignores.
    let untracked = git.run(
        rp,
        Some(&repo.id),
        &[
            "--literal-pathspecs",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            path,
        ],
        false,
    )?;
    if untracked.stdout.is_empty() {
        return Ok(out.stdout);
    }
    let out = git.run_raw(
        rp,
        Some(&repo.id),
        &[
            "diff",
            "--no-index",
            &unified,
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--",
            "/dev/null",
            path,
        ],
        false,
        &[1],
    )?;
    Ok(out.stdout)
}

/// Diff of one file for a commit, the index or the worktree.
pub fn file_diff(
    git: &Git,
    repo: &RepoInfo,
    spec: &DiffSpec,
    path: &str,
    old_path: Option<&str>,
    context: u32,
) -> Result<FileDiff, GitError> {
    let text = String::from_utf8_lossy(&raw_file_diff(
        git, repo, spec, path, old_path, context, false,
    )?)
    .into_owned();
    if text.bytes().filter(|b| *b == b'\n').count() > MAX_DIFF_LINES {
        return Ok(FileDiff {
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
            binary: false,
            hunks: Vec::new(),
            too_large: true,
        });
    }
    parse_unified(&text, path, old_path)
}

/// Content of `path` at `rev` (`git show rev:path`) or from the worktree when `rev` is `None`.
/// Capped at 2 MiB. In the worktree a symlink yields its target (as git stores it) and anything
/// that is not a regular file, or sits behind a symlinked directory, is refused.
pub fn file_content(
    git: &Git,
    repo: &RepoInfo,
    rev: Option<&str>,
    path: &str,
) -> Result<String, GitError> {
    match rev {
        Some(rev) => {
            check_name("revision", rev)?;
            let spec = format!("{rev}:{path}");
            let out = git.run(repo_path(repo), Some(&repo.id), &["show", &spec], false)?;
            Ok(cap_content(out.stdout.into_bytes()))
        }
        None => {
            let rel = Path::new(path);
            if rel
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
            {
                return Err(GitError::Invalid(format!("path outside the repo: {path}")));
            }
            let full = repo_path(repo).join(rel);
            // The directory that holds the file must really be inside the repo (no symlinked
            // directory leading out of it).
            let root = std::fs::canonicalize(repo_path(repo))?;
            let parent = full
                .parent()
                .map(std::fs::canonicalize)
                .transpose()?
                .unwrap_or_else(|| root.clone());
            if !parent.starts_with(&root) {
                return Err(GitError::Invalid(format!("path outside the repo: {path}")));
            }
            let kind = std::fs::symlink_metadata(&full)?.file_type();
            if kind.is_symlink() {
                let target = std::fs::read_link(&full)?;
                return Ok(cap_content(
                    target.to_string_lossy().into_owned().into_bytes(),
                ));
            }
            if !kind.is_file() {
                return Err(GitError::Invalid(format!("not a regular file: {path}")));
            }
            let file = std::fs::File::open(&full)?;
            let mut buf = Vec::new();
            file.take(MAX_CONTENT_BYTES as u64).read_to_end(&mut buf)?;
            Ok(cap_content(buf))
        }
    }
}

fn cap_content(mut bytes: Vec<u8>) -> String {
    bytes.truncate(MAX_CONTENT_BYTES);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Full message of HEAD, or an empty string in an empty repo.
pub fn last_commit_message(git: &Git, repo: &RepoInfo) -> Result<String, GitError> {
    let out = git.run_unchecked(
        repo_path(repo),
        Some(&repo.id),
        &["log", "-1", "--format=%B"],
        false,
        None,
    )?;
    Ok(if out.code == 0 {
        out.stdout.trim_end().to_string()
    } else {
        String::new()
    })
}

/// A parsed diff for display.
pub(crate) struct ParsedDiff {
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

struct Open {
    hunk: Hunk,
    old_rem: i64,
    new_rem: i64,
    old_no: u32,
    new_no: u32,
}

impl Open {
    fn done(&self) -> bool {
        self.old_rem <= 0 && self.new_rem <= 0
    }
}

/// Parses the unified diff of a single file.
pub fn parse_unified(text: &str, path: &str, old_path: Option<&str>) -> Result<FileDiff, GitError> {
    let p = parse_raw(text)?;
    Ok(FileDiff {
        path: path.to_string(),
        old_path: old_path.map(str::to_string),
        binary: p.binary,
        hunks: p.hunks,
        too_large: false,
    })
}

pub(crate) fn parse_raw(text: &str) -> Result<ParsedDiff, GitError> {
    let mut parsed = ParsedDiff {
        binary: false,
        hunks: Vec::new(),
    };
    let mut cur: Option<Open> = None;

    fn close(parsed: &mut ParsedDiff, cur: &mut Option<Open>) {
        if let Some(o) = cur.take() {
            parsed.hunks.push(o.hunk);
        }
    }

    for raw_line in text.split_inclusive('\n') {
        let line = raw_line.strip_suffix('\n').unwrap_or(raw_line);

        if let Some(o) = cur.as_mut() {
            if !o.done() {
                let (kind, body) = match line.chars().next() {
                    Some(' ') => (Some(LineKind::Context), &line[1..]),
                    Some('+') => (Some(LineKind::Add), &line[1..]),
                    Some('-') => (Some(LineKind::Del), &line[1..]),
                    // Some tools strip the single space of an empty context line.
                    None => (Some(LineKind::Context), ""),
                    Some('\\') => (None, ""),
                    Some(_) => {
                        return Err(GitError::Parse(format!("unexpected diff line: {line:?}")))
                    }
                };
                let Some(kind) = kind else { continue };
                let (old_no, new_no) = match kind {
                    LineKind::Context => {
                        o.old_rem -= 1;
                        o.new_rem -= 1;
                        (Some(o.old_no), Some(o.new_no))
                    }
                    LineKind::Del => {
                        o.old_rem -= 1;
                        (Some(o.old_no), None)
                    }
                    LineKind::Add => {
                        o.new_rem -= 1;
                        (None, Some(o.new_no))
                    }
                };
                if old_no.is_some() {
                    o.old_no += 1;
                }
                if new_no.is_some() {
                    o.new_no += 1;
                }
                o.hunk.lines.push(DiffLine {
                    kind,
                    old_no,
                    new_no,
                    text: body.to_string(),
                });
                continue;
            }
            // Hunk body complete: only a "\ No newline at end of file" marker may follow.
            if line.starts_with('\\') {
                continue;
            }
        }

        if line.starts_with("@@ ") {
            close(&mut parsed, &mut cur);
            cur = Some(parse_hunk_header(line)?);
        } else if line.starts_with("diff --git ") && !parsed.hunks.is_empty() {
            break;
        } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            parsed.binary = true;
        }
    }
    close(&mut parsed, &mut cur);
    Ok(parsed)
}

/// `@@ -a[,b] +c[,d] @@ header`
fn parse_hunk_header(line: &str) -> Result<Open, GitError> {
    let bad = || GitError::Parse(format!("hunk header: {line:?}"));
    let rest = line.strip_prefix("@@ -").ok_or_else(bad)?;
    let (ranges, header) = rest.split_once(" @@").ok_or_else(bad)?;
    let (old, new) = ranges.split_once(" +").ok_or_else(bad)?;
    let range = |s: &str| -> Result<(u32, u32), GitError> {
        match s.split_once(',') {
            Some((a, b)) => Ok((a.parse().map_err(|_| bad())?, b.parse().map_err(|_| bad())?)),
            None => Ok((s.parse().map_err(|_| bad())?, 1)),
        }
    };
    let (old_start, old_lines) = range(old)?;
    let (new_start, new_lines) = range(new)?;
    Ok(Open {
        hunk: Hunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            header: header.trim().to_string(),
            lines: Vec::new(),
        },
        old_rem: i64::from(old_lines),
        new_rem: i64::from(new_lines),
        old_no: old_start,
        new_no: new_start,
    })
}

/// One file's diff cut into its header lines and its hunks, as raw bytes so a patch built from
/// them is byte-identical to what git printed (file content need not be UTF-8).
pub(crate) struct RawPatch {
    /// Lines before the first hunk (`diff --git`, `index`, `---`, `+++`, mode lines...).
    pub header: Vec<u8>,
    pub hunks: Vec<RawHunk>,
}

pub(crate) struct RawHunk {
    pub id: HunkRef,
    /// The `@@` line, the body and any `\ No newline` marker.
    pub bytes: Vec<u8>,
}

impl RawHunk {
    /// `hunk_hash` of the hunk as the UI displays it (the display parser, lossy UTF-8).
    pub fn display_hash(&self) -> String {
        match parse_raw(&String::from_utf8_lossy(&self.bytes)) {
            Ok(p) if p.hunks.len() == 1 => hunk_hash(&p.hunks[0]),
            _ => String::new(),
        }
    }
}

/// Parses `@@ -a[,b] +c[,d] @@` from the start of a hunk header line.
fn hunk_ref_of(line: &[u8]) -> Option<HunkRef> {
    let end = line
        .windows(3)
        .skip(3)
        .position(|w| w == b" @@")
        .map(|i| i + 3)?;
    let text = std::str::from_utf8(&line[..end]).ok()?;
    let h = parse_hunk_header(&format!("{text} @@")).ok()?.hunk;
    // Only the header numbers; the body hash is `RawHunk::display_hash`.
    Some(HunkRef {
        old_start: h.old_start,
        old_lines: h.old_lines,
        new_start: h.new_start,
        new_lines: h.new_lines,
        hash: None,
    })
}

pub(crate) fn split_patch(bytes: &[u8]) -> Result<RawPatch, GitError> {
    let mut header = Vec::new();
    let mut hunks: Vec<RawHunk> = Vec::new();
    // (old, new) lines still expected in the open hunk.
    let mut remaining: Option<(i64, i64)> = None;
    for raw_line in bytes.split_inclusive(|b| *b == b'\n') {
        let line = raw_line.strip_suffix(b"\n").unwrap_or(raw_line);
        if let (Some((old, new)), Some(h)) = (remaining.as_mut(), hunks.last_mut()) {
            if *old > 0 || *new > 0 {
                match line.first() {
                    Some(b' ') | None => {
                        *old -= 1;
                        *new -= 1;
                    }
                    Some(b'-') => *old -= 1,
                    Some(b'+') => *new -= 1,
                    Some(b'\\') => {}
                    Some(_) => {
                        return Err(GitError::Parse(format!(
                            "unexpected diff line: {:?}",
                            String::from_utf8_lossy(line)
                        )))
                    }
                }
                h.bytes.extend_from_slice(raw_line);
                if !raw_line.ends_with(b"\n") {
                    h.bytes.push(b'\n');
                }
                continue;
            }
            if line.first() == Some(&b'\\') {
                h.bytes.extend_from_slice(raw_line);
                if !raw_line.ends_with(b"\n") {
                    h.bytes.push(b'\n');
                }
                continue;
            }
        }
        if line.starts_with(b"@@ ") {
            let id = hunk_ref_of(line).ok_or_else(|| {
                GitError::Parse(format!("hunk header: {:?}", String::from_utf8_lossy(line)))
            })?;
            remaining = Some((i64::from(id.old_lines), i64::from(id.new_lines)));
            let mut b = raw_line.to_vec();
            if !raw_line.ends_with(b"\n") {
                b.push(b'\n');
            }
            hunks.push(RawHunk { id, bytes: b });
        } else if line.starts_with(b"diff --git ") && !hunks.is_empty() {
            break;
        } else if hunks.is_empty() {
            header.extend_from_slice(raw_line);
            if !raw_line.ends_with(b"\n") {
                header.push(b'\n');
            }
        }
    }
    Ok(RawPatch { header, hunks })
}
