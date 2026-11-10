mod common;

use common::*;
use gitcore::{status, FileStatus};

#[test]
fn staged_and_unstaged_same_file_and_untracked() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "1\n2\n", "init");
    r.commit_file("keep.txt", "k\n", "keep");
    r.write("a.txt", "1\n2\n3\n");
    r.sh(&["add", "a.txt"]);
    r.write("a.txt", "1\n2\n3\n4\n5\n");
    r.write("dir/new.txt", "x\n");
    r.write("bin.dat", "a\0b");
    r.sh(&["add", "bin.dat"]);

    let t = status::working_tree(&git(), &r.info).unwrap();
    assert!(t.conflicted.is_empty());
    let staged_a = t.staged.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!(staged_a.status, FileStatus::Modified);
    assert_eq!((staged_a.additions, staged_a.deletions), (Some(1), Some(0)));
    let unstaged_a = t.unstaged.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!(unstaged_a.status, FileStatus::Modified);
    assert_eq!(
        (unstaged_a.additions, unstaged_a.deletions),
        (Some(2), Some(0))
    );
    let bin = t.staged.iter().find(|f| f.path == "bin.dat").unwrap();
    assert_eq!(bin.status, FileStatus::Added);
    assert!(bin.binary);
    let untracked = t.unstaged.iter().find(|f| f.path == "dir/new.txt").unwrap();
    assert_eq!(untracked.status, FileStatus::Untracked);
    assert_eq!(untracked.additions, None);
    assert!(t.staged.iter().all(|f| f.path != "keep.txt"));
}

#[test]
fn rename_and_delete() {
    let r = TestRepo::new();
    r.commit_file("old name.txt", "line one\nline two\nline three\n", "init");
    r.commit_file("gone.txt", "bye\n", "gone");
    r.sh(&["mv", "old name.txt", "new name.txt"]);
    std::fs::remove_file(r.path().join("gone.txt")).unwrap();
    let t = status::working_tree(&git(), &r.info).unwrap();
    let ren = t
        .staged
        .iter()
        .find(|f| f.status == FileStatus::Renamed)
        .unwrap();
    assert_eq!(ren.path, "new name.txt");
    assert_eq!(ren.old_path.as_deref(), Some("old name.txt"));
    assert_eq!((ren.additions, ren.deletions), (Some(0), Some(0)));
    let del = t.unstaged.iter().find(|f| f.path == "gone.txt").unwrap();
    assert_eq!(del.status, FileStatus::Deleted);
    assert_eq!(del.deletions, Some(1));
}

#[test]
fn conflicts_go_only_in_conflicted() {
    let r = TestRepo::new();
    r.commit_file("c.txt", "base\n", "base");
    r.sh(&["checkout", "-q", "-b", "other"]);
    r.commit_file("c.txt", "other\n", "other");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("c.txt", "main\n", "main");
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(r.path())
        .args(["merge", "other"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let t = status::working_tree(&git(), &r.info).unwrap();
    assert_eq!(t.conflicted.len(), 1);
    assert_eq!(t.conflicted[0].path, "c.txt");
    assert_eq!(t.conflicted[0].status, FileStatus::Conflicted);
    assert!(t.staged.is_empty());
    assert!(t.unstaged.is_empty());
}

#[test]
fn parser_handles_paths_with_spaces_and_unknown_codes() {
    let text = "1 .M N... 100644 100644 100644 aaa bbb dir/with space.txt\0? weird name\0";
    let t = status::parse_porcelain_v2(text, "id").unwrap();
    assert_eq!(t.unstaged[0].path, "dir/with space.txt");
    assert_eq!(t.unstaged[1].path, "weird name");
    assert!(status::parse_porcelain_v2("Z what\0", "id").is_err());
}

#[test]
fn clean_repo_is_empty() {
    let r = TestRepo::new();
    let t = status::working_tree(&git(), &r.info).unwrap();
    assert!(t.staged.is_empty() && t.unstaged.is_empty() && t.conflicted.is_empty());
    r.commit_file("a", "1", "one");
    let t = status::working_tree(&git(), &r.info).unwrap();
    assert!(t.staged.is_empty() && t.unstaged.is_empty());
}
