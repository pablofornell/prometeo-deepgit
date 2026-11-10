//! Regression tests for the defects found by the adversarial review of the Rust backend. Each test
//! reproduces one finding (the numbers match the review list).

mod common;

use std::path::Path;
use std::process::Command;

use common::*;
use gitcore::ops::HunkOpts;
use gitcore::{
    diff, log, ops, refs, state, status, ApiError, DiffSpec, GitError, HunkRef, LogQuery,
    MergeOpts, RepoStateKind,
};

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn is_invalid<T: std::fmt::Debug>(r: Result<T, GitError>) -> bool {
    matches!(r, Err(GitError::Invalid(_)))
}

/// Raw stdout bytes of a git call (the shared `sh` helper decodes lossily).
fn git_bytes(dir: &Path, args: &[&str]) -> Vec<u8> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("spawn git")
        .stdout
}

fn numbered(n: usize) -> String {
    (0..n).map(|i| format!("l{i}\n")).collect()
}

// ---------------------------------------------------------------- 1. option injection

fn base_with_refs() -> TestRepo {
    let r = TestRepo::new();
    r.commit_file("a", "1\n", "init");
    r.sh(&["branch", "feature"]);
    r.sh(&["tag", "v1"]);
    r
}

#[test]
fn f01_dash_names_are_rejected_by_every_operation() {
    let r = base_with_refs();
    let g = git();
    let i = &r.info;
    assert!(is_invalid(ops::branch_create(
        &g, i, "-D", "feature", false
    )));
    assert!(is_invalid(ops::branch_create(&g, i, "ok", "-D", false)));
    assert!(is_invalid(ops::tag_create(&g, i, "-d", "v1", None)));
    assert!(is_invalid(ops::tag_create(&g, i, "x1", "-d", None)));
    assert!(is_invalid(ops::tag_delete(&g, i, "-x")));
    assert!(is_invalid(ops::checkout(&g, i, "-f", None)));
    assert!(is_invalid(ops::checkout(&g, i, "main", Some("-b"))));
    assert!(is_invalid(ops::merge(
        &g,
        i,
        "--abort",
        &MergeOpts::default()
    )));
    assert!(is_invalid(ops::rebase(&g, i, "--abort")));
    assert!(is_invalid(ops::cherry_pick(&g, i, &strs(&["--abort"]))));
    assert!(is_invalid(ops::revert(&g, i, "--abort")));
    assert!(is_invalid(ops::reset(
        &g,
        i,
        "--hard",
        gitcore::ResetMode::Mixed
    )));
    assert!(is_invalid(ops::branch_rename(&g, i, "-x", "y")));
    assert!(is_invalid(ops::branch_rename(&g, i, "feature", "-y")));
    assert!(is_invalid(ops::branch_delete(&g, i, "-D", true, false)));
    assert!(is_invalid(ops::branch_delete(&g, i, "-x/y", false, true)));
    assert!(is_invalid(ops::push(
        &g,
        i,
        Some("--mirror"),
        None,
        false,
        false,
        false
    )));
    assert!(is_invalid(ops::push(
        &g,
        i,
        Some("origin"),
        Some("--delete"),
        false,
        false,
        false
    )));
    assert!(is_invalid(ops::fetch(
        &g,
        i,
        Some("--upload-pack=x"),
        false
    )));
    // Nothing was harmed.
    let branches = r.sh(&["branch", "--format=%(refname:short)"]);
    assert!(branches.contains("feature") && branches.contains("main"));
    assert_eq!(r.sh(&["tag"]), "v1");
}

#[test]
fn f01_tag_named_like_an_option_is_not_executed_by_rebase() {
    let r = base_with_refs();
    let g = git();
    let marker = r.path().join("PWNED");
    assert_eq!(marker.file_name().unwrap(), "PWNED");
    // Ref names cannot hold spaces, but ${IFS} does the job for a shell.
    let name = "--exec=touch${IFS}PWNED".to_string();
    // update-ref accepts such a name (it can arrive through a fetch).
    r.sh(&["update-ref", &format!("refs/tags/{name}"), "HEAD"]);
    r.commit_file("b", "2\n", "second");
    // Sanity check of the scenario: git itself would run the option.
    let victim = r.sh(&["rev-parse", "--verify", "-q", &format!("refs/tags/{name}")]);
    assert!(!victim.is_empty());
    let res = ops::rebase(&g, &r.info, &name);
    assert!(is_invalid(res));
    assert!(!marker.exists());
}

#[test]
fn f01_log_ref_that_looks_like_an_option_is_rejected() {
    let r = base_with_refs();
    let g = git();
    let victim = r.path().join("victim.txt");
    std::fs::write(&victim, "important\n").unwrap();
    let q = LogQuery {
        refs: vec!["main".into(), format!("--output={}", victim.display())],
        ..LogQuery::default()
    };
    let res = log::load(&g, std::slice::from_ref(&r.info), &q);
    assert!(is_invalid(res));
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "important\n");
}

#[test]
fn f01_diff_revisions_that_look_like_options_are_rejected() {
    let r = base_with_refs();
    let g = git();
    let victim = r.path().join("victim.txt");
    std::fs::write(&victim, "important\n").unwrap();
    let opt = format!("--output={}", victim.display());
    assert!(is_invalid(diff::commit_details(&g, &r.info, &opt)));
    assert!(is_invalid(diff::file_content(&g, &r.info, Some(&opt), "a")));
    let spec = DiffSpec::Commit {
        oid: "HEAD".into(),
        parent: Some(opt.clone()),
    };
    assert!(is_invalid(diff::file_diff(
        &g, &r.info, &spec, "a", None, 3
    )));
    let spec = DiffSpec::Commit {
        oid: opt,
        parent: None,
    };
    assert!(is_invalid(diff::file_diff(
        &g, &r.info, &spec, "a", None, 3
    )));
    assert!(is_invalid(refs::branches_containing(&g, &r.info, "-x")));
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "important\n");
}

// ---------------------------------------------------------------- 2. config isolation

#[test]
fn f02_user_diff_config_does_not_change_the_patch() {
    for (key, value) in [
        ("diff.noprefix", "true"),
        ("diff.mnemonicPrefix", "true"),
        ("color.diff", "always"),
        ("diff.external", "/bin/false"),
    ] {
        let r = TestRepo::new();
        let g = git();
        r.sh(&["config", key, value]);
        r.write("dir/f.txt", "a\nb\nc\n");
        r.write("f.txt", "a\nb\nc\n");
        r.sh(&["add", "-A"]);
        r.sh(&["commit", "-qm", "init"]);
        r.write("dir/f.txt", "a\nB\nc\n");
        r.write("f.txt", "a\nB\nc\n");

        ops::discard_hunk(&g, &r.info, "dir/f.txt", 0, &HunkOpts::default())
            .unwrap_or_else(|e| panic!("{key}: {e}"));
        assert_eq!(r.read("dir/f.txt"), "a\nb\nc\n", "{key}");
        assert_eq!(
            r.read("f.txt"),
            "a\nB\nc\n",
            "{key}: f.txt must stay untouched"
        );

        r.write("dir/f.txt", "a\nB\nc\n");
        ops::stage_hunk(&g, &r.info, "dir/f.txt", 0, false, &HunkOpts::default())
            .unwrap_or_else(|e| panic!("{key}: {e}"));
        assert_eq!(r.sh(&["show", ":dir/f.txt"]), "a\nB\nc", "{key}");
        assert_eq!(r.sh(&["show", ":f.txt"]), "a\nb\nc", "{key}");
        // The display diff is the same whatever the config.
        let d = diff::file_diff(&g, &r.info, &DiffSpec::Staged, "dir/f.txt", None, 3).unwrap();
        assert_eq!(d.hunks.len(), 1, "{key}");
    }
}

// ---------------------------------------------------------------- 3. hunk identity

/// A, B and C are three separate hunks at context 0, but A and B merge at context 3.
fn abc_repo() -> TestRepo {
    let r = TestRepo::new();
    let base = numbered(40);
    r.commit_file("f", &base, "init");
    r.write(
        "f",
        &base
            .replace("l2\n", "CHANGE_A\n")
            .replace("l6\n", "CHANGE_B\n")
            .replace("l30\n", "CHANGE_C\n"),
    );
    r
}

fn hunk_refs(r: &TestRepo, spec: &DiffSpec, ctx: u32) -> Vec<HunkRef> {
    diff::file_diff(&git(), &r.info, spec, "f", None, ctx)
        .unwrap()
        .hunks
        .iter()
        .map(|h| h.hunk_ref())
        .collect()
}

#[test]
fn f03_discard_hunk_uses_the_context_and_hunk_the_ui_showed() {
    let r = abc_repo();
    let g = git();
    let refs0 = hunk_refs(&r, &DiffSpec::Unstaged, 0);
    assert_eq!(refs0.len(), 3);
    // Discard B (index 1 at context 0; index 1 at context 3 would be C).
    ops::discard_hunk(
        &g,
        &r.info,
        "f",
        1,
        &HunkOpts {
            context: Some(0),
            expected: Some(refs0[1].clone()),
            ..HunkOpts::default()
        },
    )
    .unwrap();
    let now = r.read("f");
    assert!(now.contains("CHANGE_A") && now.contains("CHANGE_C"));
    assert!(!now.contains("CHANGE_B") && now.contains("l6\n"));
}

#[test]
fn f03_expected_selects_the_hunk_and_ignores_the_index() {
    let r = abc_repo();
    let g = git();
    let refs0 = hunk_refs(&r, &DiffSpec::Unstaged, 0);
    ops::stage_hunk(
        &g,
        &r.info,
        "f",
        99,
        false,
        &HunkOpts {
            context: Some(0),
            expected: Some(refs0[2].clone()),
            ..HunkOpts::default()
        },
    )
    .unwrap();
    let staged = r.sh(&["show", ":f"]);
    assert!(staged.contains("CHANGE_C") && !staged.contains("CHANGE_A"));
    assert_eq!(hunk_refs(&r, &DiffSpec::Unstaged, 0).len(), 2);
}

#[test]
fn f03_a_hunk_that_no_longer_matches_is_refused() {
    let r = abc_repo();
    let g = git();
    let refs0 = hunk_refs(&r, &DiffSpec::Unstaged, 0);
    let before = r.read("f");
    // The file changes after the UI loaded the diff.
    r.write("f", &before.replace("CHANGE_A\n", "CHANGE_A\nextra line\n"));
    let err = ops::discard_hunk(
        &g,
        &r.info,
        "f",
        2,
        &HunkOpts {
            context: Some(0),
            expected: Some(refs0[2].clone()),
            ..HunkOpts::default()
        },
    )
    .unwrap_err();
    match err {
        GitError::Invalid(m) => assert_eq!(m, "The file changed. Reload the diff."),
        other => panic!("unexpected {other:?}"),
    }
    assert!(r.read("f").contains("CHANGE_C"));
}

// ---------------------------------------------------------------- 4. checkout of a path

#[test]
fn f04_checkout_never_treats_the_target_as_a_path() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("notes", "v1\n", "init");
    r.write("notes", "precious uncommitted work\n");
    let res = ops::checkout(&g, &r.info, "notes", None);
    assert!(res.is_err());
    assert_eq!(r.read("notes"), "precious uncommitted work\n");
    // A remote-only branch is still created and tracked.
    let dir = tempfile::tempdir().unwrap();
    let bare = dir.path().join("bare.git");
    std::fs::create_dir_all(&bare).unwrap();
    sh(&bare, &["init", "-q", "--bare", "-b", "main"], None);
    r.sh(&["stash", "-q"]);
    r.sh(&["remote", "add", "origin", bare.to_str().unwrap()]);
    r.sh(&["push", "-q", "origin", "main:topic"]);
    r.sh(&["fetch", "-q", "origin"]);
    assert!(ops::checkout(&g, &r.info, "topic", None).unwrap().ok);
    assert_eq!(r.sh(&["branch", "--show-current"]), "topic");
}

// ---------------------------------------------------------------- 5. non UTF-8 content

#[test]
fn f05_hunks_keep_the_exact_bytes_of_non_utf8_files() {
    let r = TestRepo::new();
    let g = git();
    let mut base = Vec::new();
    for i in 0..20 {
        base.extend_from_slice(format!("line{i}\n").as_bytes());
    }
    std::fs::write(r.path().join("f.txt"), &base).unwrap();
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-qm", "init"]);
    let mut edited = Vec::new();
    for i in 0..20 {
        if i == 19 {
            edited.extend_from_slice(b"changed\n");
            continue;
        }
        edited.extend_from_slice(format!("line{i}\n").as_bytes());
        if i == 0 {
            edited.extend_from_slice(b"caf\xe9 na\xefve\n");
        }
    }
    std::fs::write(r.path().join("f.txt"), &edited).unwrap();

    ops::stage_hunk(&g, &r.info, "f.txt", 0, false, &HunkOpts::default()).unwrap();
    let blob = git_bytes(r.path(), &["show", ":f.txt"]);
    let mut want = Vec::new();
    for i in 0..20 {
        want.extend_from_slice(format!("line{i}\n").as_bytes());
        if i == 0 {
            want.extend_from_slice(b"caf\xe9 na\xefve\n");
        }
    }
    assert_eq!(blob, want);

    // Discarding the other hunk keeps the Latin-1 line byte for byte too.
    ops::discard_hunk(&g, &r.info, "f.txt", 0, &HunkOpts::default()).unwrap();
    assert_eq!(std::fs::read(r.path().join("f.txt")).unwrap(), want);
}

#[test]
fn f05_hunks_work_for_paths_with_quotes_tabs_and_leading_dashes() {
    let r = TestRepo::new();
    let g = git();
    let names = ["-rf x.txt", "ñandú \"q\".txt", "tab\there.txt", "a\\b.txt"];
    let body = numbered(20);
    for n in names {
        r.write(n, &body);
    }
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-qm", "init"]);
    for n in names {
        r.write(n, &body.replace("l1\n", "L1\n").replace("l18\n", "L18\n"));
    }
    for n in names {
        ops::stage_hunk(&g, &r.info, n, 1, false, &HunkOpts::default()).unwrap();
        ops::discard_hunk(&g, &r.info, n, 0, &HunkOpts::default()).unwrap();
        let now = r.read(n);
        assert!(!now.contains("L1\n") && now.contains("L18\n"), "{n:?}");
        let blob = git_bytes(r.path(), &["show", &format!(":{n}")]);
        let blob = String::from_utf8(blob).unwrap();
        assert!(blob.contains("L18\n") && !blob.contains("L1\n"), "{n:?}");
    }
}

// ---------------------------------------------------------------- 6. renames

fn staged_rename_repo() -> TestRepo {
    let r = TestRepo::new();
    let body = numbered(40);
    r.commit_file("old.txt", &body, "init");
    r.sh(&["mv", "old.txt", "new.txt"]);
    r.write(
        "new.txt",
        &body.replace("l2\n", "LINE2\n").replace("l35\n", "LINE35\n"),
    );
    r.sh(&["add", "new.txt"]);
    r
}

fn porcelain(r: &TestRepo) -> Vec<String> {
    // Not through `sh`: it trims the leading space of " D file".
    String::from_utf8(git_bytes(r.path(), &["status", "--porcelain"]))
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn f06_unstaging_a_hunk_of_a_renamed_file_keeps_the_rename() {
    let r = staged_rename_repo();
    let g = git();
    let ui = diff::file_diff(
        &g,
        &r.info,
        &DiffSpec::Staged,
        "new.txt",
        Some("old.txt"),
        3,
    )
    .unwrap();
    assert_eq!(ui.hunks.len(), 2);
    ops::stage_hunk(
        &g,
        &r.info,
        "new.txt",
        0,
        true,
        &HunkOpts {
            old_path: Some("old.txt"),
            expected: Some(ui.hunks[0].hunk_ref()),
            ..HunkOpts::default()
        },
    )
    .unwrap();
    let st = porcelain(&r);
    assert!(
        !st.iter().any(|l| l == "D  old.txt"),
        "lone staged deletion left behind: {st:?}"
    );
    // The rename is still staged, with only the second change.
    assert!(st
        .iter()
        .any(|l| l.starts_with("R") && l.contains("new.txt")));
    let staged = r.sh(&["show", ":new.txt"]);
    assert!(staged.contains("LINE35") && !staged.contains("LINE2\n"));
    // The worktree is untouched.
    assert!(r.read("new.txt").contains("LINE2\n"));
}

#[test]
fn f06_an_old_path_that_is_not_a_rename_does_not_pick_the_wrong_file() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("old.txt", "a\nb\nc\nd\n", "init");
    r.sh(&["rm", "-q", "old.txt"]);
    r.write("new.txt", "x\ny\nz\nw\n");
    r.sh(&["add", "new.txt"]);
    ops::stage_hunk(
        &g,
        &r.info,
        "new.txt",
        0,
        true,
        &HunkOpts {
            old_path: Some("old.txt"),
            ..HunkOpts::default()
        },
    )
    .unwrap();
    assert!(!r.sh(&["ls-files"]).contains("new.txt"));
    assert!(porcelain(&r).iter().any(|l| l == "D  old.txt"));
}

#[test]
fn f06_unstaging_a_renamed_file_unstages_the_old_path_too() {
    let r = staged_rename_repo();
    let g = git();
    ops::unstage(&g, &r.info, &strs(&["new.txt"])).unwrap();
    let t = status::working_tree(&g, &r.info).unwrap();
    assert!(t.staged.is_empty(), "{:?}", t.staged);
    let st = porcelain(&r);
    assert!(!st.iter().any(|l| l.starts_with("D ")), "{st:?}");
}

// ---------------------------------------------------------------- 7. sequencer state

fn sequencer_repo() -> TestRepo {
    let r = TestRepo::new();
    r.commit_file("f", "base\n", "base");
    r.sh(&["checkout", "-qb", "side"]);
    r.commit_file("f", "side\n", "A");
    r.commit_file("g", "g\n", "B");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "main\n", "M");
    r
}

#[test]
fn f07_a_multi_commit_cherry_pick_stays_in_progress_after_the_first_commit() {
    let r = sequencer_repo();
    let g = git();
    let res = ops::cherry_pick(&g, &r.info, &strs(&["side~1", "side"])).unwrap();
    assert!(!res.ok && res.conflicts);
    r.write("f", "resolved\n");
    ops::stage(&g, &r.info, &strs(&["f"])).unwrap();
    assert!(
        ops::commit(&g, &r.info, "A resolved", false, false)
            .unwrap()
            .ok
    );
    // CHERRY_PICK_HEAD is gone but B is still queued.
    assert_eq!(
        state::repo_state(r.path()).unwrap(),
        RepoStateKind::CherryPicking
    );
    let res = ops::op_continue(&g, &r.info).unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(r.read("g"), "g\n");
    assert_eq!(r.sh(&["log", "-1", "--format=%s"]), "B");
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
}

#[test]
fn f07_abort_works_between_the_commits_of_a_sequence() {
    let r = sequencer_repo();
    let g = git();
    ops::cherry_pick(&g, &r.info, &strs(&["side~1", "side"])).unwrap();
    r.write("f", "resolved\n");
    ops::stage(&g, &r.info, &strs(&["f"])).unwrap();
    ops::commit(&g, &r.info, "A resolved", false, false).unwrap();
    // git does not rewind a HEAD the user moved, but it drops the queued B.
    assert!(ops::op_abort(&g, &r.info).unwrap().ok);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
    assert!(!r.path().join("g").exists());
}

#[test]
fn f07_detect_reads_the_first_command_of_the_todo_list() {
    let dir = tempfile::tempdir().unwrap();
    let gd = dir.path();
    std::fs::create_dir_all(gd.join("sequencer")).unwrap();
    std::fs::write(gd.join("sequencer/todo"), "# comment\npick abc one\n").unwrap();
    assert_eq!(state::detect(gd), RepoStateKind::CherryPicking);
    std::fs::write(gd.join("sequencer/todo"), "revert abc one\npick def two\n").unwrap();
    assert_eq!(state::detect(gd), RepoStateKind::Reverting);
    std::fs::write(gd.join("sequencer/todo"), "\n").unwrap();
    assert_eq!(state::detect(gd), RepoStateKind::Clean);
}

// ---------------------------------------------------------------- 8. discard of a folder

#[test]
fn f08_discarding_a_folder_restores_tracked_and_deletes_untracked() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("d/t.txt", "orig\n", "init");
    r.commit_file("keep.txt", "k\n", "keep");
    r.write("d/t.txt", "modified\n");
    r.write("d/u.txt", "untracked\n");
    r.write("d/sub/v.txt", "untracked too\n");
    r.write("keep.txt", "still modified\n");
    ops::discard(&g, &r.info, &strs(&["d"])).unwrap();
    assert_eq!(r.read("d/t.txt"), "orig\n");
    assert!(!r.path().join("d/u.txt").exists());
    assert!(!r.path().join("d/sub/v.txt").exists());
    assert_eq!(r.read("keep.txt"), "still modified\n");
}

#[test]
fn f08_discarding_an_ignored_untracked_file_is_left_alone() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file(".gitignore", "*.log\n", "init");
    r.commit_file("d/t.txt", "orig\n", "t");
    r.write("d/t.txt", "modified\n");
    r.write("d/x.log", "ignored\n");
    ops::discard(&g, &r.info, &strs(&["d"])).unwrap();
    assert_eq!(r.read("d/t.txt"), "orig\n");
    assert!(r.path().join("d/x.log").exists());
}

// ---------------------------------------------------------------- 9. control characters

#[test]
fn f09_control_characters_do_not_break_log_stash_and_details() {
    let r = TestRepo::new();
    let g = git();
    r.write("a", "1\n");
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-qm", "weird \x1f unit \x1e record"]);
    r.write("b", "2\n");
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-qm", "plain"]);
    r.write("a", "dirty\n");
    r.sh(&["stash", "push", "-m", "stash \x1f with \x1e controls"]);

    let (rows, _, _, _) =
        log::load(&g, std::slice::from_ref(&r.info), &LogQuery::default()).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].subject, "plain");
    assert_eq!(rows[1].subject, "weird \x1f unit \x1e record");

    let st = refs::read_refs(&g, &r.info).unwrap().stashes;
    assert_eq!(st.len(), 1);
    assert!(st[0].message.contains("stash \x1f with \x1e controls"));

    let d = diff::commit_details(&g, &r.info, &rows[1].oid).unwrap();
    assert_eq!(d.subject, "weird \x1f unit \x1e record");
}

// ---------------------------------------------------------------- 10. error messages

fn cmd_err(stderr: &str) -> ApiError {
    GitError::Command {
        args: vec!["push".into()],
        code: 1,
        stderr: stderr.into(),
    }
    .into()
}

#[test]
fn f10_known_failures_get_clear_messages() {
    let cases = [
        (
            "On branch main\nnothing to commit, working tree clean",
            "Nothing to commit. Stage changes first.",
        ),
        (
            "no changes added to commit (use \"git add\" and/or \"git commit -a\")",
            "Nothing to commit. Stage changes first.",
        ),
        (
            "To origin\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs",
            "Push rejected: the remote has new commits. Pull first.",
        ),
        (
            "remote: Invalid username or password.\nfatal: Authentication failed for 'https://x/y.git/'",
            "Authentication failed. Check your user name and password or token, then try again.",
        ),
        (
            "fatal: could not read Username for 'https://x': terminal prompts disabled",
            "No credentials were given. Run the command again and enter them, or set up a credential helper or an SSH agent.",
        ),
        (
            "git@x: Permission denied (publickey).\nfatal: Could not read from remote repository.",
            "SSH authentication failed (permission denied). Check the passphrase of your key, or load the key in an SSH agent.",
        ),
        (
            "fatal: unable to access 'https://nope/': Could not resolve host: nope",
            "Could not resolve the host. Check your network connection and the remote URL.",
        ),
    ];
    for (stderr, want) in cases {
        let api = cmd_err(stderr);
        assert_eq!(api.message, want, "for {stderr:?}");
        assert_eq!(api.detail.as_deref(), Some(stderr));
    }
}

#[test]
fn f10_generic_failures_prefer_the_fatal_or_error_line() {
    let api = cmd_err("hint: Waiting for your editor\nwarning: x\nfatal: bad object\nerror: other");
    assert_eq!(api.message, "fatal: bad object");
    let api = cmd_err("hint: use this\nerror: something broke");
    assert_eq!(api.message, "error: something broke");
    let api = cmd_err("hint: first\nplain line");
    assert_eq!(api.message, "plain line");
    let api = cmd_err("");
    assert_eq!(api.message, "git push failed (exit 1)");
}

#[test]
fn f10_a_rejected_tag_fetch_is_not_reported_as_a_rejected_push() {
    let api = GitError::Command {
        args: vec!["fetch".into()],
        code: 1,
        stderr: " ! [rejected]        v1 -> v1  (would clobber existing tag)".into(),
    };
    let api: ApiError = api.into();
    assert!(api.message.contains("would clobber"), "{}", api.message);
}

#[test]
fn f10_commit_with_nothing_staged_maps_to_the_friendly_message() {
    let r = TestRepo::new();
    r.commit_file("a", "1\n", "init");
    let err = ops::commit(&git(), &r.info, "msg", false, false).unwrap_err();
    let api: ApiError = err.into();
    assert_eq!(api.message, "Nothing to commit. Stage changes first.");
    assert!(api.detail.unwrap().contains("nothing to commit"));
}

// ---------------------------------------------------------------- 11. file_content

#[cfg(unix)]
#[test]
fn f11_file_content_does_not_follow_symlinks_out_of_the_repo() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "SECRET\n").unwrap();
    let r = TestRepo::new();
    let g = git();
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), r.path().join("leak")).unwrap();
    std::os::unix::fs::symlink(outside.path(), r.path().join("linkdir")).unwrap();
    r.write("real.txt", "real\n");
    std::fs::create_dir_all(r.path().join("dir")).unwrap();

    // A symlink shows its target, like the blob git stores.
    let text = diff::file_content(&g, &r.info, None, "leak").unwrap();
    assert_eq!(text, outside.path().join("secret.txt").to_string_lossy());
    // Through a symlinked directory: refused.
    assert!(diff::file_content(&g, &r.info, None, "linkdir/secret.txt").is_err());
    // Directories and special files: refused.
    assert!(is_invalid(diff::file_content(&g, &r.info, None, "dir")));
    let fifo = r.path().join("pipe");
    let ok = Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success();
    assert!(ok);
    assert!(is_invalid(diff::file_content(&g, &r.info, None, "pipe")));
    // Regular files still work.
    assert_eq!(
        diff::file_content(&g, &r.info, None, "real.txt").unwrap(),
        "real\n"
    );
}

// ---------------------------------------------------------------- 12. stopped operations

#[test]
fn f12_an_empty_cherry_pick_is_a_stopped_result_not_an_error() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "base\n", "base");
    r.sh(&["checkout", "-qb", "side"]);
    r.commit_file("f", "x\n", "X");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "x\n", "X again");
    let res = ops::cherry_pick(&g, &r.info, &strs(&["side"])).unwrap();
    assert!(!res.ok);
    assert!(!res.conflicts);
    assert!(!res.message.is_empty());
    assert_eq!(
        state::repo_state(r.path()).unwrap(),
        RepoStateKind::CherryPicking
    );
    // The user can then skip it.
    assert!(ops::op_skip(&g, &r.info).unwrap().ok);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
}

#[test]
fn f12_a_failure_with_nothing_in_progress_is_still_an_error() {
    let r = TestRepo::new();
    r.commit_file("f", "1\n", "init");
    assert!(ops::merge(&git(), &r.info, "does-not-exist", &MergeOpts::default()).is_err());
}

// ---------------------------------------------------------------- 13. hangs

#[cfg(unix)]
fn ext_remote(r: &TestRepo, script_body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = r.path().join(".git").join("transport.sh");
    std::fs::write(&script, format!("#!/bin/sh\n{script_body}\n")).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    r.sh(&["config", "protocol.ext.allow", "always"]);
    r.sh(&["remote", "add", "x", &format!("ext::{}", script.display())]);
    script
}

#[cfg(unix)]
#[test]
fn f13_ssh_runs_in_batch_mode_unless_configured() {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() {
        return;
    }
    let r = TestRepo::new();
    r.commit_file("a", "1\n", "init");
    let out = r.path().join(".git").join("env.txt");
    ext_remote(
        &r,
        &format!(
            "printenv GIT_SSH_COMMAND > '{}'\nprintenv SSH_ASKPASS_REQUIRE >> '{}'\nexit 1",
            out.display(),
            out.display()
        ),
    );
    let _ = ops::fetch(&git(), &r.info, Some("x"), false);
    let env = std::fs::read_to_string(&out).unwrap();
    assert_eq!(env, "ssh -o BatchMode=yes\nnever\n");

    // A configured core.sshCommand must not be overridden by the environment variable.
    r.sh(&["config", "core.sshCommand", "ssh -v"]);
    let _ = ops::fetch(&git(), &r.info, Some("x"), false);
    let env = std::fs::read_to_string(&out).unwrap();
    assert_eq!(env, "never\n");
}

#[cfg(unix)]
#[test]
fn f13_a_hanging_network_command_is_killed_after_the_timeout() {
    let r = TestRepo::new();
    r.commit_file("a", "1\n", "init");
    ext_remote(&r, "sleep 60");
    let g = git().with_network_timeout(std::time::Duration::from_millis(700));
    let start = std::time::Instant::now();
    let err = ops::fetch(&g, &r.info, Some("x"), false).unwrap_err();
    assert!(matches!(err, GitError::Timeout { .. }), "{err:?}");
    assert!(start.elapsed() < std::time::Duration::from_secs(20));
    let api: ApiError = err.into();
    assert!(api.message.contains("timed out"), "{}", api.message);
}

// ---------------------------------------------------------------- 14. stash race

#[test]
fn f14_stash_operations_verify_the_expected_oid() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a.txt", "1\n", "init");
    r.write("a.txt", "first\n");
    ops::stash_save(&g, &r.info, Some("one"), false, false).unwrap();
    r.write("a.txt", "second\n");
    ops::stash_save(&g, &r.info, Some("two"), false, false).unwrap();
    let list = refs::read_refs(&g, &r.info).unwrap().stashes;
    assert_eq!(list.len(), 2);
    let (top, bottom) = (list[0].oid.clone(), list[1].oid.clone());

    // The UI thinks index 0 is `bottom` (the list changed under it).
    for res in [
        ops::stash_drop(&g, &r.info, 0, Some(&bottom)),
        ops::stash_apply(&g, &r.info, 0, Some(&bottom)),
        ops::stash_pop(&g, &r.info, 0, Some(&bottom)),
    ] {
        match res {
            Err(GitError::Invalid(m)) => assert_eq!(m, "The stash list changed. Reload."),
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(refs::read_refs(&g, &r.info).unwrap().stashes.len(), 2);
    assert_eq!(r.read("a.txt"), "1\n");

    assert!(ops::stash_drop(&g, &r.info, 0, Some(&top)).unwrap().ok);
    let list = refs::read_refs(&g, &r.info).unwrap().stashes;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].oid, bottom);
    assert!(ops::stash_pop(&g, &r.info, 0, Some(&bottom)).unwrap().ok);
    assert_eq!(r.read("a.txt"), "first\n");
}

// ---------------------------------------------------------------- 15. remote names with slashes

#[test]
fn f15_remote_branch_delete_uses_the_configured_remote_name() {
    let dir = tempfile::tempdir().unwrap();
    let bare = dir.path().join("remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    sh(&bare, &["init", "-q", "--bare", "-b", "main"], None);
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a", "1\n", "init");
    r.sh(&["remote", "add", "team/fork", bare.to_str().unwrap()]);
    r.sh(&["push", "-q", "team/fork", "main:gone-soon", "main:keep"]);
    r.sh(&["fetch", "-q", "team/fork"]);
    let res = ops::branch_delete(&g, &r.info, "team/fork/gone-soon", false, true).unwrap();
    assert!(res.ok, "{}", res.message);
    let remote_branches = sh(&bare, &["branch", "--format=%(refname:short)"], None);
    assert!(remote_branches.contains("keep") && !remote_branches.contains("gone-soon"));
    // An unknown remote is a clear error.
    assert!(is_invalid(ops::branch_delete(
        &g,
        &r.info,
        "nowhere/x",
        false,
        true
    )));
}
