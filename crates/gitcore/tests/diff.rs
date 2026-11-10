mod common;

use common::*;
use gitcore::diff::{self, parse_unified};
use gitcore::{DiffSpec, FileStatus, LineKind};

#[test]
fn parses_multiple_hunks_with_line_numbers() {
    let text = "diff --git a/f.txt b/f.txt\nindex 111..222 100644\n--- a/f.txt\n+++ b/f.txt\n\
@@ -1,3 +1,3 @@ fn one()\n a\n-b\n+B\n c\n@@ -10,2 +10,3 @@\n x\n+y\n z\n";
    let d = parse_unified(text, "f.txt", None).unwrap();
    assert!(!d.binary && !d.too_large);
    assert_eq!(d.hunks.len(), 2);
    let h = &d.hunks[0];
    assert_eq!(
        (h.old_start, h.old_lines, h.new_start, h.new_lines),
        (1, 3, 1, 3)
    );
    assert_eq!(h.header, "fn one()");
    let kinds: Vec<LineKind> = h.lines.iter().map(|l| l.kind).collect();
    assert_eq!(
        kinds,
        vec![
            LineKind::Context,
            LineKind::Del,
            LineKind::Add,
            LineKind::Context
        ]
    );
    assert_eq!((h.lines[1].old_no, h.lines[1].new_no), (Some(2), None));
    assert_eq!((h.lines[2].old_no, h.lines[2].new_no), (None, Some(2)));
    assert_eq!((h.lines[3].old_no, h.lines[3].new_no), (Some(3), Some(3)));
    assert_eq!(h.lines[1].text, "b");
    let h2 = &d.hunks[1];
    assert_eq!(h2.header, "");
    assert_eq!(
        (h2.old_start, h2.old_lines, h2.new_start, h2.new_lines),
        (10, 2, 10, 3)
    );
    assert_eq!(h2.lines[1].new_no, Some(11));
}

#[test]
fn hunk_header_without_counts_means_one_line() {
    let text = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n";
    let d = parse_unified(text, "f", None).unwrap();
    assert_eq!(d.hunks[0].old_lines, 1);
    assert_eq!(d.hunks[0].new_lines, 1);
    assert_eq!(d.hunks[0].lines.len(), 2);
}

#[test]
fn no_newline_marker_is_not_a_line_and_text_may_lack_trailing_newline() {
    let text = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file";
    let d = parse_unified(text, "f", None).unwrap();
    assert_eq!(d.hunks.len(), 1);
    let lines = &d.hunks[0].lines;
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[2].kind, LineKind::Add);
    assert_eq!(lines[2].text, "c");
}

#[test]
fn content_lines_that_look_like_headers_stay_in_the_hunk() {
    // The removed line "-- x" shows up as "--- x"; counts decide where the hunk ends.
    let text = "--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n--- x\n a\n";
    let d = parse_unified(text, "f", None).unwrap();
    assert_eq!(d.hunks[0].lines[0].kind, LineKind::Del);
    assert_eq!(d.hunks[0].lines[0].text, "-- x");
}

#[test]
fn binary_files_differ() {
    let text =
        "diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n";
    let d = parse_unified(text, "i.png", None).unwrap();
    assert!(d.binary);
    assert!(d.hunks.is_empty());
}

#[test]
fn empty_diff_and_garbage_hunk() {
    let d = parse_unified("", "f", None).unwrap();
    assert!(d.hunks.is_empty() && !d.binary);
    assert!(parse_unified("@@ nonsense @@\n", "f", None).is_err());
}

#[test]
fn new_file_diff_from_dev_null() {
    let text = "diff --git a/n b/n\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+one\n+two\n";
    let d = parse_unified(text, "n", None).unwrap();
    assert_eq!(d.hunks[0].old_lines, 0);
    assert_eq!(d.hunks[0].lines[0].new_no, Some(1));
    assert_eq!(d.hunks[0].lines[1].new_no, Some(2));
}

#[test]
fn name_status_parser_handles_renames() {
    let files = diff::parse_name_status("M\0a.txt\0R100\0old.txt\0new.txt\0A\0b.txt\0").unwrap();
    assert_eq!(files.len(), 3);
    assert_eq!(files[1].status, FileStatus::Renamed);
    assert_eq!(files[1].path, "new.txt");
    assert_eq!(files[1].old_path.as_deref(), Some("old.txt"));
    assert!(diff::parse_name_status("Q\0x\0").is_err());
}

#[test]
fn commit_details_lists_files_with_counts_and_handles_root_and_merge() {
    let r = TestRepo::new();
    let root = r.commit_file(
        "a.txt",
        "1\n2\n3\n",
        "root commit\n\nbody line one\nbody line two",
    );
    r.write("bin.dat", "x\0y");
    let second = r.commit_file("a.txt", "1\nTWO\n3\n4\n", "second");
    r.sh(&["mv", "a.txt", "b.txt"]);
    r.sh(&["commit", "-q", "-m", "rename"]);
    let rename = r.head();
    let g = git();

    let d = diff::commit_details(&g, &r.info, &root).unwrap();
    assert_eq!(d.oid, root);
    assert!(d.parents.is_empty());
    assert_eq!(d.subject, "root commit");
    assert_eq!(d.body, "body line one\nbody line two");
    assert_eq!(d.author.name, "Test");
    assert_eq!(d.author.email, "test@example.com");
    assert_eq!(d.author.tz.len(), 5);
    assert!(d.refs.is_empty());
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].status, FileStatus::Added);
    assert_eq!(d.files[0].additions, Some(3));

    let d = diff::commit_details(&g, &r.info, &second).unwrap();
    let a = d.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!(
        (a.status, a.additions, a.deletions),
        (FileStatus::Modified, Some(2), Some(1))
    );
    let bin = d.files.iter().find(|f| f.path == "bin.dat").unwrap();
    assert!(bin.binary);

    let d = diff::commit_details(&g, &r.info, &rename).unwrap();
    assert!(d.refs.iter().any(|l| l.name == "main" && l.is_current));
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].status, FileStatus::Renamed);
    assert_eq!(d.files[0].old_path.as_deref(), Some("a.txt"));
    assert_eq!(d.files[0].path, "b.txt");

    // A merge commit is shown against its first parent.
    r.sh(&["checkout", "-q", "-b", "feat", &root]);
    r.commit_file("f.txt", "f\n", "feat commit");
    r.sh(&["checkout", "-q", "main"]);
    r.sh(&["merge", "--no-ff", "-q", "-m", "merge feat", "feat"]);
    let d = diff::commit_details(&g, &r.info, &r.head()).unwrap();
    assert_eq!(d.parents.len(), 2);
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].path, "f.txt");
}

#[test]
fn file_diff_for_commit_root_staged_unstaged_and_untracked() {
    let r = TestRepo::new();
    let root = r.commit_file("a.txt", "one\ntwo\nthree\n", "root");
    let second = r.commit_file("a.txt", "one\n2\nthree\n", "second");
    let g = git();

    let d = diff::file_diff(
        &g,
        &r.info,
        &DiffSpec::Commit {
            oid: root.clone(),
            parent: None,
        },
        "a.txt",
        None,
        3,
    )
    .unwrap();
    assert_eq!(d.hunks.len(), 1);
    assert_eq!(d.hunks[0].old_lines, 0);
    assert_eq!(d.hunks[0].new_lines, 3);

    let d = diff::file_diff(
        &g,
        &r.info,
        &DiffSpec::Commit {
            oid: second.clone(),
            parent: None,
        },
        "a.txt",
        None,
        0,
    )
    .unwrap();
    assert_eq!(d.hunks.len(), 1);
    assert_eq!(d.hunks[0].lines.len(), 2);

    // Explicit parent.
    let d = diff::file_diff(
        &g,
        &r.info,
        &DiffSpec::Commit {
            oid: second,
            parent: Some(root),
        },
        "a.txt",
        None,
        3,
    )
    .unwrap();
    assert_eq!(d.hunks.len(), 1);

    r.write("a.txt", "one\n2\nthree\nfour\n");
    let d = diff::file_diff(&g, &r.info, &DiffSpec::Unstaged, "a.txt", None, 3).unwrap();
    assert_eq!(d.hunks.len(), 1);
    assert!(
        diff::file_diff(&g, &r.info, &DiffSpec::Staged, "a.txt", None, 3)
            .unwrap()
            .hunks
            .is_empty()
    );
    r.sh(&["add", "a.txt"]);
    assert_eq!(
        diff::file_diff(&g, &r.info, &DiffSpec::Staged, "a.txt", None, 3)
            .unwrap()
            .hunks
            .len(),
        1
    );

    r.write("new.txt", "hello\nworld\n");
    let d = diff::file_diff(&g, &r.info, &DiffSpec::Unstaged, "new.txt", None, 3).unwrap();
    assert_eq!(d.hunks.len(), 1);
    assert_eq!(d.hunks[0].new_lines, 2);
    assert_eq!(d.hunks[0].lines[0].text, "hello");
}

#[test]
fn file_diff_marks_binary_and_too_large() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "x\n", "root");
    r.write("b.bin", "a\0b\0c");
    let g = git();
    let d = diff::file_diff(&g, &r.info, &DiffSpec::Unstaged, "b.bin", None, 3).unwrap();
    assert!(d.binary);

    let big: String = (0..21_000).map(|i| format!("line {i}\n")).collect();
    r.write("big.txt", &big);
    let d = diff::file_diff(&g, &r.info, &DiffSpec::Unstaged, "big.txt", None, 3).unwrap();
    assert!(d.too_large);
    assert!(d.hunks.is_empty());
}

#[test]
fn file_content_and_last_commit_message() {
    let r = TestRepo::new();
    let g = git();
    assert_eq!(diff::last_commit_message(&g, &r.info).unwrap(), "");
    let c = r.commit_file("a.txt", "committed\n", "first line\n\nmore text");
    r.write("a.txt", "worktree\n");
    assert_eq!(
        diff::file_content(&g, &r.info, Some(&c), "a.txt").unwrap(),
        "committed\n"
    );
    assert_eq!(
        diff::file_content(&g, &r.info, None, "a.txt").unwrap(),
        "worktree\n"
    );
    assert!(diff::file_content(&g, &r.info, None, "../x").is_err());
    assert_eq!(
        diff::last_commit_message(&g, &r.info).unwrap(),
        "first line\n\nmore text"
    );

    let big = "x".repeat(diff::MAX_CONTENT_BYTES + 1000);
    r.write("big.txt", &big);
    assert_eq!(
        diff::file_content(&g, &r.info, None, "big.txt")
            .unwrap()
            .len(),
        diff::MAX_CONTENT_BYTES
    );
}
