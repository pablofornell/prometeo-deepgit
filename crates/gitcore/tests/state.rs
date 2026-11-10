mod common;

use common::*;
use gitcore::{state, RepoStateKind};

#[test]
fn detect_checks_marker_files_in_priority_order() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    assert_eq!(state::detect(d), RepoStateKind::Clean);
    std::fs::write(d.join("BISECT_LOG"), "").unwrap();
    assert_eq!(state::detect(d), RepoStateKind::Bisecting);
    std::fs::write(d.join("REVERT_HEAD"), "").unwrap();
    assert_eq!(state::detect(d), RepoStateKind::Reverting);
    std::fs::write(d.join("CHERRY_PICK_HEAD"), "").unwrap();
    assert_eq!(state::detect(d), RepoStateKind::CherryPicking);
    std::fs::create_dir(d.join("rebase-apply")).unwrap();
    assert_eq!(state::detect(d), RepoStateKind::Rebasing);
    std::fs::create_dir(d.join("rebase-merge")).unwrap();
    assert_eq!(state::detect(d), RepoStateKind::Rebasing);
    std::fs::write(d.join("MERGE_HEAD"), "").unwrap();
    assert_eq!(state::detect(d), RepoStateKind::Merging);
}

#[test]
fn git_dir_follows_gitdir_files_for_worktrees() {
    let r = TestRepo::new();
    r.commit_file("a", "1", "one");
    assert_eq!(state::git_dir(r.path()).unwrap(), r.path().join(".git"));

    let wt_parent = tempfile::tempdir().unwrap();
    let wt = wt_parent.path().join("wt");
    r.sh(&["worktree", "add", "-q", "-b", "wtb", wt.to_str().unwrap()]);
    assert!(wt.join(".git").is_file());
    let gd = state::git_dir(&wt).unwrap();
    assert!(gd.ends_with(".git/worktrees/wt"), "{gd:?}");
    assert_eq!(state::repo_state(&wt).unwrap(), RepoStateKind::Clean);

    // A merge conflict in the worktree is detected through its own git dir.
    std::fs::write(wt.join("a"), "wt change").unwrap();
    sh(&wt, &["commit", "-q", "-a", "-m", "wt"], None);
    r.commit_file("a", "main change", "main change");
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&wt)
        .args(["merge", "main"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert_eq!(state::repo_state(&wt).unwrap(), RepoStateKind::Merging);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
}

#[test]
fn not_a_repo_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(
        state::git_dir(dir.path()),
        Err(gitcore::GitError::NotARepo(_))
    ));
}
