//! `git init` for a folder that has no repository (the "Initialize a Git repository?" dialog).
//!
//! `init_info` reads what the dialog shows and touches nothing; `init_repository` validates the
//! branch name and runs `git init --initial-branch=<name>`.

use std::path::Path;

use crate::discover::is_repo;
use crate::error::{check_name, GitError};
use crate::model::InitInfo;
use crate::runner::Git;

/// The initial branch when `init.defaultBranch` is not set.
pub const FALLBACK_BRANCH: &str = "main";

/// The text for a branch name that git would refuse (the dialog shows the same sentence).
const BAD_BRANCH: &str = "This is not a valid branch name.";

/// `git config --global init.defaultBranch`, or `main` when it is not set or empty. Runs in `dir`
/// (it only has to exist); the repository config does not count, the folder has none.
pub fn default_branch(git: &Git, dir: &Path) -> String {
    git.run_unchecked(
        dir,
        None,
        &["config", "--global", "--get", "init.defaultBranch"],
        false,
        None,
    )
    .ok()
    .filter(|o| o.code == 0)
    .map(|o| o.stdout.trim().to_string())
    .filter(|b| !b.is_empty())
    .unwrap_or_else(|| FALLBACK_BRANCH.to_string())
}

/// The root of the repository that contains `dir` (`git rev-parse --show-toplevel`), or `None`
/// when no parent folder is a repository.
pub fn parent_repo(git: &Git, dir: &Path) -> Option<String> {
    git.run_unchecked(dir, None, &["rev-parse", "--show-toplevel"], false, None)
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| o.stdout.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// What the dialog shows for the folder `dir` (an existing, canonical folder).
pub fn init_info(git: &Git, dir: &Path) -> InitInfo {
    InitInfo {
        path: dir.to_string_lossy().into_owned(),
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| dir.display().to_string()),
        default_branch: default_branch(git, dir),
        parent_repo: parent_repo(git, dir),
    }
}

/// Runs `git init --initial-branch=<branch>` in `dir`. The branch is trimmed and checked first
/// (`check_name`, then `git check-ref-format --branch`), so a bad name never creates a `.git` folder.
/// Refuses a folder that is a repository already, and a path that is not a folder.
pub fn init_repository(git: &Git, dir: &Path, branch: &str) -> Result<(), GitError> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(GitError::Invalid("Enter a branch name.".into()));
    }
    check_name("branch name", branch)?;
    if !dir.is_dir() {
        return Err(GitError::Invalid(format!(
            "{} is not a folder.",
            dir.display()
        )));
    }
    if is_repo(dir) {
        return Err(GitError::Invalid(format!(
            "{} is a Git repository already.",
            dir.display()
        )));
    }
    // `--branch` accepts "@" and "HEAD", which `git branch` refuses: they are checked here. It also refuses a name
    // that is an `@{-1}` shortcut.
    let check = git.run_unchecked(
        dir,
        None,
        &["check-ref-format", "--branch", branch],
        false,
        None,
    )?;
    if check.code != 0 || branch == "HEAD" || branch == "@" {
        return Err(GitError::Invalid(BAD_BRANCH.into()));
    }
    let initial = format!("--initial-branch={branch}");
    git.run(dir, None, &["init", &initial], true)?;
    Ok(())
}
