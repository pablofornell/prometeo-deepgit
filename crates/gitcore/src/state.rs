//! Detection of an in-progress operation (merge, rebase, cherry-pick, revert, bisect).

use std::path::{Path, PathBuf};

use crate::error::GitError;
use crate::model::RepoStateKind;

/// Checks marker files in the git dir, in this order: MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD,
/// rebase-merge/rebase-apply, the sequencer todo list (a multi-commit cherry-pick or revert
/// between two commits has no `*_HEAD` file), BISECT_LOG.
pub fn detect(git_dir: &Path) -> RepoStateKind {
    if git_dir.join("MERGE_HEAD").exists() {
        RepoStateKind::Merging
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        // A rebase does not write CHERRY_PICK_HEAD / REVERT_HEAD for its own conflicts (it has
        // REBASE_HEAD), so these mean a cherry-pick or revert run by the user, also while a rebase
        // is stopped: that one is continued or aborted with its own command.
        RepoStateKind::CherryPicking
    } else if git_dir.join("REVERT_HEAD").exists() {
        RepoStateKind::Reverting
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        RepoStateKind::Rebasing
    } else if let Some(kind) = sequencer_state(git_dir) {
        kind
    } else if git_dir.join("BISECT_LOG").exists() {
        RepoStateKind::Bisecting
    } else {
        RepoStateKind::Clean
    }
}

/// `sequencer/todo` holds the commits still to apply; its first command tells which operation.
fn sequencer_state(git_dir: &Path) -> Option<RepoStateKind> {
    let todo = std::fs::read_to_string(git_dir.join("sequencer").join("todo")).ok()?;
    let first = todo
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))?;
    match first.split_whitespace().next()? {
        "pick" | "p" => Some(RepoStateKind::CherryPicking),
        "revert" => Some(RepoStateKind::Reverting),
        _ => None,
    }
}

/// Resolves the git dir of a working tree without spawning git: `.git` is a directory, or a
/// file with a `gitdir: <path>` line (worktrees and submodules).
pub fn git_dir(repo: &Path) -> Result<PathBuf, GitError> {
    let dot_git = repo.join(".git");
    if dot_git.is_dir() {
        return Ok(dot_git);
    }
    if dot_git.is_file() {
        let text = std::fs::read_to_string(&dot_git)?;
        let target = text
            .lines()
            .find_map(|l| l.strip_prefix("gitdir:"))
            .map(str::trim)
            .ok_or_else(|| GitError::Parse(format!("no gitdir line in {}", dot_git.display())))?;
        let p = Path::new(target);
        return Ok(if p.is_absolute() {
            p.to_path_buf()
        } else {
            repo.join(p)
        });
    }
    Err(GitError::NotARepo(repo.display().to_string()))
}

/// State of the repository at `repo`.
pub fn repo_state(repo: &Path) -> Result<RepoStateKind, GitError> {
    Ok(detect(&git_dir(repo)?))
}
