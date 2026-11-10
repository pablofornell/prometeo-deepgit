//! `core.autocrlf=true`, the default of Git for Windows: the repository stores LF and the worktree
//! files have CRLF. The other test files pin `core.autocrlf=false` (see `common::init_at`); these
//! turn it on, on every system, and check that conflicts and hunks leave the worktree in CRLF, the
//! index in LF and nothing "modified" behind.

mod common;

use common::*;
use gitcore::conflicts::{
    accept_side, conflict_versions, conflicts, save_resolution, ExpectedOids,
};
use gitcore::ops::HunkOpts;
use gitcore::{diff, ops, status, ConflictSide, DiffSpec, Eol, GitError, MergeOpts};

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn crlf_repo() -> TestRepo {
    let r = TestRepo::new();
    r.sh(&["config", "core.autocrlf", "true"]);
    r
}

fn bytes(r: &TestRepo, rel: &str) -> String {
    String::from_utf8(std::fs::read(r.path().join(rel)).unwrap()).unwrap()
}

/// The blob of `spec` (`:f` is the index, `HEAD:f` the last commit), bytes untouched.
fn blob(r: &TestRepo, spec: &str) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(r.path())
        .args(["cat-file", "blob", spec])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git cat-file blob {spec}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

/// `git status --porcelain`, one entry per line (not through `sh`, which trims).
fn porcelain(r: &TestRepo) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(r.path())
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// main and feature both change `f`; the files are written with CRLF, as an editor on Windows
/// does. Merging feature into main conflicts.
fn merge_conflict(r: &TestRepo) {
    r.commit_file("f", "one\r\nbase\r\nthree\r\n", "base");
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("f", "one\r\nTHEIRS\r\nthree\r\n", "feature change");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "one\r\nOURS\r\nthree\r\n", "main change");
    assert_eq!(blob(r, "HEAD:f"), "one\nOURS\nthree\n", "git stores LF");
    let res = ops::merge(&git(), &r.info, "feature", &MergeOpts::default()).unwrap();
    assert!(res.conflicts, "{res:?}");
}

fn save(
    g: &gitcore::Git,
    r: &TestRepo,
    path: &str,
    content: &str,
    resolved: bool,
) -> Result<(), GitError> {
    let v = conflict_versions(g, &r.info, path)?;
    let oid = |b: &Option<gitcore::Blob>| b.as_ref().map(|b| b.oid.clone());
    let (ours, theirs, base) = (oid(&v.ours), oid(&v.theirs), oid(&v.base));
    save_resolution(
        g,
        &r.info,
        path,
        content,
        ExpectedOids {
            ours: ours.as_deref(),
            theirs: theirs.as_deref(),
            base: base.as_deref(),
        },
        resolved,
    )
}

#[test]
fn the_versions_are_lf_and_the_file_is_crlf() {
    let r = crlf_repo();
    let g = git();
    merge_conflict(&r);
    assert_eq!(
        bytes(&r, "f"),
        "one\r\n<<<<<<< HEAD\r\nOURS\r\n=======\r\nTHEIRS\r\n>>>>>>> feature\r\nthree\r\n"
    );
    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert_eq!(v.eol, Eol::Crlf, "the line ending of the worktree file");
    assert_eq!(
        v.ours.as_ref().unwrap().text.as_deref(),
        Some("one\nOURS\nthree\n")
    );
    assert_eq!(
        v.theirs.as_ref().unwrap().text.as_deref(),
        Some("one\nTHEIRS\nthree\n")
    );
    assert!(!conflicts(&g, &r.info).unwrap()[0].binary);
}

#[test]
fn a_saved_resolution_is_crlf_in_the_worktree_and_lf_in_the_index() {
    let r = crlf_repo();
    let g = git();
    merge_conflict(&r);

    // not resolved yet: only the file is written, with the markers the editor still holds
    let half = "one\n<<<<<<< HEAD\nOURS\n=======\nTHEIRS\n>>>>>>> feature\nthree\n";
    save(&g, &r, "f", half, false).unwrap();
    assert_eq!(bytes(&r, "f"), half.replace('\n', "\r\n"));
    assert_eq!(conflicts(&g, &r.info).unwrap().len(), 1);

    save(&g, &r, "f", "one\nBOTH\nthree\n", true).unwrap();
    assert_eq!(bytes(&r, "f"), "one\r\nBOTH\r\nthree\r\n");
    assert_eq!(blob(&r, ":f"), "one\nBOTH\nthree\n");
    assert!(conflicts(&g, &r.info).unwrap().is_empty());
    // staged, and the worktree file is not "modified" against the index
    assert_eq!(porcelain(&r), "M  f\n");
    r.sh(&["commit", "-qm", "merged"]);
    assert_eq!(porcelain(&r), "");
}

#[test]
fn accepting_a_side_checks_the_file_out_in_crlf() {
    for (side, text) in [
        (ConflictSide::Ours, "OURS"),
        (ConflictSide::Theirs, "THEIRS"),
    ] {
        let r = crlf_repo();
        let g = git();
        merge_conflict(&r);
        accept_side(&g, &r.info, &strs(&["f"]), side).unwrap();
        assert_eq!(bytes(&r, "f"), format!("one\r\n{text}\r\nthree\r\n"));
        assert_eq!(blob(&r, ":f"), format!("one\n{text}\nthree\n"));
        assert!(conflicts(&g, &r.info).unwrap().is_empty());
        r.sh(&["commit", "-qm", "merged"]);
        assert_eq!(porcelain(&r), "");
    }
}

#[test]
fn a_resolution_is_crlf_also_when_the_worktree_file_is_gone() {
    let r = crlf_repo();
    let g = git();
    merge_conflict(&r);
    // nothing in the worktree says CRLF, and the three versions in the repository are LF
    std::fs::remove_file(r.path().join("f")).unwrap();
    assert_eq!(conflict_versions(&g, &r.info, "f").unwrap().eol, Eol::Crlf);
    save(&g, &r, "f", "one\nBOTH\nthree\n", true).unwrap();
    assert_eq!(bytes(&r, "f"), "one\r\nBOTH\r\nthree\r\n");
    assert_eq!(blob(&r, ":f"), "one\nBOTH\nthree\n");
    r.sh(&["commit", "-qm", "merged"]);
    assert_eq!(porcelain(&r), "");
}

#[test]
fn a_file_committed_with_crlf_keeps_crlf_in_the_repository() {
    // The file went in before autocrlf was on: its blobs hold CRLF and git leaves such a file
    // alone. A resolution must not turn the blob into LF (the whole file would show as changed).
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "one\r\nbase\r\nthree\r\n", "base");
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("f", "one\r\nTHEIRS\r\nthree\r\n", "feature change");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "one\r\nOURS\r\nthree\r\n", "main change");
    assert_eq!(blob(&r, "HEAD:f"), "one\r\nOURS\r\nthree\r\n");
    r.sh(&["config", "core.autocrlf", "true"]);
    let res = ops::merge(&g, &r.info, "feature", &MergeOpts::default()).unwrap();
    assert!(res.conflicts, "{res:?}");

    assert_eq!(conflict_versions(&g, &r.info, "f").unwrap().eol, Eol::Crlf);
    save(&g, &r, "f", "one\nBOTH\nthree\n", true).unwrap();
    assert_eq!(bytes(&r, "f"), "one\r\nBOTH\r\nthree\r\n");
    assert_eq!(blob(&r, ":f"), "one\r\nBOTH\r\nthree\r\n");
    r.sh(&["commit", "-qm", "merged"]);
    assert_eq!(porcelain(&r), "");
}

// ---------------------------------------------------------------- hunks

fn numbered(n: usize) -> String {
    (0..n).map(|i| format!("l{i}\n")).collect()
}

#[test]
fn hunks_are_staged_unstaged_and_discarded_in_a_crlf_worktree() {
    let r = crlf_repo();
    let g = git();
    let crlf = |s: &str| s.replace('\n', "\r\n");
    let base = numbered(20);
    r.commit_file("f.txt", &crlf(&base), "init");
    assert_eq!(blob(&r, "HEAD:f.txt"), base);
    let changed = base.replace("l1\n", "L1\n").replace("l18\n", "L18\n");
    r.write("f.txt", &crlf(&changed));

    let hunks = |spec: DiffSpec| {
        diff::file_diff(&g, &r.info, &spec, "f.txt", None, 3)
            .unwrap()
            .hunks
    };
    let unstaged = hunks(DiffSpec::Unstaged);
    assert_eq!(unstaged.len(), 2, "only the two changed lines differ");
    assert!(
        unstaged
            .iter()
            .flat_map(|h| &h.lines)
            .all(|l| !l.text.ends_with('\r')),
        "the diff shows no carriage returns: {unstaged:?}"
    );

    // stage the second hunk: the index gets it in LF, the worktree is untouched
    ops::stage_hunk(&g, &r.info, "f.txt", 1, false, &HunkOpts::default()).unwrap();
    assert_eq!(blob(&r, ":f.txt"), base.replace("l18\n", "L18\n"));
    assert_eq!(bytes(&r, "f.txt"), crlf(&changed));
    assert_eq!(hunks(DiffSpec::Staged).len(), 1);
    assert_eq!(hunks(DiffSpec::Unstaged).len(), 1);

    // discard the other one: that line goes back, the file stays CRLF
    ops::discard_hunk(&g, &r.info, "f.txt", 0, &HunkOpts::default()).unwrap();
    assert_eq!(bytes(&r, "f.txt"), crlf(&base.replace("l18\n", "L18\n")));
    assert_eq!(porcelain(&r), "M  f.txt\n");

    // unstage the staged hunk again: the index is the commit, the change is back in the worktree
    ops::stage_hunk(&g, &r.info, "f.txt", 0, true, &HunkOpts::default()).unwrap();
    assert_eq!(blob(&r, ":f.txt"), base);
    assert_eq!(porcelain(&r), " M f.txt\n");
    let t = status::working_tree(&g, &r.info).unwrap();
    assert!(t.staged.is_empty());
    assert_eq!(t.unstaged.len(), 1);

    // discarding the whole file gives the committed text back, in CRLF
    ops::discard(&g, &r.info, &strs(&["f.txt"])).unwrap();
    assert_eq!(bytes(&r, "f.txt"), crlf(&base));
    assert_eq!(porcelain(&r), "");
}
