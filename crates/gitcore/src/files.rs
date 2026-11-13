//! Project files: list, read, write and search the files of the worktree. Every path is relative
//! to the repo root. The list and the search skip ignored files. Read and write still accept a
//! path to an ignored file. The ignore file functions are the only ones that touch `.git/info/exclude`.

use std::collections::BTreeSet;
use std::io::Read;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use crate::conflicts::write_worktree_file;
use crate::diff::{worktree_path, MAX_CONTENT_BYTES};
use crate::error::GitError;
use crate::model::{
    FileList, IgnoreFile, IgnoreTarget, RepoInfo, SearchHit, SearchResult, TextFile,
};
use crate::ops::check_rel;
use crate::runner::{command_error, Git};

/// `list_files` returns at most this many paths.
pub const MAX_LISTED_FILES: usize = 100_000;
/// `search_files` returns at most this many hits.
pub const MAX_HITS: usize = 2_000;
/// A hit shows at most this many characters of its line.
pub const MAX_HIT_CHARS: usize = 400;
/// Treat a file with a NUL byte in its first bytes as binary (the rule of git).
const BINARY_SCAN_BYTES: usize = 8000;

/// List the tracked and untracked files that are not ignored, sorted by path. Leave out a tracked
/// file that is gone from the disk, and a submodule folder.
pub fn list_files(git: &Git, repo: &RepoInfo) -> Result<FileList, GitError> {
    let root = Path::new(&repo.path);
    let args = [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
    ];
    let out = git.run(root, Some(&repo.id), &args, false)?;
    let found: BTreeSet<String> = out
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty() && is_on_disk(root, p))
        .map(str::to_string)
        .collect();
    Ok(cap_list(found, MAX_LISTED_FILES))
}

/// The first `max` paths. `truncated` says that there were more.
fn cap_list(found: BTreeSet<String>, max: usize) -> FileList {
    let truncated = found.len() > max;
    FileList {
        files: found.into_iter().take(max).collect(),
        truncated,
    }
}

/// Count a regular file or a symlink as on disk. List a symlink even when its target is gone.
fn is_on_disk(root: &Path, rel: &str) -> bool {
    std::fs::symlink_metadata(root.join(rel)).is_ok_and(|m| m.is_file() || m.is_symlink())
}

/// Read a worktree file as text. A file over 2 MiB, or a binary one, gives empty content and a flag.
/// Refuse a symlink.
pub fn read_text_file(_git: &Git, repo: &RepoInfo, path: &str) -> Result<TextFile, GitError> {
    check_path(path)?;
    let full = worktree_path(repo, path)?;
    check_regular(&full, path)?;
    let mut bytes = Vec::new();
    std::fs::File::open(&full)?
        .take(MAX_CONTENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CONTENT_BYTES {
        return Ok(TextFile {
            content: String::new(),
            version: String::new(),
            binary: false,
            too_large: true,
        });
    }
    let version = version_of(&bytes);
    let nul = bytes[..bytes.len().min(BINARY_SCAN_BYTES)].contains(&0);
    let text = if nul {
        None
    } else {
        String::from_utf8(bytes).ok()
    };
    let binary = text.is_none();
    Ok(TextFile {
        content: text.unwrap_or_default(),
        version,
        binary,
        too_large: false,
    })
}

/// Save the bytes of `content` to a worktree file. Line endings do not change. Return the new
/// version. With `expected_version`, refuse a file that changed since that version. Create a
/// missing file. With an expected version, refuse a missing file too.
pub fn write_text_file(
    _git: &Git,
    repo: &RepoInfo,
    path: &str,
    content: &str,
    expected_version: Option<&str>,
) -> Result<String, GitError> {
    check_path(path)?;
    let full = worktree_path(repo, path)?;
    match std::fs::symlink_metadata(&full) {
        Ok(_) => {
            check_regular(&full, path)?;
            let current = version_of(&std::fs::read(&full)?);
            if expected_version.is_some_and(|v| v != current) {
                return Err(changed_on_disk());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if expected_version.is_some() {
                return Err(changed_on_disk());
            }
        }
        Err(e) => return Err(e.into()),
    }
    write_worktree_file(Path::new(&repo.path), path, content.as_bytes(), false)?;
    Ok(version_of(content.as_bytes()))
}

fn changed_on_disk() -> GitError {
    GitError::Invalid("The file changed on disk. Reload it before you save.".to_string())
}

/// Read the text of an ignore file, and the case rule of the repo (`core.ignorecase`, false when unset).
/// A missing file gives an empty text. Refuse a symlink and a folder, and a file over 2 MiB.
pub fn read_ignore_file(
    git: &Git,
    repo: &RepoInfo,
    target: IgnoreTarget,
) -> Result<IgnoreFile, GitError> {
    let content = read_ignore_text(git, repo, target)?;
    Ok(IgnoreFile {
        content,
        ignore_case: core_ignorecase(git, repo)?,
    })
}

/// The value of `core.ignorecase`. Git exits with 1 when the key is not set: that means false.
fn core_ignorecase(git: &Git, repo: &RepoInfo) -> Result<bool, GitError> {
    let args = ["config", "--type=bool", "--get", "core.ignorecase"];
    let out = git.run_unchecked(Path::new(&repo.path), Some(&repo.id), &args, false, None)?;
    Ok(out.code == 0 && out.stdout.trim() == "true")
}

fn read_ignore_text(git: &Git, repo: &RepoInfo, target: IgnoreTarget) -> Result<String, GitError> {
    let full = ignore_file_path(git, repo, target)?;
    match std::fs::symlink_metadata(&full) {
        Ok(_) => check_regular(&full, &ignore_label(target))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.into()),
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&full)?
        .take(MAX_CONTENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CONTENT_BYTES {
        return Err(GitError::Invalid(format!(
            "{} is larger than 2 MiB.",
            ignore_label(target)
        )));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Add pattern lines at the end of an ignore file. Create the file (and the `info` folder) when it
/// is missing. Add a line break first when the file does not end with one. New lines use `\r\n`
/// when the file already does. Skip a line that the file holds already, and a repeated one.
/// Return the lines that were added. Do not stage and do not commit.
pub fn append_ignore_rules(
    git: &Git,
    repo: &RepoInfo,
    target: IgnoreTarget,
    patterns: &[String],
) -> Result<Vec<String>, GitError> {
    for p in patterns {
        if p.trim().is_empty() {
            return Err(GitError::Invalid("A pattern cannot be empty.".to_string()));
        }
        if p.contains(['\n', '\r', '\0']) {
            return Err(GitError::Invalid(
                "A pattern cannot contain a line break or a NUL character.".to_string(),
            ));
        }
    }
    let full = ignore_file_path(git, repo, target)?;
    let label = ignore_label(target);
    let existing = match std::fs::symlink_metadata(&full) {
        Ok(_) => {
            check_regular(&full, &label)?;
            std::fs::read(&full)?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let text = String::from_utf8_lossy(&existing);
    let mut known: BTreeSet<&str> = text.lines().collect();
    let mut added = Vec::new();
    for p in patterns {
        if known.insert(p.as_str()) {
            added.push(p.clone());
        }
    }
    if added.is_empty() {
        return Ok(added);
    }
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::new();
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        out.push_str(eol);
    }
    for line in &added {
        out.push_str(line);
        out.push_str(eol);
    }
    if let Some(dir) = full.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&full)?;
    file.write_all(out.as_bytes())?;
    file.flush()?;
    Ok(added)
}

/// The path of an ignore file. `.git/info/exclude` comes from git, because a linked worktree
/// shares it with the main one.
fn ignore_file_path(git: &Git, repo: &RepoInfo, target: IgnoreTarget) -> Result<PathBuf, GitError> {
    let root = Path::new(&repo.path);
    match target {
        IgnoreTarget::Gitignore => Ok(root.join(".gitignore")),
        IgnoreTarget::Exclude => {
            let args = ["rev-parse", "--git-path", "info/exclude"];
            let out = git.run(root, Some(&repo.id), &args, false)?;
            let path = PathBuf::from(out.stdout.trim_end_matches(['\n', '\r']));
            Ok(if path.is_absolute() {
                path
            } else {
                root.join(path)
            })
        }
    }
}

fn ignore_label(target: IgnoreTarget) -> String {
    match target {
        IgnoreTarget::Gitignore => ".gitignore".to_string(),
        IgnoreTarget::Exclude => ".git/info/exclude".to_string(),
    }
}

/// Search the tracked and untracked files that are not ignored. With `regex`, the query is a POSIX
/// extended regex (`git grep -E`). Otherwise the query matches as plain text (`-F`). Each matching
/// line gives one hit, at the column of its first match. Sort the hits by path and line.
pub fn search_files(
    git: &Git,
    repo: &RepoInfo,
    query: &str,
    case_sensitive: bool,
    regex: bool,
) -> Result<SearchResult, GitError> {
    if query.contains(['\0', '\n', '\r']) {
        return Err(GitError::Invalid(
            "The search text cannot contain a line break or a NUL character.".to_string(),
        ));
    }
    let none = SearchResult {
        hits: Vec::new(),
        truncated: false,
    };
    if query.is_empty() {
        return Ok(none);
    }
    let root = Path::new(&repo.path);
    let mut args = vec![
        "grep",
        "-n",
        "--column",
        "-I",
        "--no-color",
        "-z",
        "--untracked",
        "--exclude-standard",
    ];
    if !case_sensitive {
        args.push("-i");
    }
    args.push(if regex { "-E" } else { "-F" });
    args.extend(["-e", query, "--"]);
    let out = git.run_unchecked(root, Some(&repo.id), &args, false, None)?;
    match out.code {
        0 => {}
        // No match
        1 => return Ok(none),
        _ => return Err(command_error(root, &args, &out)),
    }
    let mut hits = parse_hits(&out.stdout)?;
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    let truncated = hits.len() > MAX_HITS;
    hits.truncate(MAX_HITS);
    Ok(SearchResult { hits, truncated })
}

/// Parse `git grep -n --column -z` output. Each hit is `path NUL line NUL column NUL text LF`.
fn parse_hits(text: &str) -> Result<Vec<SearchHit>, GitError> {
    let bad = || GitError::Parse("git grep output".to_string());
    let mut hits = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let (path, r) = rest.split_once('\0').ok_or_else(bad)?;
        let (line, r) = r.split_once('\0').ok_or_else(bad)?;
        let (column, r) = r.split_once('\0').ok_or_else(bad)?;
        let (line_text, next) = r.split_once('\n').unwrap_or((r, ""));
        rest = next;
        let line: u32 = line.parse().map_err(|_| bad())?;
        let byte_column: usize = column.parse().map_err(|_| bad())?;
        let line_text = line_text.strip_suffix('\r').unwrap_or(line_text);
        hits.push(SearchHit {
            path: path.to_string(),
            line,
            column: char_column(line_text, byte_column),
            text: line_text.chars().take(MAX_HIT_CHARS).collect(),
        });
    }
    Ok(hits)
}

/// Convert git's 1-based byte column to a 1-based character column of `text`.
fn char_column(text: &str, byte_column: usize) -> u32 {
    let end = byte_column.saturating_sub(1).min(text.len());
    // Count the bytes that are not continuation bytes (10xxxxxx). Each one starts a character.
    let before = text.as_bytes()[..end]
        .iter()
        .filter(|b| **b & 0xC0 != 0x80)
        .count();
    before as u32 + 1
}

/// Make a version of some bytes: the SHA-1 in hex, a dash and the length. Use SHA-1 because its
/// output does not change between Rust releases.
fn version_of(bytes: &[u8]) -> String {
    format!("{}-{}", sha1_smol::Sha1::from(bytes).digest(), bytes.len())
}

/// Refuse an empty path, a path outside the repo and a path into the git folder (`.git`, in any
/// case). The file API must never touch that folder.
fn check_path(path: &str) -> Result<(), GitError> {
    if path.is_empty() {
        return Err(GitError::Invalid("No file path given.".to_string()));
    }
    check_rel(path)?;
    let in_git_dir = Path::new(path)
        .components()
        .any(|c| matches!(c, Component::Normal(n) if n.eq_ignore_ascii_case(".git")));
    if in_git_dir {
        return Err(GitError::Invalid(format!(
            "path inside the git folder: {path}"
        )));
    }
    Ok(())
}

/// Refuse a path that is not a regular file: a symlink, a folder, a special file or a missing file.
fn check_regular(full: &Path, path: &str) -> Result<(), GitError> {
    match std::fs::symlink_metadata(full) {
        Ok(m) if m.is_symlink() => Err(GitError::Invalid(format!("{path} is a symlink."))),
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err(GitError::Invalid(format!("not a regular file: {path}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(GitError::Invalid(format!("file not found: {path}")))
        }
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cap_keeps_the_first_paths_and_flags_the_rest() {
        let list = cap_list(set(&["a", "b", "c"]), 2);
        assert_eq!(list.files, vec!["a", "b"]);
        assert!(list.truncated);
        let all = cap_list(set(&["a", "b"]), 2);
        assert_eq!(all.files.len(), 2);
        assert!(!all.truncated);
    }

    #[test]
    fn column_counts_characters_not_bytes() {
        // "héllo needle": git says byte 8 (é takes two bytes); the character column is 7.
        assert_eq!(char_column("héllo needle", 8), 7);
        assert_eq!(char_column("needle", 1), 1);
        // A column past the end never panics.
        assert_eq!(char_column("ab", 99), 3);
    }

    #[test]
    fn parses_hits_with_nul_separated_fields() {
        let hits = parse_hits("a.txt\x001\x003\x00x needle\r\nb/c.txt\x0012\x001\x00needle\n")
            .expect("parse");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "a.txt");
        assert_eq!(hits[0].line, 1);
        assert_eq!(hits[0].column, 3);
        assert_eq!(hits[0].text, "x needle");
        assert_eq!(hits[1].path, "b/c.txt");
        assert_eq!(hits[1].line, 12);
    }

    #[test]
    fn version_changes_with_the_bytes() {
        assert_eq!(version_of(b"abc"), version_of(b"abc"));
        assert_ne!(version_of(b"abc"), version_of(b"abd"));
        assert!(version_of(b"abc").ends_with("-3"));
    }
}
