//! Finding repositories under a folder and building a `Project`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::model::{Project, RepoInfo};
use crate::paths::canonicalize;

const SKIP_DIRS: [&str; 5] = ["node_modules", "target", "dist", "build", ".venv"];

/// How many levels below a project folder a scan looks (the project folder is level 0).
pub const MAX_DEPTH: usize = 4;

/// True for the folders a scan never enters: names that start with `.` and `SKIP_DIRS`.
pub fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

/// Why a scan of `root` would not find a repository at `repo` (`None`: it would, or `repo` is not
/// below `root`). The same rules as `find_repos` with `MAX_DEPTH`: no folder on the way may be
/// skipped, and the repo is at most `MAX_DEPTH` levels down. The text is for the user.
pub fn not_found_reason(root: &Path, repo: &Path) -> Option<String> {
    let rel = repo.strip_prefix(root).ok()?;
    let names: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if let Some(name) = names.iter().find(|n| is_skipped_dir(n)) {
        return Some(format!(
            "A scan of the project folder skips folders named \"{name}\" (names that start with '.', {}), so a repository in {} would not be found. Choose another folder, or add the clone to a new project.",
            SKIP_DIRS.join(", "),
            repo.display()
        ));
    }
    if names.len() > MAX_DEPTH {
        return Some(format!(
            "A scan of the project folder finds repositories up to {MAX_DEPTH} levels deep, and {} is {} levels below {}. Choose a parent folder closer to the project folder, or add the clone to a new project.",
            repo.display(),
            names.len(),
            root.display()
        ));
    }
    None
}

/// A directory is a repo if it has `.git` (a directory, or a file for worktrees/submodules).
pub fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// First 12 hex chars of sha1(canonical path).
pub fn repo_id(path: &Path) -> String {
    let canon = canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path_id(&canon.to_string_lossy())
}

/// The id of a repo or project whose canonical path is `canonical`: the first 12 hex chars of its
/// sha1 (no file system access; `repo_id` canonicalizes first).
pub fn path_id(canonical: &str) -> String {
    let mut h = sha1_smol::Sha1::new();
    h.update(canonical.as_bytes());
    h.digest().to_string()[..12].to_string()
}

/// Repositories at or below `root` up to `max_depth` levels (root is depth 0), sorted by relative
/// path with the root repo first. A repo is still scanned for nested repos. Symlinks are not
/// followed, and each directory is listed once.
pub fn find_repos(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    walk(root, 0, max_depth, &mut found, &mut seen);
    found.sort_by_key(|p| rel_name(root, p));
    found
}

fn walk(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    found: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
) {
    let canon = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if !seen.insert(canon) {
        return;
    }
    if is_repo(dir) {
        found.push(dir.to_path_buf());
    }
    if depth >= max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        // `file_type` does not follow symlinks.
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_skipped_dir(&name) {
            continue;
        }
        walk(&entry.path(), depth + 1, max_depth, found, seen);
    }
}

/// How many levels below the folder `find_deep_repo` looks.
pub const PROBE_DEPTH: usize = 8;

/// `find_deep_repo` stops after this many directory entries, so a huge tree cannot hold it for long.
const PROBE_MAX_ENTRIES: usize = 20_000;

/// A cheap, bounded search for any `.git` entry below `root`, for a folder where `find_repos` found
/// nothing: the repository can be deeper than `MAX_DEPTH`, or below a folder the scan skips. It looks
/// `PROBE_DEPTH` levels down, skips `node_modules` and links, and stops at the first hit. Returns the
/// levels between `root` and the folder that holds the `.git` entry (1 is a direct subfolder).
pub fn find_deep_repo(root: &Path) -> Option<usize> {
    let mut seen = 0;
    probe(root, 0, &mut seen)
}

fn probe(dir: &Path, depth: usize, seen: &mut usize) -> Option<usize> {
    let mut subdirs = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        *seen += 1;
        if *seen > PROBE_MAX_ENTRIES {
            return None;
        }
        let name = entry.file_name();
        if depth > 0 && name == ".git" {
            return Some(depth);
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && !kind.is_symlink() && name != "node_modules" && depth < PROBE_DEPTH {
            subdirs.push(entry.path());
        }
    }
    subdirs.iter().find_map(|d| probe(d, depth + 1, seen))
}

/// Relative path with `/` separators; empty for the root itself.
fn rel_name(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| {
            r.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

fn folder_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.display().to_string())
}

/// Builds a project for `root` with its repos discovered (depth <= `MAX_DEPTH`).
pub fn make_project(root: &Path) -> Project {
    let root = canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let repos = find_repos(&root, MAX_DEPTH)
        .iter()
        .map(|p| {
            let rel = rel_name(&root, p);
            RepoInfo {
                id: repo_id(p),
                name: if rel.is_empty() {
                    folder_name(&root)
                } else {
                    rel
                },
                path: p.to_string_lossy().into_owned(),
            }
        })
        .collect();
    Project {
        id: repo_id(&root),
        name: folder_name(&root),
        path: root.to_string_lossy().into_owned(),
        repos,
    }
}
