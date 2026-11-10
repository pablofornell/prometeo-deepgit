//! Finding repositories under a folder and building a `Project`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::model::{Project, RepoInfo};
use crate::palette::next_color;

const SKIP_DIRS: [&str; 5] = ["node_modules", "target", "dist", "build", ".venv"];

/// A directory is a repo if it has `.git` (a directory, or a file for worktrees/submodules).
pub fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// First 12 hex chars of sha1(canonical path).
pub fn repo_id(path: &Path) -> String {
    let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut h = sha1_smol::Sha1::new();
    h.update(canon.to_string_lossy().as_bytes());
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
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
            continue;
        }
        walk(&entry.path(), depth + 1, max_depth, found, seen);
    }
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

/// Builds a project for `root` with its repos discovered (depth <= 4). Each repo gets the palette
/// colour that is least used in the project so far (lowest index on a tie). The caller (the
/// workspace) replaces these with colours balanced across all projects.
pub fn make_project(root: &Path) -> Project {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut used: Vec<u8> = Vec::new();
    let repos = find_repos(&root, 4)
        .iter()
        .map(|p| {
            let rel = rel_name(&root, p);
            let color = next_color(used.iter().copied());
            used.push(color);
            RepoInfo {
                id: repo_id(p),
                name: if rel.is_empty() {
                    folder_name(&root)
                } else {
                    rel
                },
                path: p.to_string_lossy().into_owned(),
                color,
                custom_color: None,
            }
        })
        .collect();
    Project {
        id: repo_id(&root),
        name: folder_name(&root),
        path: root.to_string_lossy().into_owned(),
        repos,
        color: 0,
        custom_color: None,
    }
}
