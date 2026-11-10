//! Conflict list, versions, accept side and save resolution, against real repositories.

mod common;

use common::*;
use gitcore::conflicts::{accept_side, conflict_versions, conflicts, save_resolution};
use gitcore::{ops, ConflictSide, Eol, GitError, SideStatus};

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// main and feature both change `f` from "base" (a 3-line file); merging feature into main
/// conflicts.
fn merge_conflict(r: &TestRepo) {
    r.commit_file("f", "one\nbase\nthree\n", "base");
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("f", "one\nTHEIRS\nthree\n", "feature change");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "one\nOURS\nthree\n", "main change");
    let res = ops::merge(&git(), &r.info, "feature", false, false).unwrap();
    assert!(res.conflicts, "{res:?}");
}

fn unmerged(r: &TestRepo) -> String {
    r.sh(&["ls-files", "--unmerged"])
}

#[test]
fn modify_modify_lists_three_versions_and_labels() {
    let r = TestRepo::new();
    let g = git();
    merge_conflict(&r);

    let list = conflicts(&g, &r.info).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, "f");
    assert_eq!(list[0].ours, SideStatus::Modified);
    assert_eq!(list[0].theirs, SideStatus::Modified);
    assert!(!list[0].binary);
    assert!(list[0].old_path.is_none());

    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert_eq!(
        v.base.as_ref().unwrap().text.as_deref(),
        Some("one\nbase\nthree\n")
    );
    assert_eq!(
        v.ours.as_ref().unwrap().text.as_deref(),
        Some("one\nOURS\nthree\n")
    );
    assert_eq!(
        v.theirs.as_ref().unwrap().text.as_deref(),
        Some("one\nTHEIRS\nthree\n")
    );
    assert!(!v.ours.as_ref().unwrap().binary);
    assert_eq!(v.ours.as_ref().unwrap().bytes_len, 15);
    assert!(!v.swapped);
    assert_eq!(v.eol, Eol::Lf);
    assert_eq!(v.labels.ours, "main");
    assert_eq!(v.labels.theirs, "feature");
    assert_eq!(v.labels.base, "Base");
}

#[test]
fn accept_ours_and_theirs_resolve_and_stage() {
    for (side, want) in [
        (ConflictSide::Ours, "one\nOURS\nthree\n"),
        (ConflictSide::Theirs, "one\nTHEIRS\nthree\n"),
    ] {
        let r = TestRepo::new();
        let g = git();
        merge_conflict(&r);
        accept_side(&g, &r.info, &strs(&["f"]), side).unwrap();
        assert_eq!(r.read("f"), want);
        assert_eq!(unmerged(&r), "");
        assert!(!r.sh(&["status", "--short"]).contains("UU"));
        assert!(conflicts(&g, &r.info).unwrap().is_empty());
        // The merge can now be committed.
        let res = ops::op_continue(&g, &r.info).unwrap();
        assert!(res.ok, "{res:?}");
        assert_eq!(r.sh(&["show", "HEAD:f"]) + "\n", want);
    }
}

#[test]
fn add_add_has_no_base() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("keep", "k\n", "init");
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("new", "from feature\n", "add on feature");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("new", "from main\n", "add on main");
    assert!(
        ops::merge(&g, &r.info, "feature", false, false)
            .unwrap()
            .conflicts
    );

    let list = conflicts(&g, &r.info).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(
        (list[0].ours, list[0].theirs),
        (SideStatus::Added, SideStatus::Added)
    );
    let v = conflict_versions(&g, &r.info, "new").unwrap();
    assert!(v.base.is_none());
    assert_eq!(v.ours.unwrap().text.as_deref(), Some("from main\n"));
    assert_eq!(v.theirs.unwrap().text.as_deref(), Some("from feature\n"));
}

/// We delete `f`, they modify it (or the other way round).
fn delete_modify(r: &TestRepo, we_delete: bool) {
    r.commit_file("f", "one\ntwo\n", "base");
    r.commit_file("other", "x\n", "other");
    r.sh(&["checkout", "-qb", "feature"]);
    if we_delete {
        r.commit_file("f", "one\nTWO\n", "feature modifies");
    } else {
        r.sh(&["rm", "-q", "f"]);
        r.sh(&["commit", "-qm", "feature deletes"]);
    }
    r.sh(&["checkout", "-q", "main"]);
    if we_delete {
        r.sh(&["rm", "-q", "f"]);
        r.sh(&["commit", "-qm", "main deletes"]);
    } else {
        r.commit_file("f", "one\nMAIN\n", "main modifies");
    }
    assert!(
        ops::merge(&git(), &r.info, "feature", false, false)
            .unwrap()
            .conflicts
    );
}

#[test]
fn delete_modify_both_ways() {
    // Yours deleted, theirs modified.
    let r = TestRepo::new();
    let g = git();
    delete_modify(&r, true);
    let list = conflicts(&g, &r.info).unwrap();
    assert_eq!(
        (list[0].ours, list[0].theirs),
        (SideStatus::Deleted, SideStatus::Modified)
    );
    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert!(v.ours.is_none());
    assert_eq!(v.theirs.unwrap().text.as_deref(), Some("one\nTWO\n"));
    // Keep the modified file.
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Theirs).unwrap();
    assert_eq!(r.read("f"), "one\nTWO\n");
    assert_eq!(unmerged(&r), "");

    // Accept the deletion: git rm.
    let r = TestRepo::new();
    delete_modify(&r, true);
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Ours).unwrap();
    assert!(!r.path().join("f").exists());
    assert_eq!(unmerged(&r), "");
    // Yours already had it deleted: the index matches HEAD again.
    assert_eq!(r.sh(&["diff", "--cached", "--name-status"]), "");
    assert_eq!(r.sh(&["ls-files", "f"]), "");

    // Yours modified, theirs deleted.
    let r = TestRepo::new();
    delete_modify(&r, false);
    let list = conflicts(&g, &r.info).unwrap();
    assert_eq!(
        (list[0].ours, list[0].theirs),
        (SideStatus::Modified, SideStatus::Deleted)
    );
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Theirs).unwrap();
    assert!(!r.path().join("f").exists());
    assert_eq!(unmerged(&r), "");
    assert_eq!(r.sh(&["diff", "--cached", "--name-status"]), "D\tf");
    let r = TestRepo::new();
    delete_modify(&r, false);
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Ours).unwrap();
    assert_eq!(r.read("f"), "one\nMAIN\n");
    assert_eq!(unmerged(&r), "");
}

#[test]
fn binary_conflict_allows_only_accepting_a_side() {
    let r = TestRepo::new();
    let g = git();
    std::fs::write(r.path().join("img.bin"), [0u8, 1, 2, 3]).unwrap();
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-qm", "base"]);
    r.sh(&["checkout", "-qb", "feature"]);
    std::fs::write(r.path().join("img.bin"), [0u8, 9, 9, 9]).unwrap();
    r.sh(&["commit", "-qam", "feature"]);
    r.sh(&["checkout", "-q", "main"]);
    std::fs::write(r.path().join("img.bin"), [0u8, 7, 7, 7, 7]).unwrap();
    r.sh(&["commit", "-qam", "main"]);
    assert!(
        ops::merge(&g, &r.info, "feature", false, false)
            .unwrap()
            .conflicts
    );

    let list = conflicts(&g, &r.info).unwrap();
    assert!(list[0].binary);
    let v = conflict_versions(&g, &r.info, "img.bin").unwrap();
    for b in [&v.base, &v.ours, &v.theirs] {
        let b = b.as_ref().unwrap();
        assert!(b.binary);
        assert!(b.text.is_none());
    }
    assert_eq!(v.ours.as_ref().unwrap().bytes_len, 5);
    match save_resolution(&g, &r.info, "img.bin", "text", None, true) {
        Err(GitError::Invalid(m)) => assert!(m.contains("binary"), "{m}"),
        other => panic!("unexpected {other:?}"),
    }
    accept_side(&g, &r.info, &strs(&["img.bin"]), ConflictSide::Theirs).unwrap();
    assert_eq!(
        std::fs::read(r.path().join("img.bin")).unwrap(),
        vec![0u8, 9, 9, 9]
    );
    assert_eq!(unmerged(&r), "");
}

#[test]
fn non_utf8_file_has_no_text_and_cannot_be_saved() {
    let r = TestRepo::new();
    let g = git();
    let latin1 = |c: u8| vec![b'c', b'a', b'f', c, b'\n'];
    std::fs::write(r.path().join("l.txt"), latin1(b'e')).unwrap();
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-qm", "base"]);
    r.sh(&["checkout", "-qb", "feature"]);
    std::fs::write(r.path().join("l.txt"), latin1(0xe9)).unwrap();
    r.sh(&["commit", "-qam", "feature"]);
    r.sh(&["checkout", "-q", "main"]);
    std::fs::write(r.path().join("l.txt"), latin1(0xe8)).unwrap();
    r.sh(&["commit", "-qam", "main"]);
    assert!(
        ops::merge(&g, &r.info, "feature", false, false)
            .unwrap()
            .conflicts
    );

    assert!(conflicts(&g, &r.info).unwrap()[0].binary);
    let v = conflict_versions(&g, &r.info, "l.txt").unwrap();
    assert!(v.ours.as_ref().unwrap().text.is_none());
    assert!(v.ours.as_ref().unwrap().binary);
    // The saved text could only come from a lossy decoding: refused.
    assert!(matches!(
        save_resolution(&g, &r.info, "l.txt", "caf\u{fffd}\n", None, true),
        Err(GitError::Invalid(_))
    ));
    // The raw bytes of a side survive accepting it.
    accept_side(&g, &r.info, &strs(&["l.txt"]), ConflictSide::Theirs).unwrap();
    assert_eq!(std::fs::read(r.path().join("l.txt")).unwrap(), latin1(0xe9));
}

#[test]
fn rebase_swaps_yours_and_theirs() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "one\nbase\nthree\n", "base");
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("f", "one\nMINE\nthree\n", "my change");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "one\nUPSTREAM\nthree\n", "upstream change");
    r.sh(&["checkout", "-q", "feature"]);
    let res = ops::rebase(&g, &r.info, "main").unwrap();
    assert!(res.conflicts, "{res:?}");

    // Git's stage 2 is the upstream, stage 3 my commit.
    let raw = unmerged(&r);
    assert!(raw.contains(" 2\tf") && raw.contains(" 3\tf"), "{raw}");
    let stage2 = r.sh(&["show", ":2:f"]);
    assert_eq!(stage2, "one\nUPSTREAM\nthree");

    let list = conflicts(&g, &r.info).unwrap();
    assert_eq!(
        (list[0].ours, list[0].theirs),
        (SideStatus::Modified, SideStatus::Modified)
    );
    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert!(v.swapped);
    // Yours is my commit, theirs the upstream.
    assert_eq!(
        v.ours.as_ref().unwrap().text.as_deref(),
        Some("one\nMINE\nthree\n")
    );
    assert_eq!(
        v.theirs.as_ref().unwrap().text.as_deref(),
        Some("one\nUPSTREAM\nthree\n")
    );
    assert!(v.labels.ours.starts_with("feature ("), "{}", v.labels.ours);
    assert!(v.labels.ours.contains("my change"), "{}", v.labels.ours);
    assert_eq!(v.labels.theirs, "main");

    // Accept Yours keeps my commit's text, and the rebase finishes with it.
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Ours).unwrap();
    assert_eq!(r.read("f"), "one\nMINE\nthree\n");
    let done = ops::op_continue(&g, &r.info).unwrap();
    assert!(done.ok, "{done:?}");
    assert_eq!(r.sh(&["show", "HEAD:f"]), "one\nMINE\nthree");
    assert_eq!(r.sh(&["log", "--format=%s", "-1"]), "my change");
}

#[test]
fn rebase_accept_theirs_keeps_the_upstream_and_delete_sides_follow_the_swap() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "one\nbase\n", "base");
    r.commit_file("g", "g\n", "g");
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("f", "one\nMINE\n", "my change");
    r.sh(&["checkout", "-q", "main"]);
    // Upstream deletes f.
    r.sh(&["rm", "-q", "f"]);
    r.sh(&["commit", "-qm", "upstream deletes f"]);
    r.sh(&["checkout", "-q", "feature"]);
    assert!(ops::rebase(&g, &r.info, "main").unwrap().conflicts);

    let list = conflicts(&g, &r.info).unwrap();
    // Yours (my commit) modified f, theirs (upstream) deleted it.
    assert_eq!(
        (list[0].ours, list[0].theirs),
        (SideStatus::Modified, SideStatus::Deleted)
    );
    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert!(v.theirs.is_none());
    assert_eq!(v.ours.unwrap().text.as_deref(), Some("one\nMINE\n"));
    // Accept Theirs = the upstream's deletion.
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Theirs).unwrap();
    assert!(!r.path().join("f").exists());
    assert_eq!(unmerged(&r), "");
}

#[test]
fn cherry_pick_is_not_swapped() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "one\nbase\nthree\n", "base");
    r.sh(&["checkout", "-qb", "other"]);
    let pick = r.commit_file("f", "one\nPICKED\nthree\n", "picked change");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "one\nHEAD\nthree\n", "head change");
    let res = ops::cherry_pick(&g, &r.info, std::slice::from_ref(&pick)).unwrap();
    assert!(res.conflicts, "{res:?}");

    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert!(!v.swapped);
    assert_eq!(
        v.ours.as_ref().unwrap().text.as_deref(),
        Some("one\nHEAD\nthree\n")
    );
    assert_eq!(
        v.theirs.as_ref().unwrap().text.as_deref(),
        Some("one\nPICKED\nthree\n")
    );
    assert_eq!(v.labels.ours, "main");
    assert!(
        v.labels.theirs.starts_with(&pick[..7]),
        "{}",
        v.labels.theirs
    );
    assert!(v.labels.theirs.contains("picked change"));
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Theirs).unwrap();
    assert_eq!(r.read("f"), "one\nPICKED\nthree\n");
}

#[test]
fn crlf_file_is_saved_with_crlf() {
    let r = TestRepo::new();
    let g = git();
    r.sh(&["config", "core.autocrlf", "false"]);
    r.commit_file("f", "one\r\nbase\r\nthree\r\n", "base");
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("f", "one\r\nTHEIRS\r\nthree\r\n", "feature");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "one\r\nOURS\r\nthree\r\n", "main");
    assert!(
        ops::merge(&g, &r.info, "feature", false, false)
            .unwrap()
            .conflicts
    );

    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert_eq!(v.eol, Eol::Crlf);
    // The editor works with LF and sends LF back.
    save_resolution(&g, &r.info, "f", "one\nBOTH\nthree\n", None, true).unwrap();
    assert_eq!(
        std::fs::read(r.path().join("f")).unwrap(),
        b"one\r\nBOTH\r\nthree\r\n"
    );
    assert_eq!(unmerged(&r), "");
    assert_eq!(r.sh(&["diff", "--cached", "--name-only"]), "f");
}

#[test]
fn utf8_text_round_trips_byte_for_byte() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "caf\u{e9}\nbase\n", "base");
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("f", "caf\u{e9}\nTHEIRS \u{1f600}\n", "feature");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "caf\u{e9}\nOURS\n", "main");
    assert!(
        ops::merge(&g, &r.info, "feature", false, false)
            .unwrap()
            .conflicts
    );
    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert_eq!(
        v.theirs.unwrap().text.as_deref(),
        Some("caf\u{e9}\nTHEIRS \u{1f600}\n")
    );
    save_resolution(
        &g,
        &r.info,
        "f",
        "caf\u{e9}\nTHEIRS \u{1f600}\nOURS\n",
        None,
        true,
    )
    .unwrap();
    assert_eq!(r.read("f"), "caf\u{e9}\nTHEIRS \u{1f600}\nOURS\n");
}

#[test]
fn save_resolution_stages_only_when_resolved() {
    let r = TestRepo::new();
    let g = git();
    merge_conflict(&r);
    let v = conflict_versions(&g, &r.info, "f").unwrap();
    let ours_oid = v.ours.unwrap().oid;

    // Unresolved: the markers are written, the file stays unmerged.
    let with_markers = "one\n<<<<<<< main\nOURS\n=======\nTHEIRS\n>>>>>>> feature\nthree\n";
    save_resolution(&g, &r.info, "f", with_markers, Some(&ours_oid), false).unwrap();
    assert_eq!(r.read("f"), with_markers);
    assert!(unmerged(&r).contains("f"));
    assert_eq!(conflicts(&g, &r.info).unwrap().len(), 1);

    // Resolved: written and staged.
    save_resolution(
        &g,
        &r.info,
        "f",
        "one\nOURS and THEIRS\nthree\n",
        Some(&ours_oid),
        true,
    )
    .unwrap();
    assert_eq!(unmerged(&r), "");
    assert_eq!(r.read("f"), "one\nOURS and THEIRS\nthree\n");
    assert_eq!(r.sh(&["diff", "--cached", "--name-only"]), "f");
}

#[test]
fn save_resolution_refuses_stale_or_resolved_files() {
    let r = TestRepo::new();
    let g = git();
    merge_conflict(&r);
    // A wrong expected oid: the editor loaded something else.
    match save_resolution(
        &g,
        &r.info,
        "f",
        "x\n",
        Some("0123456789012345678901234567890123456789"),
        true,
    ) {
        Err(GitError::Invalid(m)) => assert!(m.contains("changed"), "{m}"),
        other => panic!("unexpected {other:?}"),
    }
    assert!(r.read("f").contains("<<<<<<<"));

    // Once resolved, saving again is refused and the file is not touched.
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Ours).unwrap();
    match save_resolution(&g, &r.info, "f", "other\n", None, true) {
        Err(GitError::Invalid(m)) => assert!(m.contains("no longer in conflict"), "{m}"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(r.read("f"), "one\nOURS\nthree\n");
    // The same for a file that never conflicted, and for accept_side.
    assert!(matches!(
        save_resolution(&g, &r.info, "nope", "x", None, true),
        Err(GitError::Invalid(_))
    ));
    assert!(matches!(
        accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Ours),
        Err(GitError::Invalid(_))
    ));
    assert!(matches!(
        conflict_versions(&g, &r.info, "f"),
        Err(GitError::Invalid(_))
    ));
}

#[test]
fn paths_are_validated() {
    let r = TestRepo::new();
    let g = git();
    merge_conflict(&r);
    for bad in [
        "-f",
        "--ours",
        "../x",
        "/etc/passwd",
        "a/../../x",
        "",
        "a\nb",
    ] {
        assert!(
            matches!(
                accept_side(&g, &r.info, &strs(&[bad]), ConflictSide::Ours),
                Err(GitError::Invalid(_))
            ),
            "accept_side {bad:?}"
        );
        assert!(
            matches!(
                save_resolution(&g, &r.info, bad, "x", None, true),
                Err(GitError::Invalid(_))
            ),
            "save_resolution {bad:?}"
        );
        assert!(
            matches!(
                conflict_versions(&g, &r.info, bad),
                Err(GitError::Invalid(_))
            ),
            "conflict_versions {bad:?}"
        );
    }
    // Nothing happened to the conflict.
    assert_eq!(conflicts(&g, &r.info).unwrap().len(), 1);
    // A pathspec magic string is literal: it is not a conflicted file.
    assert!(matches!(
        accept_side(&g, &r.info, &strs(&[":(glob)*"]), ConflictSide::Ours),
        Err(GitError::Invalid(_))
    ));
}

#[cfg(unix)]
#[test]
fn file_mode_is_kept() {
    use std::os::unix::fs::PermissionsExt;
    let r = TestRepo::new();
    let g = git();
    r.write("run.sh", "#!/bin/sh\necho base\n");
    std::fs::set_permissions(
        r.path().join("run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-qm", "base"]);
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("run.sh", "#!/bin/sh\necho theirs\n", "feature");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("run.sh", "#!/bin/sh\necho ours\n", "main");
    assert!(
        ops::merge(&g, &r.info, "feature", false, false)
            .unwrap()
            .conflicts
    );
    let mode = |r: &TestRepo| {
        std::fs::metadata(r.path().join("run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    };
    let before = mode(&r);
    assert_ne!(before & 0o100, 0, "the worktree file is executable");
    save_resolution(
        &g,
        &r.info,
        "run.sh",
        "#!/bin/sh\necho merged\n",
        None,
        true,
    )
    .unwrap();
    assert_eq!(mode(&r), before);
    assert!(r.sh(&["ls-files", "-s", "run.sh"]).starts_with("100755"));
}

#[test]
fn a_symlink_in_the_way_is_not_written_through() {
    #[cfg(unix)]
    {
        let r = TestRepo::new();
        let g = git();
        merge_conflict(&r);
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("victim");
        std::fs::write(&target, "safe").unwrap();
        std::fs::remove_file(r.path().join("f")).unwrap();
        std::os::unix::fs::symlink(&target, r.path().join("f")).unwrap();
        assert!(save_resolution(&g, &r.info, "f", "pwned\n", None, true).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "safe");
    }
}

#[test]
fn no_conflicts_in_a_clean_repo() {
    let r = TestRepo::new();
    r.commit_file("f", "x\n", "init");
    assert!(conflicts(&git(), &r.info).unwrap().is_empty());
}

#[test]
fn several_files_are_listed_and_accepted_together() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a", "a\n", "a");
    r.commit_file("b", "b\n", "b");
    r.commit_file("dir/c", "c\n", "c");
    r.sh(&["checkout", "-qb", "feature"]);
    r.write("a", "a-feature\n");
    r.write("b", "b-feature\n");
    r.write("dir/c", "c-feature\n");
    r.sh(&["commit", "-qam", "feature"]);
    r.sh(&["checkout", "-q", "main"]);
    r.write("a", "a-main\n");
    r.write("b", "b-main\n");
    r.write("dir/c", "c-main\n");
    r.sh(&["commit", "-qam", "main"]);
    assert!(
        ops::merge(&g, &r.info, "feature", false, false)
            .unwrap()
            .conflicts
    );

    let list = conflicts(&g, &r.info).unwrap();
    assert_eq!(
        list.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
        ["a", "b", "dir/c"]
    );
    accept_side(&g, &r.info, &strs(&["a", "dir/c"]), ConflictSide::Theirs).unwrap();
    assert_eq!(r.read("a"), "a-feature\n");
    assert_eq!(r.read("dir/c"), "c-feature\n");
    assert_eq!(conflicts(&g, &r.info).unwrap().len(), 1);
    // A folder name is not a conflicted path.
    assert!(accept_side(&g, &r.info, &strs(&["dir"]), ConflictSide::Ours).is_err());
}

#[test]
fn json_shape_is_what_the_frontend_expects() {
    let r = TestRepo::new();
    let g = git();
    merge_conflict(&r);
    let entries = serde_json::to_value(conflicts(&g, &r.info).unwrap()).unwrap();
    assert_eq!(
        entries,
        serde_json::json!([{
            "path": "f", "oldPath": null, "ours": "modified", "theirs": "modified", "binary": false
        }])
    );
    let v = serde_json::to_value(conflict_versions(&g, &r.info, "f").unwrap()).unwrap();
    assert_eq!(v["eol"], "lf");
    assert_eq!(v["swapped"], false);
    assert_eq!(v["labels"]["base"], "Base");
    assert_eq!(v["ours"]["bytesLen"], 15);
    assert_eq!(v["ours"]["binary"], false);
    assert_eq!(v["ours"]["text"], "one\nOURS\nthree\n");
    assert_eq!(v["ours"]["oid"].as_str().unwrap().len(), 40);
    // The side argument of accept_side comes as "ours" / "theirs".
    let side: ConflictSide = serde_json::from_str("\"theirs\"").unwrap();
    assert_eq!(side, ConflictSide::Theirs);
    assert!(serde_json::from_str::<ConflictSide>("\"mine\"").is_err());
}
