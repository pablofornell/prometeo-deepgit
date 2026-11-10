//! Merge conflicts (PLAN.md section 5.8): the list of unmerged files, the three versions of one
//! file, accepting one side, and saving a resolution made by hand.
//!
//! A file is unmerged when the index holds stages 1 (base), 2 and 3 for it
//! (`git ls-files --unmerged`). Git calls stage 2 "ours" and stage 3 "theirs". Everything that
//! faces the user says "Yours" / "Theirs", and **during a rebase the two swap**: git replays your
//! commit on top of the upstream, so stage 2 is the upstream and stage 3 is your commit. The one
//! place that knows this is `side_stages`; every public function maps through it, so `ours` in
//! this module's API is always the user's side.
//!
//! The swap is per file and only for conflicts that the rebase itself made: a cherry-pick or a
//! revert done while a rebase is stopped (`CHERRY_PICK_HEAD` / `REVERT_HEAD`) is not swapped, and
//! neither is a `git stash pop` there (it leaves no marker, so the stage-3 blob is compared with
//! the replayed commit's, see `rebase_owns`).

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::Write;
use std::path::Path;

use crate::error::GitError;
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

const STRAIGHT: SideStages = SideStages {
    yours: 2,
    theirs: 3,
    swapped: false,
};
const SWAPPED: SideStages = SideStages {
    yours: 3,
    theirs: 2,
    swapped: true,
};

/// THE place of the rebase swap. Merge, cherry-pick, revert, `stash pop` (and `git am`): yours =
/// stage 2, theirs = stage 3. A conflict made by a rebase: yours = stage 3 (your commit being
/// replayed), theirs = stage 2 (the upstream). `state::detect` says `Rebasing` only when no
/// `MERGE_HEAD`, `CHERRY_PICK_HEAD` or `REVERT_HEAD` is there, and `git am` marks itself with
/// `rebase-apply/applying`; the rest is `rebase_owns`.
fn side_stages(git: &Git, repo: &RepoInfo, u: &Unmerged) -> Result<SideStages, GitError> {
    let dir = state::git_dir(repo_path(repo))?;
    let rebasing = state::detect(&dir) == RepoStateKind::Rebasing
        && !dir.join("rebase-apply").join("applying").exists();
    Ok(if rebasing && rebase_owns(git, repo, &dir, u) {
        SWAPPED
    } else {
        STRAIGHT
    })
}

/// A rebase is stopped, but is this file's conflict the rebase's? A `git stash pop` made while it
/// is stopped leaves no marker. A rebase that stopped on a conflict has `REBASE_HEAD`, the commit
/// it is replaying; without it (a stop at `edit`, `break`, a reword) the rebase has no conflict of
/// its own, so whatever conflicts is not its. With it, stage 3 is the blob of that commit, so a
/// stage 3 that differs from `REBASE_HEAD:<path>` is not the rebase's. When the path is not in
/// that commit (a rename) the rebase owns it. A stash whose file is identical to the replayed
/// commit's looks like the rebase's.
fn rebase_owns(git: &Git, repo: &RepoInfo, dir: &Path, u: &Unmerged) -> bool {
    let Some(head) = first_line(dir, "REBASE_HEAD").filter(|h| is_oid(h)) else {
        return false;
    };
    let spec = format!("{head}:{}", u.path);
    let out = git.run_unchecked(
        repo_path(repo),
        Some(&repo.id),
        &["rev-parse", "--verify", "-q", &spec],
        false,
        None,
    );
    let in_commit = match out {
        Ok(o) if o.code == 0 => Some(o.stdout.trim().to_string()),
        _ => None,
    };
    match (in_commit, u.stage(3)) {
        (None, _) => true,
        (Some(c), Some(s3)) => c == s3.oid,
        (Some(_), None) => false,
    }
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

/// A path of the conflict list. Unlike a branch name it may start with `-` (every call here uses
/// `--literal-pathspecs` and `--`, and `--cacheinfo` takes one argument); `..`, absolute paths, NUL
/// and line breaks are refused.
fn check_path(path: &str) -> Result<(), GitError> {
    if path.is_empty() {
        return Err(GitError::Invalid("empty path".into()));
    }
    if path.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(GitError::Invalid(format!(
            "Invalid path {path:?}: it contains a control character."
        )));
    }
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
    let blobs = read_blobs(git, repo, &oids_of(&list))?;
    list.iter()
        .map(|u| {
            let st = side_stages(git, repo, u)?;
            let base = u.stage(1).is_some();
            let yours = side_status(u.stage(st.yours).is_some(), base);
            let theirs = side_status(u.stage(st.theirs).is_some(), base);
            let binary = !u.regular() || u.present().any(|e| blob_of(e, blobs.get(&e.oid)).binary);
            Ok(ConflictEntry {
                path: u.path.clone(),
                old_path: None,
                ours: yours,
                theirs,
                binary,
            })
        })
        .collect()
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
    let st = side_stages(git, repo, &u)?;
    let blobs = read_blobs(git, repo, &oids_of(std::slice::from_ref(&u)))?;
    let blob = |n: usize| u.stage(n).map(|e| blob_of(e, blobs.get(&e.oid)));
    let (base, ours, theirs) = (blob(1), blob(st.yours), blob(st.theirs));
    let eol = detect_eol(git, repo, path, &u, &st, &blobs);
    Ok(ConflictVersions {
        base,
        ours,
        theirs,
        labels: labels(git, repo, st),
        swapped: st.swapped,
        eol,
    })
}

/// Line ending of the worktree file. When the file is gone or has no line end: the ending git
/// would check the first version that has lines out with (yours, theirs, base). That is not
/// always the ending of the blob: with `core.autocrlf=true` (the default of Git for Windows) or an
/// `eol=crlf` attribute the repository holds LF and the worktree CRLF.
///
/// The checkout conversion is worked out from the attributes and the config (`checkout_eol`),
/// never by asking git to check the blob out: that runs the smudge filters (Git LFS downloads,
/// any command in the config) only to learn a line ending.
fn detect_eol(
    git: &Git,
    repo: &RepoInfo,
    path: &str,
    u: &Unmerged,
    st: &SideStages,
    blobs: &HashMap<String, BlobData>,
) -> Eol {
    if let Some(e) = worktree_bytes(repo, path).and_then(|b| eol_of(&b)) {
        return e;
    }
    let mut action = None;
    [st.yours, st.theirs, 1]
        .into_iter()
        .filter_map(|n| u.stage(n))
        .find_map(|e| {
            let stored = blobs.get(&e.oid)?.bytes.as_deref()?;
            let stored_eol = eol_of(stored)?;
            let action = *action.get_or_insert_with(|| crlf_action(git, repo, path));
            Some(if converts_to_crlf(stored, action) {
                Eol::Crlf
            } else {
                stored_eol
            })
        })
        .unwrap_or(Eol::Lf)
}

/// How git converts line endings when it checks a file out (git's `convert.c`, the part that
/// writes the worktree).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CrlfAction {
    /// No conversion (`-text`, `binary`, or no attribute and `core.autocrlf=false`).
    Binary,
    /// Text: every bare LF becomes CRLF.
    TextCrlf,
    /// Text checked out with LF: nothing changes.
    TextLf,
    /// `text=auto` / `core.autocrlf=true`: bare LFs become CRLF unless the blob already has a CR
    /// or looks binary.
    AutoCrlf,
    /// `text=auto` checked out with LF.
    AutoLf,
}

/// The value of one attribute from `git check-attr`: "set", "unset", "unspecified" or a value.
fn attr_value<'a>(attrs: &'a [(String, String)], name: &str) -> &'a str {
    attrs
        .iter()
        .find(|(n, _)| n == name)
        .map_or("unspecified", |(_, v)| v.as_str())
}

/// The checkout conversion of `path`, from its `text`, `crlf` (the old name) and `eol`
/// attributes, then `core.autocrlf` and `core.eol`. Reads attributes and config only.
fn crlf_action(git: &Git, repo: &RepoInfo, path: &str) -> CrlfAction {
    let attrs = git
        .run_unchecked_raw(
            repo_path(repo),
            Some(&repo.id),
            &["check-attr", "-z", "text", "crlf", "eol", "--", path],
            false,
            None,
        )
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| parse_check_attr(&o.stdout))
        .unwrap_or_default();
    let config = |key: &str| {
        git.run_unchecked(
            repo_path(repo),
            Some(&repo.id),
            &["config", "--get", key],
            false,
            None,
        )
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| o.stdout.trim().to_ascii_lowercase())
    };
    checkout_action(
        attr_value(&attrs, "text"),
        attr_value(&attrs, "crlf"),
        attr_value(&attrs, "eol"),
        config("core.autocrlf").as_deref(),
        config("core.eol").as_deref(),
        cfg!(windows),
    )
}

/// `git check-attr -z` output: `<path> NUL <attribute> NUL <value> NUL`, repeated.
fn parse_check_attr(out: &[u8]) -> Vec<(String, String)> {
    let fields: Vec<String> = out
        .split(|b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect();
    fields
        .as_chunks::<3>()
        .0
        .iter()
        .map(|[_, name, value]| (name.clone(), value.clone()))
        .collect()
}

/// The rule of git's `convert_attrs` and `output_eol`. `text` / `crlf` / `eol` are attribute
/// values as `check-attr` prints them, `autocrlf` / `core_eol` the config values (None: not set),
/// `native_crlf` whether this git's native line ending is CRLF (Git for Windows).
fn checkout_action(
    text: &str,
    crlf: &str,
    eol: &str,
    autocrlf: Option<&str>,
    core_eol: Option<&str>,
    native_crlf: bool,
) -> CrlfAction {
    #[derive(PartialEq)]
    enum Attr {
        Undefined,
        Binary,
        Text,
        Input,
        Auto,
    }
    let text_attr = |v: &str| match v {
        "set" => Attr::Text,
        "unset" => Attr::Binary,
        "input" => Attr::Input,
        "auto" => Attr::Auto,
        _ => Attr::Undefined,
    };
    let mut t = text_attr(text);
    if t == Attr::Undefined {
        t = text_attr(crlf);
    }
    let autocrlf = match autocrlf {
        Some("input") => Some(false),
        Some("true" | "yes" | "on" | "1") => Some(true),
        _ => None,
    };
    // `core.autocrlf` wins over `core.eol`; then `core.eol`; then the native ending
    let text_eol_crlf = match autocrlf {
        Some(crlf) => crlf,
        None => match core_eol {
            Some("crlf") => true,
            Some("lf") => false,
            _ => native_crlf,
        },
    };
    let by_eol = |auto: bool| match (eol, auto) {
        ("crlf", true) => Some(CrlfAction::AutoCrlf),
        ("lf", true) => Some(CrlfAction::AutoLf),
        ("crlf", false) => Some(CrlfAction::TextCrlf),
        ("lf", false) => Some(CrlfAction::TextLf),
        _ => None,
    };
    match t {
        Attr::Binary => CrlfAction::Binary,
        Attr::Input => by_eol(false).unwrap_or(CrlfAction::TextLf),
        Attr::Auto => by_eol(true).unwrap_or(if text_eol_crlf {
            CrlfAction::AutoCrlf
        } else {
            CrlfAction::AutoLf
        }),
        Attr::Text => by_eol(false).unwrap_or(if text_eol_crlf {
            CrlfAction::TextCrlf
        } else {
            CrlfAction::TextLf
        }),
        Attr::Undefined => by_eol(false).unwrap_or(match autocrlf {
            Some(true) => CrlfAction::AutoCrlf,
            Some(false) => CrlfAction::AutoLf,
            None => CrlfAction::Binary,
        }),
    }
}

/// Whether checking `stored` out with `action` turns its bare LFs into CRLF (git's
/// `will_convert_lf_to_crlf`).
fn converts_to_crlf(stored: &[u8], action: CrlfAction) -> bool {
    let (mut lone_lf, mut lone_cr, mut crlf, mut nul) = (0usize, 0usize, 0usize, 0usize);
    let (mut printable, mut nonprintable) = (0usize, 0usize);
    for (i, b) in stored.iter().enumerate() {
        match *b {
            b'\r' if stored.get(i + 1) == Some(&b'\n') => crlf += 1,
            b'\r' => lone_cr += 1,
            b'\n' if i > 0 && stored[i - 1] == b'\r' => {}
            b'\n' => lone_lf += 1,
            0 => nul += 1,
            127 => nonprintable += 1,
            // BS, HT, ESC and FF count as printable, like in git
            8 | 9 | 27 | 12 => printable += 1,
            b if b < 32 => nonprintable += 1,
            _ => printable += 1,
        }
    }
    if lone_lf == 0 {
        return false;
    }
    match action {
        CrlfAction::TextCrlf => true,
        CrlfAction::AutoCrlf => {
            let binary = lone_cr > 0 || nul > 0 || (printable >> 7) < nonprintable;
            crlf == 0 && lone_cr == 0 && !binary
        }
        CrlfAction::Binary | CrlfAction::TextLf | CrlfAction::AutoLf => false,
    }
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

const GITLINK: &str = "160000";

/// Keeps one whole side of each path (Accept Yours / Accept Theirs). `side` is the user's view; the
/// rebase swap is applied here, per file.
///
/// - A side that has a regular file or a symlink: `git checkout --ours|--theirs -- path`, then
///   `git add -A -- path`.
/// - A side that has a submodule (a gitlink, mode 160000): `git checkout` does not move a gitlink
///   and `git add` would record the submodule's current HEAD (that is Yours, whatever side was
///   asked), so the index entry is set from the chosen stage with `git update-index --cacheinfo`.
///   The submodule's worktree is not touched.
/// - A side that deleted the file: `git rm -- path` (`--cached` for a submodule, which must keep
///   its worktree).
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
    let (mut ours, mut theirs) = (Vec::new(), Vec::new());
    let (mut gitlinks, mut remove, mut remove_cached) = (Vec::new(), Vec::new(), Vec::new());
    for p in paths {
        let u = listed
            .iter()
            .find(|u| &u.path == p)
            .ok_or_else(|| GitError::Invalid(format!("{p} is no longer in conflict.")))?;
        let st = side_stages(git, repo, u)?;
        let stage_no = match side {
            ConflictSide::Ours => st.yours,
            ConflictSide::Theirs => st.theirs,
        };
        match u.stage(stage_no) {
            Some(e) if e.mode == GITLINK => gitlinks.push((p.clone(), e.oid.clone())),
            // Git's own flag: --ours is stage 2, --theirs is stage 3.
            Some(_) if stage_no == 2 => ours.push(p.clone()),
            Some(_) => theirs.push(p.clone()),
            None if u.present().any(|e| e.mode == GITLINK) => remove_cached.push(p.clone()),
            None => remove.push(p.clone()),
        }
    }
    let rp = repo_path(repo);
    for (flag, keep) in [("--ours", &ours), ("--theirs", &theirs)] {
        if keep.is_empty() {
            continue;
        }
        git.run(
            rp,
            Some(&repo.id),
            &with_paths(&["checkout", flag], keep),
            true,
        )?;
        stage(git, repo, keep)?;
    }
    for (path, oid) in &gitlinks {
        let info = format!("{GITLINK},{oid},{path}");
        git.run(
            rp,
            Some(&repo.id),
            &["update-index", "--add", "--cacheinfo", &info],
            true,
        )?;
    }
    if !remove.is_empty() {
        git.run(
            rp,
            Some(&repo.id),
            &with_paths(&["rm", "-q"], &remove),
            true,
        )?;
    }
    if !remove_cached.is_empty() {
        git.run(
            rp,
            Some(&repo.id),
            &with_paths(&["rm", "-q", "--cached"], &remove_cached),
            true,
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------- save a hand-made resolution

/// The blob ids of the three versions the editor loaded (`ConflictBlob::oid`); `None` = that version
/// was absent. They must match the index exactly (an omitted id means "absent").
#[derive(Clone, Copy, Debug, Default)]
pub struct ExpectedOids<'a> {
    /// The user's side ("Yours").
    pub ours: Option<&'a str>,
    pub theirs: Option<&'a str>,
    pub base: Option<&'a str>,
}

/// Writes `content` (UTF-8, LF line ends) as the file, in the file's own line ending and with its
/// file mode, and with `resolved` stages it (`git add`). Without `resolved` the file is only
/// written (it still holds conflict markers) and stays unmerged.
///
/// Line endings: a file whose versions are all LF or all CRLF is written in its majority ending. A
/// file with mixed endings keeps each line's own: a line whose text is in Yours (else Theirs, else
/// the base) gets the ending it has there; a new line gets LF.
///
/// Refused when the file is no longer conflicted, when any of the three versions the editor
/// loaded (`expected`) is not the current one (Yours, Theirs and the base when there is one: a
/// change of either side makes the editor stale), when any version is binary or not UTF-8, or when
/// the file is a symlink or submodule.
pub fn save_resolution(
    git: &Git,
    repo: &RepoInfo,
    path: &str,
    content: &str,
    expected: ExpectedOids<'_>,
    resolved: bool,
) -> Result<(), GitError> {
    check_path(path)?;
    if content.contains('\0') {
        return Err(GitError::Invalid("The result contains a NUL byte.".into()));
    }
    let u = unmerged_one(git, repo, path)?;
    let st = side_stages(git, repo, &u)?;
    if !u.regular() {
        return Err(GitError::Invalid(format!(
            "{path} is a symlink or a submodule: accept Yours or Theirs instead."
        )));
    }
    let oid_of = |n: usize| u.stage(n).map(|e| e.oid.as_str());
    if oid_of(st.yours) != expected.ours
        || oid_of(st.theirs) != expected.theirs
        || oid_of(1) != expected.base
    {
        return Err(GitError::Invalid(
            "The conflict changed. Reload the merge.".into(),
        ));
    }
    let blobs = read_blobs(git, repo, &oids_of(std::slice::from_ref(&u)))?;
    if u.present().any(|e| blob_of(e, blobs.get(&e.oid)).binary) {
        return Err(GitError::Invalid(format!(
            "{path} is binary, not UTF-8 or too large: accept Yours or Theirs instead."
        )));
    }
    let version_bytes = |n: usize| u.stage(n).and_then(|e| blobs.get(&e.oid)?.bytes.as_deref());
    let versions: Vec<&[u8]> = [st.yours, st.theirs, 1]
        .into_iter()
        .filter_map(version_bytes)
        .collect();
    let bytes = if versions.iter().any(|v| is_mixed(v)) {
        keep_line_endings(content, &versions)
    } else {
        match detect_eol(git, repo, path, &u, &st, &blobs) {
            Eol::Lf => content.as_bytes().to_vec(),
            Eol::Crlf => content
                .replace("\r\n", "\n")
                .replace('\n', "\r\n")
                .into_bytes(),
        }
    };
    let executable = u.present().any(|e| e.mode == "100755");
    write_worktree_file(repo_path(repo), path, &bytes, executable)?;
    if resolved {
        stage(git, repo, &[path.to_string()])?;
    }
    Ok(())
}

/// True when `bytes` has both CRLF and bare LF line ends.
fn is_mixed(bytes: &[u8]) -> bool {
    let (mut crlf, mut lf) = (false, false);
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf = true;
            } else {
                lf = true;
            }
        }
    }
    crlf && lf
}

/// `content` (LF line ends) with the line endings the lines have in `versions` (in order of
/// preference). A line is matched by its text; the n-th time a text appears in the result it takes
/// the n-th ending that text has in the versions (the last one when it runs out). A line that is in
/// no version, and the last line when `content` does not end with a newline, get LF / none.
fn keep_line_endings(content: &str, versions: &[&[u8]]) -> Vec<u8> {
    const LF: &[u8] = b"\n";
    const CRLF: &[u8] = b"\r\n";
    let mut pool: HashMap<&[u8], VecDeque<&[u8]>> = HashMap::new();
    for v in versions {
        for line in v.split_inclusive(|b| *b == b'\n') {
            let (text, eol) = match line.strip_suffix(b"\n") {
                Some(t) => match t.strip_suffix(b"\r") {
                    Some(t) => (t, CRLF),
                    None => (t, LF),
                },
                None => continue, // a last line without line end says nothing
            };
            pool.entry(text).or_default().push_back(eol);
        }
    }
    let content = content.replace("\r\n", "\n");
    let mut last: HashMap<&[u8], &[u8]> = HashMap::new();
    let mut out = Vec::with_capacity(content.len() + 16);
    for line in content.as_bytes().split_inclusive(|b| *b == b'\n') {
        let Some(text) = line.strip_suffix(b"\n") else {
            out.extend_from_slice(line);
            continue;
        };
        out.extend_from_slice(text);
        let eol = match pool.get_mut(text).and_then(VecDeque::pop_front) {
            Some(e) => {
                last.insert(text, e);
                e
            }
            None => last.get(text).copied().unwrap_or(LF),
        };
        out.extend_from_slice(eol);
    }
    out
}

/// Writes a regular file inside the repo. An existing file keeps its mode (it is rewritten in
/// place); a new one gets the exec bit when the index entry had it. Never writes through a
/// symlink, and never outside the repo.
pub(crate) fn write_worktree_file(
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
    fn checkout_conversion_follows_attributes_then_config() {
        use CrlfAction::*;
        let u = "unspecified";
        // nothing set: no conversion; `core.autocrlf` decides
        assert_eq!(checkout_action(u, u, u, None, None, false), Binary);
        assert_eq!(checkout_action(u, u, u, None, Some("crlf"), true), Binary);
        assert_eq!(
            checkout_action(u, u, u, Some("true"), None, false),
            AutoCrlf
        );
        assert_eq!(checkout_action(u, u, u, Some("input"), None, false), AutoLf);
        assert_eq!(checkout_action(u, u, u, Some("false"), None, false), Binary);
        // `text`: `core.autocrlf`, then `core.eol`, then the native ending
        assert_eq!(checkout_action("set", u, u, None, None, false), TextLf);
        assert_eq!(checkout_action("set", u, u, None, None, true), TextCrlf);
        assert_eq!(
            checkout_action("set", u, u, None, Some("crlf"), false),
            TextCrlf
        );
        assert_eq!(checkout_action("set", u, u, None, Some("lf"), true), TextLf);
        assert_eq!(
            checkout_action("set", u, u, Some("true"), Some("lf"), false),
            TextCrlf
        );
        assert_eq!(
            checkout_action("auto", u, u, None, Some("crlf"), false),
            AutoCrlf
        );
        // `eol` makes a file text and wins over the config; `-text` / `binary` wins over `eol`
        assert_eq!(checkout_action(u, u, "crlf", None, None, false), TextCrlf);
        assert_eq!(
            checkout_action("auto", u, "crlf", Some("input"), None, false),
            AutoCrlf
        );
        assert_eq!(
            checkout_action("set", u, "lf", Some("true"), None, false),
            TextLf
        );
        assert_eq!(
            checkout_action("unset", u, "crlf", Some("true"), None, false),
            Binary
        );
        // the old `crlf` attribute when `text` is not set
        assert_eq!(
            checkout_action(u, "unset", u, Some("true"), None, false),
            Binary
        );
        assert_eq!(
            checkout_action(u, "input", u, Some("true"), None, false),
            TextLf
        );
    }

    #[test]
    fn auto_conversion_leaves_cr_and_binary_alone() {
        assert!(converts_to_crlf(b"a\nb\n", CrlfAction::AutoCrlf));
        assert!(!converts_to_crlf(b"a\r\nb\n", CrlfAction::AutoCrlf));
        assert!(!converts_to_crlf(b"a\0\nb\n", CrlfAction::AutoCrlf));
        assert!(converts_to_crlf(b"a\r\nb\n", CrlfAction::TextCrlf));
        assert!(!converts_to_crlf(b"a\r\nb\r\n", CrlfAction::TextCrlf));
        assert!(!converts_to_crlf(b"a\nb\n", CrlfAction::AutoLf));
        assert!(!converts_to_crlf(b"a\nb\n", CrlfAction::Binary));
    }

    #[test]
    fn check_attr_output_is_read() {
        let out = b"f\0text\0auto\0f\0crlf\0unspecified\0f\0eol\0crlf\0";
        let attrs = parse_check_attr(out);
        assert_eq!(attr_value(&attrs, "text"), "auto");
        assert_eq!(attr_value(&attrs, "eol"), "crlf");
        assert_eq!(attr_value(&attrs, "crlf"), "unspecified");
        assert_eq!(attr_value(&attrs, "other"), "unspecified");
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
    fn mixed_endings_are_kept_line_by_line() {
        let yours = b"a\r\nb\nc\r\nc\n";
        assert!(is_mixed(yours));
        assert!(!is_mixed(b"a\r\nb\r\n"));
        assert!(!is_mixed(b"a\nb\n"));
        let kept = |content: &str| String::from_utf8(keep_line_endings(content, &[yours])).unwrap();
        // unchanged lines keep their ending, new lines get LF
        assert_eq!(kept("a\nb\nc\nc\n"), "a\r\nb\nc\r\nc\n");
        assert_eq!(kept("a\nNEW\nb\nc\nc\n"), "a\r\nNEW\nb\nc\r\nc\n");
        // a text that appears more often than in the versions repeats the last ending it had
        assert_eq!(kept("c\nc\nc\n"), "c\r\nc\nc\n");
        // CRLF the editor still holds is not doubled; a last line without a newline stays without
        assert_eq!(kept("a\r\nb\nlast"), "a\r\nb\nlast");
        // the first version wins over the later ones
        let theirs: &[u8] = b"a\nz\r\n";
        let both = keep_line_endings("a\nz\n", &[yours, theirs]);
        assert_eq!(String::from_utf8(both).unwrap(), "a\r\nz\r\n");
    }
}
