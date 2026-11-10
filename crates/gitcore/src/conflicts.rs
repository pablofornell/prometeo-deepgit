//! Merge conflicts (PLAN.md section 5.8): the list of unmerged files, the three versions of one
//! file, accepting one side, and saving a resolution made by hand.
//!
//! A file is unmerged when the index holds stages 1 (base), 2 and 3 for it
//! (`git ls-files --unmerged`). Git calls stage 2 "ours" and stage 3 "theirs". Everything that
//! faces the user says "Yours" / "Theirs", and **during a rebase the two swap**: git replays your
//! commit on top of the upstream, so stage 2 is the upstream and stage 3 is your commit. The one
//! place that knows this is `side_stages`; every public function maps through it, so `ours` in
//! this module's API is always the user's side.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Write;
use std::path::Path;

use crate::error::{check_name, GitError};
use crate::model::*;
use crate::ops::{check_rel, stage, with_paths};
use crate::runner::Git;
use crate::state;

/// Largest version the editor loads; bigger files only get Accept Yours / Theirs.
pub const MAX_BLOB_BYTES: u64 = 2 * 1024 * 1024;

const REGULAR_MODES: [&str; 2] = ["100644", "100755"];

fn repo_path(repo: &RepoInfo) -> &Path {
    Path::new(&repo.path)
}

// ---------------------------------------------------------------- stages and the rebase swap

/// Which git stages are the user's side and the other side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SideStages {
    /// Stage number (2 or 3) of the user's side.
    pub yours: usize,
    /// Stage number (2 or 3) of the other side.
    pub theirs: usize,
    pub swapped: bool,
}

/// THE place of the rebase swap. Merge, cherry-pick, revert (and `git am`): yours = stage 2,
/// theirs = stage 3. Rebase: yours = stage 3 (your commit being replayed), theirs = stage 2 (the
/// upstream). `git am` also uses `rebase-apply/`, but it marks itself with `applying`.
pub(crate) fn side_stages(repo: &Path) -> Result<SideStages, GitError> {
    let dir = state::git_dir(repo)?;
    let rebasing = state::detect(&dir) == RepoStateKind::Rebasing
        && !dir.join("rebase-apply").join("applying").exists();
    Ok(if rebasing {
        SideStages {
            yours: 3,
            theirs: 2,
            swapped: true,
        }
    } else {
        SideStages {
            yours: 2,
            theirs: 3,
            swapped: false,
        }
    })
}

// ---------------------------------------------------------------- ls-files --unmerged

#[derive(Clone, Debug)]
struct StageEntry {
    mode: String,
    oid: String,
}

/// The stages of one unmerged path; index 0 is stage 1.
#[derive(Clone, Debug)]
struct Unmerged {
    path: String,
    stages: [Option<StageEntry>; 3],
}

impl Unmerged {
    fn stage(&self, n: usize) -> Option<&StageEntry> {
        self.stages[n - 1].as_ref()
    }

    fn present(&self) -> impl Iterator<Item = &StageEntry> {
        self.stages.iter().flatten()
    }

    fn regular(&self) -> bool {
        self.present()
            .all(|e| REGULAR_MODES.contains(&e.mode.as_str()))
    }
}

/// `git ls-files --unmerged -z`, grouped by path and sorted. `paths` limits it (literal pathspecs;
/// a folder name matches the files below it).
fn list_unmerged(
    git: &Git,
    repo: &RepoInfo,
    paths: Option<&[String]>,
) -> Result<Vec<Unmerged>, GitError> {
    let head = ["ls-files", "--unmerged", "-z"];
    let out = match paths {
        Some(p) => git.run(
            repo_path(repo),
            Some(&repo.id),
            &with_paths(&head, p),
            false,
        )?,
        None => git.run(repo_path(repo), Some(&repo.id), &head, false)?,
    };
    let mut by_path: BTreeMap<String, Unmerged> = BTreeMap::new();
    for rec in out.stdout.split('\0').filter(|s| !s.is_empty()) {
        let bad = || GitError::Parse(format!("ls-files --unmerged entry: {rec:?}"));
        // "<mode> <oid> <stage>\t<path>"
        let (meta, path) = rec.split_once('\t').ok_or_else(bad)?;
        let mut f = meta.split(' ');
        let (mode, oid, stage) = (f.next(), f.next(), f.next());
        let (Some(mode), Some(oid), Some(stage)) = (mode, oid, stage) else {
            return Err(bad());
        };
        let n: usize = stage.parse().map_err(|_| bad())?;
        if !(1..=3).contains(&n) {
            return Err(bad());
        }
        by_path
            .entry(path.to_string())
            .or_insert_with(|| Unmerged {
                path: path.to_string(),
                stages: [None, None, None],
            })
            .stages[n - 1] = Some(StageEntry {
            mode: mode.to_string(),
            oid: oid.to_string(),
        });
    }
    Ok(by_path.into_values().collect())
}

/// The unmerged entry of exactly `path`, or an error when it is not (or no longer) in conflict.
fn unmerged_one(git: &Git, repo: &RepoInfo, path: &str) -> Result<Unmerged, GitError> {
    list_unmerged(git, repo, Some(&[path.to_string()]))?
        .into_iter()
        .find(|u| u.path == path)
        .ok_or_else(|| GitError::Invalid(format!("{path} is no longer in conflict.")))
}

fn side_status(present: bool, base: bool) -> SideStatus {
    match (present, base) {
        (true, true) => SideStatus::Modified,
        (true, false) => SideStatus::Added,
        (false, true) => SideStatus::Deleted,
        (false, false) => SideStatus::Missing,
    }
}

fn check_path(path: &str) -> Result<(), GitError> {
    if path.is_empty() {
        return Err(GitError::Invalid("empty path".into()));
    }
    check_name("path", path)?;
    check_rel(path)
}

// ---------------------------------------------------------------- blobs

/// A blob as read by `git cat-file`: the size, and the bytes unless it is over the cap.
struct BlobData {
    size: u64,
    bytes: Option<Vec<u8>>,
}

/// Reads the given blobs with two `cat-file` calls (`--batch-check` for the sizes, `--batch` for
/// the contents that are not over the cap). The input is object ids that git itself listed.
fn read_blobs(
    git: &Git,
    repo: &RepoInfo,
    oids: &BTreeSet<&str>,
) -> Result<HashMap<String, BlobData>, GitError> {
    let mut out = HashMap::new();
    if oids.is_empty() {
        return Ok(out);
    }
    let input: String = oids.iter().map(|o| format!("{o}\n")).collect();
    let sizes = git.run_unchecked_raw(
        repo_path(repo),
        Some(&repo.id),
        &["cat-file", "--batch-check"],
        false,
        Some(input.as_bytes()),
    )?;
    let sizes = String::from_utf8_lossy(&sizes.stdout).into_owned();
    let mut wanted = String::new();
    for line in sizes.lines() {
        let f: Vec<&str> = line.split(' ').collect();
        if f.len() != 3 {
            continue; // "<oid> missing"
        }
        let size: u64 = f[2].parse().unwrap_or(0);
        if size <= MAX_BLOB_BYTES {
            wanted.push_str(f[0]);
            wanted.push('\n');
        }
        out.insert(f[0].to_string(), BlobData { size, bytes: None });
    }
    if wanted.is_empty() {
        return Ok(out);
    }
    let raw = git
        .run_unchecked_raw(
            repo_path(repo),
            Some(&repo.id),
            &["cat-file", "--batch"],
            false,
            Some(wanted.as_bytes()),
        )?
        .stdout;
    // "<oid> <type> <size>\n<size bytes>\n" per object.
    let mut pos = 0;
    while pos < raw.len() {
        let Some(nl) = raw[pos..].iter().position(|b| *b == b'\n') else {
            break;
        };
        let header = String::from_utf8_lossy(&raw[pos..pos + nl]).into_owned();
        pos += nl + 1;
        let f: Vec<&str> = header.split(' ').collect();
        if f.len() != 3 {
            continue;
        }
        let size: usize = f[2]
            .parse()
            .map_err(|_| GitError::Parse(format!("cat-file header: {header:?}")))?;
        let Some(body) = raw.get(pos..pos + size) else {
            return Err(GitError::Parse("cat-file output was cut short".into()));
        };
        if let Some(d) = out.get_mut(f[0]) {
            d.bytes = Some(body.to_vec());
        }
        pos += size + 1;
    }
    Ok(out)
}

/// The text of a version: only valid UTF-8 without NUL bytes.
fn as_text(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes.to_vec()).ok()
}

fn blob_of(e: &StageEntry, data: Option<&BlobData>) -> Blob {
    let regular = REGULAR_MODES.contains(&e.mode.as_str());
    let text = data
        .filter(|_| regular)
        .and_then(|d| d.bytes.as_deref())
        .and_then(as_text);
    Blob {
        oid: e.oid.clone(),
        bytes_len: data.map_or(0, |d| d.size),
        binary: text.is_none(),
        text,
    }
}

fn oids_of(list: &[Unmerged]) -> BTreeSet<&str> {
    list.iter()
        .flat_map(|u| u.present())
        .map(|e| e.oid.as_str())
        .collect()
}

// ---------------------------------------------------------------- the conflict list

/// Every unmerged file of the repo. `ours` / `theirs` are the user's view (swapped during a
/// rebase). `binary` is true when any version cannot be edited as text.
pub fn conflicts(git: &Git, repo: &RepoInfo) -> Result<Vec<ConflictEntry>, GitError> {
    let list = list_unmerged(git, repo, None)?;
    if list.is_empty() {
        return Ok(Vec::new());
    }
    let st = side_stages(repo_path(repo))?;
    let blobs = read_blobs(git, repo, &oids_of(&list))?;
    Ok(list
        .iter()
        .map(|u| {
            let base = u.stage(1).is_some();
            let yours = side_status(u.stage(st.yours).is_some(), base);
            let theirs = side_status(u.stage(st.theirs).is_some(), base);
            let binary = !u.regular() || u.present().any(|e| blob_of(e, blobs.get(&e.oid)).binary);
            ConflictEntry {
                path: u.path.clone(),
                old_path: None,
                ours: yours,
                theirs,
                binary,
            }
        })
        .collect())
}

// ---------------------------------------------------------------- the three versions

/// Base, yours and theirs of `path`, with labels, the swap flag and the file's line ending.
pub fn conflict_versions(
    git: &Git,
    repo: &RepoInfo,
    path: &str,
) -> Result<ConflictVersions, GitError> {
    check_path(path)?;
    let u = unmerged_one(git, repo, path)?;
    let st = side_stages(repo_path(repo))?;
    let blobs = read_blobs(git, repo, &oids_of(std::slice::from_ref(&u)))?;
    let blob = |n: usize| u.stage(n).map(|e| blob_of(e, blobs.get(&e.oid)));
    let (base, ours, theirs) = (blob(1), blob(st.yours), blob(st.theirs));
    let eol = detect_eol(repo, path, &u, &st, &blobs);
    Ok(ConflictVersions {
        base,
        ours,
        theirs,
        labels: labels(git, repo, st),
        swapped: st.swapped,
        eol,
    })
}

/// Line ending of the worktree file, else of the first version that has lines (yours, theirs,
/// base).
fn detect_eol(
    repo: &RepoInfo,
    path: &str,
    u: &Unmerged,
    st: &SideStages,
    blobs: &HashMap<String, BlobData>,
) -> Eol {
    if let Some(e) = worktree_bytes(repo, path).and_then(|b| eol_of(&b)) {
        return e;
    }
    [st.yours, st.theirs, 1]
        .into_iter()
        .filter_map(|n| u.stage(n))
        .filter_map(|e| blobs.get(&e.oid)?.bytes.as_deref())
        .find_map(eol_of)
        .unwrap_or(Eol::Lf)
}

/// The bytes of the regular worktree file (not a symlink, at most the cap), if there is one.
fn worktree_bytes(repo: &RepoInfo, path: &str) -> Option<Vec<u8>> {
    let full = repo_path(repo).join(path);
    let meta = std::fs::symlink_metadata(&full).ok()?;
    if !meta.is_file() || meta.len() > MAX_BLOB_BYTES {
        return None;
    }
    std::fs::read(full).ok()
}

/// `Crlf` when more lines end in CRLF than in a bare LF; `None` without any line ending.
fn eol_of(bytes: &[u8]) -> Option<Eol> {
    let (mut crlf, mut lf) = (0usize, 0usize);
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    match (crlf, lf) {
        (0, 0) => None,
        (c, l) if c > l => Some(Eol::Crlf),
        _ => Some(Eol::Lf),
    }
}

// ---------------------------------------------------------------- labels

fn is_oid(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// First line of a file in the git dir, trimmed.
fn first_line(dir: &Path, name: &str) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(name)).ok()?;
    let line = text.lines().next()?.trim().to_string();
    (!line.is_empty()).then_some(line)
}

/// "abc1234 subject" of a commit, or the short id when git cannot show it.
fn commit_label(git: &Git, repo: &RepoInfo, oid: &str) -> String {
    let short = oid.chars().take(7).collect::<String>();
    if !is_oid(oid) {
        return short;
    }
    let mut args = vec!["show", "-s", "--format=%h %s"];
    args.extend(git.end_of_options());
    args.push(oid);
    match git.run_unchecked(repo_path(repo), Some(&repo.id), &args, false, None) {
        Ok(o) if o.code == 0 && !o.stdout.trim().is_empty() => o.stdout.trim().to_string(),
        _ => short,
    }
}

/// A branch whose tip is `oid` (local ones first), if any.
fn branch_at(git: &Git, repo: &RepoInfo, oid: &str) -> Option<String> {
    if !is_oid(oid) {
        return None;
    }
    let points = format!("--points-at={oid}");
    let out = git
        .run_unchecked(
            repo_path(repo),
            Some(&repo.id),
            &[
                "for-each-ref",
                &points,
                "--format=%(refname:short)",
                "refs/heads",
                "refs/remotes",
            ],
            false,
            None,
        )
        .ok()
        .filter(|o| o.code == 0)?;
    out.stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.ends_with("/HEAD"))
        .map(str::to_string)
}

/// A branch name when one points at `oid`, else "abc1234 subject".
fn ref_or_commit(git: &Git, repo: &RepoInfo, oid: &str) -> String {
    branch_at(git, repo, oid).unwrap_or_else(|| commit_label(git, repo, oid))
}

/// The checked-out branch, or "HEAD abc1234" when detached.
fn head_label(git: &Git, repo: &RepoInfo) -> String {
    let run = |args: &[&str]| {
        git.run_unchecked(repo_path(repo), Some(&repo.id), args, false, None)
            .ok()
            .filter(|o| o.code == 0)
            .map(|o| o.stdout.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    run(&["symbolic-ref", "-q", "--short", "HEAD"])
        .or_else(|| run(&["rev-parse", "--short", "HEAD"]).map(|s| format!("HEAD {s}")))
        .unwrap_or_else(|| "HEAD".to_string())
}

/// Branch / commit names for the headers of the merge window. Best effort: a label that cannot
/// be read falls back to a generic word.
fn labels(git: &Git, repo: &RepoInfo, st: SideStages) -> ConflictLabels {
    let base = "Base".to_string();
    let Ok(dir) = state::git_dir(repo_path(repo)) else {
        return ConflictLabels {
            ours: "Yours".into(),
            theirs: "Theirs".into(),
            base,
        };
    };
    if st.swapped {
        // Rebase: yours is the commit being replayed, theirs is what it is replayed onto.
        let backend = if dir.join("rebase-merge").exists() {
            "rebase-merge"
        } else {
            "rebase-apply"
        };
        let in_backend = |name: &str| first_line(&dir.join(backend), name);
        let branch = in_backend("head-name")
            .map(|h| h.strip_prefix("refs/heads/").unwrap_or(&h).to_string())
            .unwrap_or_else(|| "Yours".to_string());
        let replayed = first_line(&dir, "REBASE_HEAD")
            .or_else(|| in_backend("stopped-sha"))
            .or_else(|| in_backend("original-commit"))
            .filter(|o| is_oid(o) || o.len() >= 7);
        let ours = match replayed {
            Some(oid) => format!("{branch} ({})", commit_label(git, repo, &oid)),
            None => branch,
        };
        let theirs = in_backend("onto")
            .map(|oid| ref_or_commit(git, repo, &oid))
            .unwrap_or_else(|| "Theirs".to_string());
        return ConflictLabels { ours, theirs, base };
    }
    let ours = head_label(git, repo);
    let theirs = if let Some(oid) = first_line(&dir, "MERGE_HEAD") {
        ref_or_commit(git, repo, &oid)
    } else if let Some(oid) = first_line(&dir, "CHERRY_PICK_HEAD") {
        commit_label(git, repo, &oid)
    } else if let Some(oid) = first_line(&dir, "REVERT_HEAD") {
        commit_label(git, repo, &oid)
    } else {
        "Theirs".to_string()
    };
    ConflictLabels { ours, theirs, base }
}

// ---------------------------------------------------------------- accept one side

/// Keeps one whole side of each path (Accept Yours / Accept Theirs). A side that has the file:
/// `git checkout --ours|--theirs -- path`, then `git add -- path`. A side that deleted it:
/// `git rm -- path`. `side` is the user's view; the rebase swap is applied here.
pub fn accept_side(
    git: &Git,
    repo: &RepoInfo,
    paths: &[String],
    side: ConflictSide,
) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    for p in paths {
        check_path(p)?;
    }
    let listed = list_unmerged(git, repo, Some(paths))?;
    let st = side_stages(repo_path(repo))?;
    let stage_no = match side {
        ConflictSide::Ours => st.yours,
        ConflictSide::Theirs => st.theirs,
    };
    let (mut keep, mut remove) = (Vec::new(), Vec::new());
    for p in paths {
        let u = listed
            .iter()
            .find(|u| &u.path == p)
            .ok_or_else(|| GitError::Invalid(format!("{p} is no longer in conflict.")))?;
        if u.stage(stage_no).is_some() {
            keep.push(p.clone());
        } else {
            remove.push(p.clone());
        }
    }
    let rp = repo_path(repo);
    if !keep.is_empty() {
        // Git's own flag: --ours is stage 2, --theirs is stage 3.
        let flag = if stage_no == 2 { "--ours" } else { "--theirs" };
        git.run(
            rp,
            Some(&repo.id),
            &with_paths(&["checkout", flag], &keep),
            true,
        )?;
        stage(git, repo, &keep)?;
    }
    if !remove.is_empty() {
        git.run(
            rp,
            Some(&repo.id),
            &with_paths(&["rm", "-q"], &remove),
            true,
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------- save a hand-made resolution

/// Writes `content` (UTF-8, LF line ends) as the file, in the file's own line ending and with its
/// file mode, and with `resolved` stages it (`git add`). Without `resolved` the file is only
/// written (it still holds conflict markers) and stays unmerged.
///
/// Refused when the file is no longer conflicted, when `expected_ours_oid` (the user's version
/// the editor loaded) is not the current one, when any version is binary or not UTF-8, or when
/// the file is a symlink or submodule.
pub fn save_resolution(
    git: &Git,
    repo: &RepoInfo,
    path: &str,
    content: &str,
    expected_ours_oid: Option<&str>,
    resolved: bool,
) -> Result<(), GitError> {
    check_path(path)?;
    if content.contains('\0') {
        return Err(GitError::Invalid("The result contains a NUL byte.".into()));
    }
    let u = unmerged_one(git, repo, path)?;
    let st = side_stages(repo_path(repo))?;
    if !u.regular() {
        return Err(GitError::Invalid(format!(
            "{path} is a symlink or a submodule: accept Yours or Theirs instead."
        )));
    }
    if let Some(want) = expected_ours_oid {
        if u.stage(st.yours).map(|e| e.oid.as_str()) != Some(want) {
            return Err(GitError::Invalid(
                "The conflict changed. Reload the merge.".into(),
            ));
        }
    }
    let blobs = read_blobs(git, repo, &oids_of(std::slice::from_ref(&u)))?;
    if u.present().any(|e| blob_of(e, blobs.get(&e.oid)).binary) {
        return Err(GitError::Invalid(format!(
            "{path} is binary, not UTF-8 or too large: accept Yours or Theirs instead."
        )));
    }
    let eol = detect_eol(repo, path, &u, &st, &blobs);
    let bytes = match eol {
        Eol::Lf => content.as_bytes().to_vec(),
        Eol::Crlf => content
            .replace("\r\n", "\n")
            .replace('\n', "\r\n")
            .into_bytes(),
    };
    let executable = u.present().any(|e| e.mode == "100755");
    write_worktree_file(repo_path(repo), path, &bytes, executable)?;
    if resolved {
        stage(git, repo, &[path.to_string()])?;
    }
    Ok(())
}

/// Writes a regular file inside the repo. An existing file keeps its mode (it is rewritten in
/// place); a new one gets the exec bit when the index entry had it. Never writes through a
/// symlink, and never outside the repo.
fn write_worktree_file(
    root: &Path,
    rel: &str,
    bytes: &[u8],
    executable: bool,
) -> Result<(), GitError> {
    let outside = || GitError::Invalid(format!("path outside the repo: {rel}"));
    let canonical_root = std::fs::canonicalize(root)?;
    let full = root.join(rel);
    let mut ancestor = full.parent();
    while let Some(a) = ancestor {
        if a.exists() {
            break;
        }
        ancestor = a.parent();
    }
    let ancestor = ancestor.ok_or_else(outside)?;
    if !std::fs::canonicalize(ancestor)?.starts_with(&canonical_root) {
        return Err(outside());
    }
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existed = match std::fs::symlink_metadata(&full) {
        Ok(m) if m.file_type().is_symlink() => {
            return Err(GitError::Invalid(format!("{rel} is a symlink.")))
        }
        Ok(m) if m.is_dir() => return Err(GitError::Invalid(format!("{rel} is a folder."))),
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&full)?;
    file.write_all(bytes)?;
    file.flush()?;
    #[cfg(unix)]
    if !existed && executable {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = file.metadata()?.permissions();
        perm.set_mode(perm.mode() | 0o111);
        file.set_permissions(perm)?;
    }
    #[cfg(not(unix))]
    let _ = (existed, executable);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_ending_is_the_majority() {
        assert_eq!(eol_of(b"a\r\nb\r\n"), Some(Eol::Crlf));
        assert_eq!(eol_of(b"a\nb\n"), Some(Eol::Lf));
        assert_eq!(eol_of(b"a\r\nb\nc\n"), Some(Eol::Lf));
        assert_eq!(eol_of(b"no newline"), None);
    }

    #[test]
    fn only_clean_utf8_is_text() {
        assert_eq!(
            as_text("h\u{e9}llo".as_bytes()).as_deref(),
            Some("h\u{e9}llo")
        );
        assert!(as_text(b"a\0b").is_none());
        assert!(as_text(&[0x68, 0xe9, 0x6c]).is_none());
    }

    #[test]
    fn sides_swap_only_in_a_rebase() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        std::fs::create_dir(&git_dir).unwrap();
        let st = side_stages(dir.path()).unwrap();
        assert_eq!((st.yours, st.theirs, st.swapped), (2, 3, false));
        std::fs::write(git_dir.join("MERGE_HEAD"), "x\n").unwrap();
        assert!(!side_stages(dir.path()).unwrap().swapped);
        std::fs::remove_file(git_dir.join("MERGE_HEAD")).unwrap();
        std::fs::create_dir(git_dir.join("rebase-merge")).unwrap();
        let st = side_stages(dir.path()).unwrap();
        assert_eq!((st.yours, st.theirs, st.swapped), (3, 2, true));
        std::fs::remove_dir(git_dir.join("rebase-merge")).unwrap();
        // `git am` shares rebase-apply/ but is not a rebase.
        std::fs::create_dir_all(git_dir.join("rebase-apply")).unwrap();
        std::fs::write(git_dir.join("rebase-apply").join("applying"), "").unwrap();
        assert!(!side_stages(dir.path()).unwrap().swapped);
    }
}
