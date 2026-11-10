//! Conflict list, versions, accept side and save resolution, against real repositories.

mod common;

use common::*;
use gitcore::conflicts::{
    accept_side, conflict_versions, conflicts, save_resolution, ExpectedOids,
};
use gitcore::{ops, ConflictSide, Eol, GitError, MergeOpts, SideStatus};

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
    let res = ops::merge(&git(), &r.info, "feature", &MergeOpts::default()).unwrap();
    assert!(res.conflicts, "{res:?}");
}

/// `save_resolution` with the oids of the versions as they are now (what an up to date editor sends).
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
        ops::merge(&g, &r.info, "feature", &MergeOpts::default())
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
        ops::merge(&git(), &r.info, "feature", &MergeOpts::default())
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
        ops::merge(&g, &r.info, "feature", &MergeOpts::default())
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
    match save(&g, &r, "img.bin", "text", true) {
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
        ops::merge(&g, &r.info, "feature", &MergeOpts::default())
            .unwrap()
            .conflicts
    );

    assert!(conflicts(&g, &r.info).unwrap()[0].binary);
    let v = conflict_versions(&g, &r.info, "l.txt").unwrap();
    assert!(v.ours.as_ref().unwrap().text.is_none());
    assert!(v.ours.as_ref().unwrap().binary);
    // The saved text could only come from a lossy decoding: refused.
    assert!(matches!(
        save(&g, &r, "l.txt", "caf\u{fffd}\n", true),
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
        ops::merge(&g, &r.info, "feature", &MergeOpts::default())
            .unwrap()
            .conflicts
    );

    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert_eq!(v.eol, Eol::Crlf);
    // The editor works with LF and sends LF back.
    save(&g, &r, "f", "one\nBOTH\nthree\n", true).unwrap();
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
        ops::merge(&g, &r.info, "feature", &MergeOpts::default())
            .unwrap()
            .conflicts
    );
    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert_eq!(
        v.theirs.unwrap().text.as_deref(),
        Some("caf\u{e9}\nTHEIRS \u{1f600}\n")
    );
    save(&g, &r, "f", "caf\u{e9}\nTHEIRS \u{1f600}\nOURS\n", true).unwrap();
    assert_eq!(r.read("f"), "caf\u{e9}\nTHEIRS \u{1f600}\nOURS\n");
}

#[test]
fn save_resolution_stages_only_when_resolved() {
    let r = TestRepo::new();
    let g = git();
    merge_conflict(&r);
    // Unresolved: the markers are written, the file stays unmerged.
    let with_markers = "one\n<<<<<<< main\nOURS\n=======\nTHEIRS\n>>>>>>> feature\nthree\n";
    save(&g, &r, "f", with_markers, false).unwrap();
    assert_eq!(r.read("f"), with_markers);
    assert!(unmerged(&r).contains("f"));
    assert_eq!(conflicts(&g, &r.info).unwrap().len(), 1);

    // Resolved: written and staged.
    save(&g, &r, "f", "one\nOURS and THEIRS\nthree\n", true).unwrap();
    assert_eq!(unmerged(&r), "");
    assert_eq!(r.read("f"), "one\nOURS and THEIRS\nthree\n");
    assert_eq!(r.sh(&["diff", "--cached", "--name-only"]), "f");
}

#[test]
fn save_resolution_refuses_stale_or_resolved_files() {
    let r = TestRepo::new();
    let g = git();
    merge_conflict(&r);
    // A wrong expected oid, of any of the three versions: the editor loaded something else.
    let v = conflict_versions(&g, &r.info, "f").unwrap();
    let real = |b: &Option<gitcore::Blob>| b.as_ref().unwrap().oid.clone();
    let (ours, theirs, base) = (real(&v.ours), real(&v.theirs), real(&v.base));
    let wrong = "0123456789012345678901234567890123456789";
    let expect = |o: &str, t: &str, b: Option<&str>| {
        save_resolution(
            &g,
            &r.info,
            "f",
            "x\n",
            ExpectedOids {
                ours: Some(o),
                theirs: Some(t),
                base: b,
            },
            true,
        )
    };
    for (what, result) in [
        ("yours", expect(wrong, &theirs, Some(&base))),
        ("theirs", expect(&ours, wrong, Some(&base))),
        ("base", expect(&ours, &theirs, Some(wrong))),
        ("a missing base", expect(&ours, &theirs, None)),
    ] {
        match result {
            Err(GitError::Invalid(m)) => assert!(m.contains("changed"), "{what}: {m}"),
            other => panic!("{what}: unexpected {other:?}"),
        }
        assert!(
            r.read("f").contains("<<<<<<<"),
            "{what}: the file was written"
        );
    }
    // An omitted id means "absent": refused while the version exists.
    assert!(matches!(
        save_resolution(&g, &r.info, "f", "x\n", ExpectedOids::default(), true),
        Err(GitError::Invalid(_))
    ));

    // Once resolved, saving again is refused and the file is not touched.
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Ours).unwrap();
    match save_resolution(&g, &r.info, "f", "other\n", ExpectedOids::default(), true) {
        Err(GitError::Invalid(m)) => assert!(m.contains("no longer in conflict"), "{m}"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(r.read("f"), "one\nOURS\nthree\n");
    // The same for a file that never conflicted, and for accept_side.
    assert!(matches!(
        save_resolution(&g, &r.info, "nope", "x", ExpectedOids::default(), true),
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
    for bad in ["../x", "/etc/passwd", "a/../../x", "", "a\nb"] {
        assert!(
            matches!(
                accept_side(&g, &r.info, &strs(&[bad]), ConflictSide::Ours),
                Err(GitError::Invalid(_))
            ),
            "accept_side {bad:?}"
        );
        assert!(
            matches!(
                save_resolution(&g, &r.info, bad, "x", ExpectedOids::default(), true),
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

// Unix only: Windows has no executable bit (git keeps the mode in the index there).
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
        ops::merge(&g, &r.info, "feature", &MergeOpts::default())
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
    save(&g, &r, "run.sh", "#!/bin/sh\necho merged\n", true).unwrap();
    assert_eq!(mode(&r), before);
    assert!(r.sh(&["ls-files", "-s", "run.sh"]).starts_with("100755"));
}

#[test]
fn a_symlink_in_the_way_is_not_written_through() {
    // Unix only: making a symlink on Windows needs a privilege that a normal user does not have.
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
        assert!(save(&g, &r, "f", "pwned\n", true).is_err());
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
        ops::merge(&g, &r.info, "feature", &MergeOpts::default())
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

// ---------------------------------------------------------------- not every conflict in a stopped rebase is the rebase's

/// `git stash pop`, which exits 1 when it conflicts.
fn pop_stash(r: &TestRepo) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(r.path())
        .args(["stash", "pop"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("CONFLICT"),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
}

/// `topic` has two commits on top of `base` (T1 touches `f`, T2 adds `b.txt`) and `main` changed `f` and
/// `g` too. Starts `rebase -i main` stopping after T1 is replayed (an `edit` stop: no conflict).
/// A stash made on `topic` before holds a change of `g`; `other` has a commit that changes `f`.
fn rebase_stopped_at_edit() -> (TestRepo, String) {
    let r = TestRepo::new();
    r.sh(&["config", "core.autocrlf", "false"]);
    r.write("g", "g-base\n");
    r.commit_file("f", "one\nbase\nthree\n", "base");
    r.sh(&["checkout", "-qb", "other"]);
    let pick = r.commit_file("f", "one\nPICKED\nthree\n", "picked change");
    r.sh(&["checkout", "-q", "main"]);
    r.sh(&["checkout", "-qb", "topic"]);
    r.commit_file("a.txt", "t1\n", "T1");
    r.commit_file("b.txt", "t2\n", "T2");
    r.write("g", "g-STASHED\n");
    r.sh(&["stash", "push", "-q"]);
    r.sh(&["checkout", "-q", "main"]);
    r.write("g", "g-HEAD\n");
    r.commit_file("f", "one\nHEAD\nthree\n", "main change of f and g");
    r.sh(&["checkout", "-q", "topic"]);
    // `-i.bak` is the one spelling of "in place" that GNU sed (Linux, Git for Windows) and BSD
    // sed (macOS) both take; it leaves a `git-rebase-todo.bak` in the rebase folder.
    r.sh(&[
        "-c",
        "sequence.editor=sed -i.bak -e 1s/^pick/edit/",
        "rebase",
        "-i",
        "main",
    ]);
    assert_eq!(
        gitcore::state::repo_state(r.path()).unwrap(),
        gitcore::RepoStateKind::Rebasing
    );
    (r, pick)
}

#[test]
fn a_cherry_pick_made_while_a_rebase_is_stopped_is_not_swapped() {
    let (r, pick) = rebase_stopped_at_edit();
    let g = git();
    // the stop is at `edit`: this conflict is the cherry-pick's, not the rebase's
    let res = ops::cherry_pick(&g, &r.info, std::slice::from_ref(&pick)).unwrap();
    assert!(res.conflicts, "{res:?}");
    assert!(r.path().join(".git/CHERRY_PICK_HEAD").exists());
    // the repo is in a cherry-pick (continue / abort act on it), the rebase waits underneath
    assert_eq!(
        gitcore::state::repo_state(r.path()).unwrap(),
        gitcore::RepoStateKind::CherryPicking
    );

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
    assert!(v.labels.theirs.contains("picked change"), "{:?}", v.labels);
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Theirs).unwrap();
    assert_eq!(r.read("f"), "one\nPICKED\nthree\n");
}

#[test]
fn a_revert_made_while_a_rebase_is_stopped_is_not_swapped() {
    let (r, pick) = rebase_stopped_at_edit();
    let g = git();
    // reverting the commit that changed `f` from base to PICKED: HEAD has another text there
    let res = ops::revert(&g, &r.info, &pick).unwrap();
    assert!(res.conflicts, "{res:?}");
    assert_eq!(
        gitcore::state::repo_state(r.path()).unwrap(),
        gitcore::RepoStateKind::Reverting
    );
    let v = conflict_versions(&g, &r.info, "f").unwrap();
    assert!(!v.swapped);
    assert_eq!(
        v.ours.as_ref().unwrap().text.as_deref(),
        Some("one\nHEAD\nthree\n")
    );
}

#[test]
fn a_stash_pop_while_a_rebase_is_stopped_is_not_swapped() {
    // at an `edit` stop (no REBASE_HEAD) and, below, while a conflict of the rebase is open
    let (r, _) = rebase_stopped_at_edit();
    let g = git();
    pop_stash(&r);
    assert_eq!(unmerged(&r).lines().count(), 3, "{}", unmerged(&r));
    let v = conflict_versions(&g, &r.info, "g").unwrap();
    assert!(!v.swapped, "a stash pop at an edit stop");
    assert_eq!(
        v.ours.as_ref().unwrap().text.as_deref(),
        Some("g-HEAD\n"),
        "Yours is the checked-out text"
    );
    assert_eq!(
        v.theirs.as_ref().unwrap().text.as_deref(),
        Some("g-STASHED\n")
    );
    let list = conflicts(&g, &r.info).unwrap();
    assert!(list.iter().all(|c| c.path == "g"));
}

#[test]
fn in_a_rebase_conflict_a_stash_pop_is_told_from_the_rebases_own_files() {
    let r = TestRepo::new();
    let g = git();
    r.sh(&["config", "core.autocrlf", "false"]);
    r.write("g", "g-base\n");
    r.commit_file("f", "one\nbase\nthree\n", "base");
    r.sh(&["checkout", "-qb", "topic"]);
    r.commit_file("f", "one\nMINE\nthree\n", "my change");
    r.write("g", "g-STASHED\n");
    r.sh(&["stash", "push", "-q"]);
    r.sh(&["checkout", "-q", "main"]);
    r.write("g", "g-HEAD\n");
    r.commit_file("f", "one\nUPSTREAM\nthree\n", "main change of f and g");
    r.sh(&["checkout", "-q", "topic"]);
    let res = ops::rebase(&g, &r.info, "main").unwrap();
    assert!(res.conflicts, "{res:?}");

    // the rebase's own conflict is swapped ...
    assert!(conflict_versions(&g, &r.info, "f").unwrap().swapped);
    // ... resolve it (staged), then pop the stash: its conflict in `g` is not
    accept_side(&g, &r.info, &strs(&["f"]), ConflictSide::Ours).unwrap();
    pop_stash(&r);
    let v = conflict_versions(&g, &r.info, "g").unwrap();
    assert!(!v.swapped);
    assert_eq!(v.ours.as_ref().unwrap().text.as_deref(), Some("g-HEAD\n"));
    assert_eq!(
        v.theirs.as_ref().unwrap().text.as_deref(),
        Some("g-STASHED\n")
    );
    let list = conflicts(&g, &r.info).unwrap();
    assert_eq!(list.len(), 1);
    // Accept Theirs of the stash conflict keeps the stash's text (stage 3), not the upstream's
    accept_side(&g, &r.info, &strs(&["g"]), ConflictSide::Theirs).unwrap();
    assert_eq!(r.read("g"), "g-STASHED\n");
}

// ---------------------------------------------------------------- submodules and symlinks

/// `sub` is a submodule whose commit diverges: main points at `c2`, feature at `c3` (both children
/// of `c1`). Merging feature into main conflicts on the gitlink. Returns (repo, c2, c3).
fn submodule_conflict() -> (TestRepo, String, String) {
    let r = TestRepo::new();
    let lib = tempfile::tempdir().unwrap();
    sh(lib.path(), &["init", "-q", "-b", "main", "."], None);
    std::fs::write(lib.path().join("l"), "1\n").unwrap();
    sh(lib.path(), &["add", "l"], None);
    sh(lib.path(), &["commit", "-qm", "c1"], None);
    let c1 = sh(lib.path(), &["rev-parse", "HEAD"], None);
    let commit = |name: &str| {
        sh(lib.path(), &["checkout", "-q", "-b", name, &c1], None);
        std::fs::write(lib.path().join("l"), format!("{name}\n")).unwrap();
        sh(lib.path(), &["commit", "-qam", name], None);
        sh(lib.path(), &["rev-parse", "HEAD"], None)
    };
    let c2 = commit("c2");
    let c3 = commit("c3");
    sh(lib.path(), &["checkout", "-q", &c1], None);

    r.commit_file("keep", "x\n", "init");
    r.sh(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        &lib.path().to_string_lossy(),
        "sub",
    ]);
    r.sh(&["commit", "-qm", "add sub at c1"]);
    r.sh(&["checkout", "-qb", "feature"]);
    sh(&r.path().join("sub"), &["checkout", "-q", &c3], None);
    r.sh(&["commit", "-qam", "sub to c3"]);
    r.sh(&["checkout", "-q", "main"]);
    sh(&r.path().join("sub"), &["checkout", "-q", &c2], None);
    r.sh(&["commit", "-qam", "sub to c2"]);
    // the merge needs the submodule commits of the other side: they are in the same clone
    let res = ops::merge(&git(), &r.info, "feature", &MergeOpts::default()).unwrap();
    assert!(res.conflicts, "{res:?}");
    std::mem::forget(lib); // the submodule's origin must outlive the test body
    (r, c2, c3)
}

fn gitlink_oid(r: &TestRepo) -> String {
    r.sh(&["ls-files", "-s", "sub"])
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_string()
}

#[test]
fn accept_theirs_on_a_submodule_conflict_takes_their_commit_and_leaves_the_checkout_alone() {
    let (r, c2, c3) = submodule_conflict();
    let g = git();
    let raw = unmerged(&r);
    assert!(raw.contains("160000") && raw.contains(" 3\tsub"), "{raw}");
    // not text: only Accept Yours / Theirs
    assert!(conflicts(&g, &r.info).unwrap()[0].binary);

    accept_side(&g, &r.info, &strs(&["sub"]), ConflictSide::Theirs).unwrap();
    assert_eq!(unmerged(&r), "");
    assert_eq!(gitlink_oid(&r), c3, "the index records Theirs' commit");
    // the submodule's own checkout still is where it was: only the index moved
    assert_eq!(sh(&r.path().join("sub"), &["rev-parse", "HEAD"], None), c2);
}

#[test]
fn accept_yours_on_a_submodule_conflict_records_your_commit() {
    let (r, c2, _) = submodule_conflict();
    accept_side(&git(), &r.info, &strs(&["sub"]), ConflictSide::Ours).unwrap();
    assert_eq!(unmerged(&r), "");
    assert_eq!(gitlink_oid(&r), c2);
}

#[test]
fn deleting_a_submodule_side_keeps_the_submodule_checkout() {
    // main deletes the submodule, feature moves it: Accept Yours = delete, only from the index
    let r = TestRepo::new();
    let g = git();
    let lib = tempfile::tempdir().unwrap();
    sh(lib.path(), &["init", "-q", "-b", "main", "."], None);
    std::fs::write(lib.path().join("l"), "1\n").unwrap();
    sh(lib.path(), &["add", "l"], None);
    sh(lib.path(), &["commit", "-qm", "c1"], None);
    std::fs::write(lib.path().join("l"), "2\n").unwrap();
    sh(lib.path(), &["commit", "-qam", "c2"], None);
    let c1 = sh(lib.path(), &["rev-parse", "HEAD~1"], None);
    sh(lib.path(), &["checkout", "-q", &c1], None);
    r.commit_file("keep", "x\n", "init");
    r.sh(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        &lib.path().to_string_lossy(),
        "sub",
    ]);
    r.sh(&["commit", "-qm", "add sub"]);
    r.sh(&["checkout", "-qb", "feature"]);
    sh(&r.path().join("sub"), &["checkout", "-q", "main"], None);
    r.sh(&["commit", "-qam", "sub moves"]);
    r.sh(&["checkout", "-q", "main"]);
    r.sh(&["rm", "-q", "-f", "sub"]);
    r.sh(&["commit", "-qm", "sub removed"]);
    let res = ops::merge(&g, &r.info, "feature", &MergeOpts::default()).unwrap();
    assert!(res.conflicts, "{res:?}");
    // the checkout of the moved submodule is back in the worktree
    std::fs::create_dir_all(r.path().join("sub")).unwrap();
    std::fs::write(r.path().join("sub/kept-file"), "x").unwrap();

    accept_side(&g, &r.info, &strs(&["sub"]), ConflictSide::Ours).unwrap();
    assert_eq!(unmerged(&r), "");
    assert_eq!(r.sh(&["ls-files", "sub"]), "", "deleted from the index");
    assert!(
        r.path().join("sub/kept-file").exists(),
        "the worktree was not touched"
    );
}

// Unix only: making a symlink on Windows needs a privilege that a normal user does not have, and
// Git for Windows checks links out as plain files (`core.symlinks=false`).
#[cfg(unix)]
#[test]
fn accepting_a_side_of_a_symlink_conflict_moves_the_link() {
    let r = TestRepo::new();
    let g = git();
    let link = |to: &str| {
        let p = r.path().join("ln");
        let _ = std::fs::remove_file(&p);
        std::os::unix::fs::symlink(to, &p).unwrap();
    };
    link("base-target");
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-qm", "base"]);
    r.sh(&["checkout", "-qb", "feature"]);
    link("theirs-target");
    r.sh(&["commit", "-qam", "feature"]);
    r.sh(&["checkout", "-q", "main"]);
    link("ours-target");
    r.sh(&["commit", "-qam", "main"]);
    for side in [ConflictSide::Theirs, ConflictSide::Ours] {
        r.sh(&["reset", "-q", "--hard", "main"]);
        let res = ops::merge(&g, &r.info, "feature", &MergeOpts::default()).unwrap();
        assert!(res.conflicts, "{res:?}");
        assert!(unmerged(&r).contains("120000"), "{}", unmerged(&r));
        assert!(conflicts(&g, &r.info).unwrap()[0].binary);
        accept_side(&g, &r.info, &strs(&["ln"]), side).unwrap();
        assert_eq!(unmerged(&r), "");
        let want = match side {
            ConflictSide::Theirs => "theirs-target",
            ConflictSide::Ours => "ours-target",
        };
        assert_eq!(
            std::fs::read_link(r.path().join("ln")).unwrap().to_str(),
            Some(want),
            "{side:?}"
        );
        assert!(r.sh(&["ls-files", "-s", "ln"]).starts_with("120000"));
        assert_eq!(r.sh(&["show", ":ln"]), want);
        r.sh(&["merge", "--abort"]);
    }
}

// ---------------------------------------------------------------- paths that start with a dash

#[test]
fn a_conflicted_file_whose_name_starts_with_a_dash_can_be_resolved() {
    for name in ["-dash.txt", "--ours"] {
        for use_save in [false, true] {
            let r = TestRepo::new();
            let g = git();
            r.write(name, "one\nbase\nthree\n");
            r.sh(&["add", "-A"]);
            r.sh(&["commit", "-qm", "base"]);
            r.sh(&["checkout", "-qb", "feature"]);
            r.write(name, "one\nTHEIRS\nthree\n");
            r.sh(&["commit", "-qam", "feature"]);
            r.sh(&["checkout", "-q", "main"]);
            r.write(name, "one\nOURS\nthree\n");
            r.sh(&["commit", "-qam", "main"]);
            assert!(
                ops::merge(&g, &r.info, "feature", &MergeOpts::default())
                    .unwrap()
                    .conflicts
            );
            assert_eq!(conflicts(&g, &r.info).unwrap()[0].path, name);
            assert!(conflict_versions(&g, &r.info, name).is_ok(), "{name}");
            if use_save {
                save(&g, &r, name, "one\nBOTH\nthree\n", true).unwrap();
                assert_eq!(r.read(name), "one\nBOTH\nthree\n");
            } else {
                accept_side(&g, &r.info, &strs(&[name]), ConflictSide::Theirs).unwrap();
                assert_eq!(r.read(name), "one\nTHEIRS\nthree\n");
            }
            assert_eq!(unmerged(&r), "", "{name}");
        }
    }
}

// ---------------------------------------------------------------- mixed line endings

#[test]
fn a_file_with_mixed_line_endings_keeps_the_ending_of_each_line() {
    let r = TestRepo::new();
    let g = git();
    r.sh(&["config", "core.autocrlf", "false"]);
    r.commit_file("m.txt", "a\r\nb\nc\r\nd\n", "base");
    r.sh(&["checkout", "-qb", "feature"]);
    r.commit_file("m.txt", "a\r\nb\nc\r\nTHEIRS\n", "feature");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("m.txt", "a\r\nb\nc\r\nOURS\n", "main");
    assert!(
        ops::merge(&g, &r.info, "feature", &MergeOpts::default())
            .unwrap()
            .conflicts
    );
    // the editor holds LF text (it cannot show the difference) and sends LF back
    save(&g, &r, "m.txt", "a\nb\nc\nMERGED\nand a new line\n", true).unwrap();
    assert_eq!(
        std::fs::read(r.path().join("m.txt")).unwrap(),
        b"a\r\nb\nc\r\nMERGED\nand a new line\n",
        "unchanged lines keep CRLF or LF as they were, a new line gets LF"
    );
    assert_eq!(unmerged(&r), "");
}
