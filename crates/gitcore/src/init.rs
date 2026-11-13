//! `git init` for a folder that has no repository (the "Initialize a Git repository?" dialog).
//!
//! `init_info` reads what the dialog shows and touches nothing; `init_repository` checks the folder
//! and the branch name, then runs `git init --initial-branch=<name>`.

use std::path::Path;

use crate::discover::{find_deep_repo, find_repos, is_repo, MAX_DEPTH};
use crate::error::{check_name, GitError};
use crate::model::{InitInfo, ERR_BARE_REPOSITORY, ERR_DEEP_REPOSITORY, ERR_INSIDE_GIT_DIR};
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

/// True when `git rev-parse <flag>` answers `true` in `dir` (the flags that ask a yes-or-no
/// question). Outside a repository git fails, and the answer is false.
fn rev_parse_is(git: &Git, dir: &Path, flag: &str) -> bool {
    git.run_unchecked(dir, None, &["rev-parse", flag], false, None)
        .ok()
        .is_some_and(|o| o.code == 0 && o.stdout.trim() == "true")
}

/// The error for a folder that holds no repository a scan finds, but holds one deeper than the scan
/// looks or below a folder it skips (`find_deep_repo`). `git init` there would wrap that repository.
pub fn deep_repository_error(dir: &Path) -> Option<GitError> {
    let levels = find_deep_repo(dir)?;
    Some(GitError::Refused {
        code: ERR_DEEP_REPOSITORY,
        message: format!(
            "This folder has Git repositories deeper than DeepGit looks ({levels} {}). Add the folder that holds them.",
            if levels == 1 { "level" } else { "levels" }
        ),
    })
}

/// Checks that `git init` makes sense in `dir`. Refuses, in this order: a path that is not a folder;
/// a folder that is a repository (it has `.git`); a bare repository or the data folder of a
/// repository (`GitError::Refused`, the UI does not offer `git init` for them); a folder that holds
/// a repository a scan finds; a folder that holds a repository deeper (`GitError::Refused`).
pub fn check_can_init(git: &Git, dir: &Path) -> Result<(), GitError> {
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
    if rev_parse_is(git, dir, "--is-bare-repository") {
        return Err(GitError::Refused {
            code: ERR_BARE_REPOSITORY,
            message: "This folder is a bare Git repository. DeepGit needs a working folder.".into(),
        });
    }
    if rev_parse_is(git, dir, "--is-inside-git-dir") {
        return Err(GitError::Refused {
            code: ERR_INSIDE_GIT_DIR,
            message: "This folder is inside the data folder of a Git repository. DeepGit needs a working folder."
                .into(),
        });
    }
    if !find_repos(dir, MAX_DEPTH).is_empty() {
        return Err(GitError::Invalid(format!(
            "{} holds a Git repository already.",
            dir.display()
        )));
    }
    match deep_repository_error(dir) {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// What the dialog shows for the folder `dir` (an existing, canonical folder). Fails for a folder
/// where `check_can_init` fails, so the dialog is not offered for it.
pub fn init_info(git: &Git, dir: &Path) -> Result<InitInfo, GitError> {
    check_can_init(git, dir)?;
    Ok(InitInfo {
        path: dir.to_string_lossy().into_owned(),
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| dir.display().to_string()),
        default_branch: default_branch(git, dir),
        parent_repo: parent_repo(git, dir),
    })
}

/// Removes the `.git` folder that a failed `git init` can leave behind, but only when `dir/.git` did
/// not exist before the call (`existed_before`) and is a real folder now (never a link). It removes
/// that one path and nothing else.
fn remove_new_git_dir(dir: &Path, existed_before: bool) {
    if existed_before {
        return;
    }
    let path = dir.join(".git");
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
        let _ = std::fs::remove_dir_all(&path);
    }
}

/// Runs `git init --initial-branch=<branch>` in `dir`, after `check_can_init` and a check of the
/// branch: trimmed, not empty, `check_name`, no `@{`, `git check-ref-format --branch`, not `@` or
/// `HEAD`. `git init` can still fail after it made the `.git` folder (a full disk, a broken template
/// folder); then the `.git` folder that this call made is removed again.
pub fn init_repository(git: &Git, dir: &Path, branch: &str) -> Result<(), GitError> {
    check_can_init(git, dir)?;
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(GitError::Invalid("Enter a branch name.".into()));
    }
    check_name("branch name", branch)?;
    if branch.contains("@{") || branch == "HEAD" || branch == "@" {
        return Err(GitError::Invalid(BAD_BRANCH.into()));
    }
    let check = git.run_unchecked(
        dir,
        None,
        &["check-ref-format", "--branch", branch],
        false,
        None,
    )?;
    if check.code != 0 {
        return Err(GitError::Invalid(BAD_BRANCH.into()));
    }
    let existed_before = std::fs::symlink_metadata(dir.join(".git")).is_ok();
    let initial = format!("--initial-branch={branch}");
    let result = git.run(dir, None, &["init", &initial], true);
    if result.is_err() {
        remove_new_git_dir(dir, existed_before);
    }
    result.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_init_removes_only_the_git_folder_it_made() {
        let tmp = tempfile::tempdir().unwrap();

        // made by the failed call: removed, and nothing else
        let made = tmp.path().join("made");
        std::fs::create_dir_all(made.join(".git/objects")).unwrap();
        std::fs::write(made.join("keep.txt"), "x").unwrap();
        remove_new_git_dir(&made, false);
        assert!(!made.join(".git").exists());
        assert!(made.join("keep.txt").exists());

        // it existed before the call: untouched
        let old = tmp.path().join("old");
        std::fs::create_dir_all(old.join(".git")).unwrap();
        remove_new_git_dir(&old, true);
        assert!(old.join(".git").is_dir());

        // a missing `.git` is fine
        remove_new_git_dir(&tmp.path().join("none"), false);

        // a link is never followed or removed
        #[cfg(unix)]
        {
            let linked = tmp.path().join("linked");
            std::fs::create_dir_all(&linked).unwrap();
            let target = tmp.path().join("target-dir");
            std::fs::create_dir_all(&target).unwrap();
            std::os::unix::fs::symlink(&target, linked.join(".git")).unwrap();
            remove_new_git_dir(&linked, false);
            assert!(target.is_dir());
            assert!(std::fs::symlink_metadata(linked.join(".git")).is_ok());
        }
    }
}
