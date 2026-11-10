mod common;

use common::*;
use gitcore::{ops, refs, state, status, GitError, MergeMode, MergeOpts, RepoStateKind, ResetMode};

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn merge_opts(mode: MergeMode) -> MergeOpts {
    MergeOpts {
        mode,
        ..MergeOpts::default()
    }
}

fn ten_lines(first: &str, last: &str) -> String {
    let mut lines: Vec<String> = (1..=20).map(|i| format!("line {i}")).collect();
    lines[0] = first.to_string();
    lines[19] = last.to_string();
    lines.join("\n") + "\n"
}

#[test]
fn stage_unstage_discard() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a.txt", "1\n", "init");
    r.write("a.txt", "2\n");
    r.write("new.txt", "n\n");
    r.write("dir/x.txt", "x\n");

    ops::stage(&g, &r.info, &strs(&["a.txt", "new.txt"])).unwrap();
    let t = status::working_tree(&g, &r.info).unwrap();
    assert_eq!(t.staged.len(), 2);
    assert_eq!(t.unstaged.len(), 1); // dir/x.txt untracked

    ops::unstage(&g, &r.info, &strs(&["a.txt", "new.txt"])).unwrap();
    let t = status::working_tree(&g, &r.info).unwrap();
    assert!(t.staged.is_empty());
    assert_eq!(t.unstaged.len(), 3);

    // Discard: tracked is restored, untracked is deleted.
    ops::discard(&g, &r.info, &strs(&["a.txt", "dir/x.txt"])).unwrap();
    assert_eq!(r.read("a.txt"), "1\n");
    assert!(!r.path().join("dir/x.txt").exists());
    assert!(r.path().join("new.txt").exists());
    assert!(ops::discard(&g, &r.info, &strs(&["../escape"])).is_err());
}

#[test]
fn unstage_in_a_repo_without_commits() {
    let r = TestRepo::new();
    let g = git();
    r.write("a.txt", "1\n");
    ops::stage(&g, &r.info, &strs(&["a.txt"])).unwrap();
    assert_eq!(status::working_tree(&g, &r.info).unwrap().staged.len(), 1);
    ops::unstage(&g, &r.info, &strs(&["a.txt"])).unwrap();
    let t = status::working_tree(&g, &r.info).unwrap();
    assert!(t.staged.is_empty());
    assert_eq!(t.unstaged.len(), 1);
}

#[test]
fn glob_characters_in_paths_are_literal() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("seed", "s", "init");
    r.write("a*.txt", "1\n");
    r.write("abc.txt", "2\n");
    ops::stage(&g, &r.info, &strs(&["a*.txt"])).unwrap();
    let t = status::working_tree(&g, &r.info).unwrap();
    assert_eq!(t.staged.len(), 1);
    assert_eq!(t.staged[0].path, "a*.txt");
}

#[test]
fn stage_hunk_stages_only_one_of_two_hunks_and_reverse_unstages() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f.txt", &ten_lines("first", "last"), "init");
    r.write("f.txt", &ten_lines("FIRST", "LAST"));

    let hunks = |staged: bool| {
        let spec = if staged {
            gitcore::DiffSpec::Staged
        } else {
            gitcore::DiffSpec::Unstaged
        };
        gitcore::diff::file_diff(&g, &r.info, &spec, "f.txt", None, 3)
            .unwrap()
            .hunks
    };
    assert_eq!(hunks(false).len(), 2);

    ops::stage_hunk(&g, &r.info, "f.txt", 1, false, &Default::default()).unwrap();
    let staged = hunks(true);
    assert_eq!(staged.len(), 1);
    assert_eq!(
        staged[0].lines.iter().filter(|l| l.text == "LAST").count(),
        1
    );
    let unstaged = hunks(false);
    assert_eq!(unstaged.len(), 1);
    assert!(unstaged[0].lines.iter().any(|l| l.text == "FIRST"));
    // The worktree is untouched.
    assert_eq!(r.read("f.txt"), ten_lines("FIRST", "LAST"));

    // The staged diff now has one hunk (index 0); unstaging it empties the index again.
    ops::stage_hunk(&g, &r.info, "f.txt", 0, true, &Default::default()).unwrap();
    assert!(hunks(true).is_empty());
    assert_eq!(hunks(false).len(), 2);
    assert!(matches!(
        ops::stage_hunk(&g, &r.info, "f.txt", 9, false, &Default::default()),
        Err(GitError::Invalid(_))
    ));
}

#[test]
fn reverse_stage_hunk_and_discard_hunk() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f.txt", &ten_lines("first", "last"), "init");
    r.write("f.txt", &ten_lines("FIRST", "LAST"));
    ops::stage(&g, &r.info, &strs(&["f.txt"])).unwrap();

    // Unstage only the second hunk of the staged diff.
    ops::stage_hunk(&g, &r.info, "f.txt", 1, true, &Default::default()).unwrap();
    let t = status::working_tree(&g, &r.info).unwrap();
    assert_eq!(t.staged.len(), 1);
    assert_eq!(t.unstaged.len(), 1);

    // Discard the remaining unstaged hunk: the worktree goes back to the index content.
    ops::discard_hunk(&g, &r.info, "f.txt", 0, &Default::default()).unwrap();
    assert_eq!(r.read("f.txt"), ten_lines("FIRST", "last"));
    assert!(status::working_tree(&g, &r.info)
        .unwrap()
        .unstaged
        .is_empty());
}

#[test]
fn stage_hunk_works_with_no_newline_at_end_of_file() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f.txt", "a\nb\nc", "init");
    r.write("f.txt", "a\nB\nc\nd");
    ops::stage_hunk(&g, &r.info, "f.txt", 0, false, &Default::default()).unwrap();
    let t = status::working_tree(&g, &r.info).unwrap();
    assert_eq!(t.staged.len(), 1);
    assert_eq!(r.sh(&["show", ":f.txt"]), "a\nB\nc\nd");
}

#[test]
fn commit_and_amend() {
    let r = TestRepo::new();
    let g = git();
    r.write("a.txt", "1\n");
    ops::stage(&g, &r.info, &strs(&["a.txt"])).unwrap();
    let res = ops::commit(&g, &r.info, "first\n\nbody text", false, false).unwrap();
    assert!(res.ok && !res.conflicts);
    assert_eq!(
        r.sh(&["log", "-1", "--format=%B"]).trim(),
        "first\n\nbody text"
    );
    assert_eq!(
        gitcore::diff::last_commit_message(&g, &r.info).unwrap(),
        "first\n\nbody text"
    );

    let before = r.head();
    r.write("a.txt", "2\n");
    ops::stage(&g, &r.info, &strs(&["a.txt"])).unwrap();
    ops::commit(&g, &r.info, "amended", true, false).unwrap();
    assert_ne!(r.head(), before);
    assert_eq!(r.sh(&["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(r.sh(&["log", "-1", "--format=%s"]), "amended");
    assert_eq!(r.sh(&["show", "HEAD:a.txt"]), "2");

    // Amend with an empty message keeps the previous one.
    ops::commit(&g, &r.info, "", true, false).unwrap();
    assert_eq!(r.sh(&["log", "-1", "--format=%s"]), "amended");

    // Nothing to commit is an error, not an OpResult.
    assert!(matches!(
        ops::commit(&g, &r.info, "again", false, false),
        Err(GitError::Command { .. })
    ));
}

fn conflicted_repo() -> TestRepo {
    let r = TestRepo::new();
    r.commit_file("c.txt", "base\n", "base");
    r.sh(&["checkout", "-q", "-b", "other"]);
    r.commit_file("c.txt", "other\n", "other");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("c.txt", "main\n", "main");
    r
}

#[test]
fn merge_conflict_then_abort() {
    let r = conflicted_repo();
    let g = git();
    let res = ops::merge(&g, &r.info, "other", &MergeOpts::default()).unwrap();
    assert!(!res.ok);
    assert!(res.conflicts);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Merging);
    assert_eq!(refs::repo_summary(&g, &r.info).unwrap().conflicted, 1);

    let res = ops::op_abort(&g, &r.info).unwrap();
    assert!(res.ok);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
    assert_eq!(r.read("c.txt"), "main\n");
    // Nothing left to abort.
    assert!(matches!(
        ops::op_abort(&g, &r.info),
        Err(GitError::Invalid(_))
    ));
}

#[test]
fn merge_conflict_resolved_and_continued() {
    let r = conflicted_repo();
    let g = git();
    assert!(
        ops::merge(&g, &r.info, "other", &MergeOpts::default())
            .unwrap()
            .conflicts
    );
    // Continuing with unresolved conflicts reports conflicts again.
    assert!(ops::op_continue(&g, &r.info).is_err() || !ops::op_continue(&g, &r.info).unwrap().ok);
    r.write("c.txt", "resolved\n");
    ops::stage(&g, &r.info, &strs(&["c.txt"])).unwrap();
    let res = ops::op_continue(&g, &r.info).unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
    assert_eq!(
        r.sh(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .split(' ')
            .count(),
        3
    );
}

#[test]
fn merge_fast_forward_squash_and_no_ff() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a", "1", "one");
    r.sh(&["checkout", "-q", "-b", "f1"]);
    r.commit_file("b", "1", "two");
    r.sh(&["checkout", "-q", "main"]);
    let res = ops::merge(&g, &r.info, "f1", &merge_opts(MergeMode::NoFf)).unwrap();
    assert!(res.ok);
    assert_eq!(
        r.sh(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .split(' ')
            .count(),
        3
    );

    r.sh(&["checkout", "-q", "-b", "f2"]);
    r.commit_file("c", "1", "three");
    r.sh(&["checkout", "-q", "main"]);
    let before = r.head();
    assert!(
        ops::merge(&g, &r.info, "f2", &merge_opts(MergeMode::Squash))
            .unwrap()
            .ok
    );
    assert_eq!(r.head(), before); // squash does not commit
    assert_eq!(status::working_tree(&g, &r.info).unwrap().staged.len(), 1);
}

#[test]
fn cherry_pick_and_conflicting_cherry_pick() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a.txt", "base\n", "base");
    r.sh(&["checkout", "-q", "-b", "feature"]);
    let pick = r.commit_file("b.txt", "b\n", "add b");
    let bad = r.commit_file("a.txt", "feature\n", "change a on feature");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("a.txt", "main\n", "change a on main");

    let res = ops::cherry_pick(&g, &r.info, &strs(&[&pick])).unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(r.read("b.txt"), "b\n");
    assert_eq!(r.sh(&["log", "-1", "--format=%s"]), "add b");

    let res = ops::cherry_pick(&g, &r.info, &strs(&[&bad])).unwrap();
    assert!(!res.ok && res.conflicts);
    assert_eq!(
        state::repo_state(r.path()).unwrap(),
        RepoStateKind::CherryPicking
    );
    assert!(ops::op_abort(&g, &r.info).unwrap().ok);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
}

#[test]
fn rebase_conflict_abort_and_skip() {
    let r = conflicted_repo();
    let g = git();
    r.sh(&["checkout", "-q", "other"]);
    let res = ops::rebase(&g, &r.info, "main").unwrap();
    assert!(!res.ok && res.conflicts);
    assert_eq!(
        state::repo_state(r.path()).unwrap(),
        RepoStateKind::Rebasing
    );
    let res = ops::op_skip(&g, &r.info).unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);

    r.sh(&["checkout", "-q", "-B", "other2", "other@{1}"]);
    // Rebase once more and abort.
    let res = ops::rebase(&g, &r.info, "main").unwrap();
    if res.conflicts {
        assert!(ops::op_abort(&g, &r.info).unwrap().ok);
    }
}

#[test]
fn rebase_autostashes_a_dirty_worktree() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a.txt", "a\n", "base");
    r.commit_file("keep.txt", "keep\n", "keep");
    r.sh(&["checkout", "-q", "-b", "feature"]);
    r.commit_file("f.txt", "f\n", "feature");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("m.txt", "m\n", "main");
    r.sh(&["checkout", "-q", "feature"]);
    r.write("a.txt", "dirty\n");

    let res = ops::rebase(&g, &r.info, "main").unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
    assert_eq!(r.read("a.txt"), "dirty\n");
    assert_eq!(r.read("m.txt"), "m\n");
    assert_eq!(r.sh(&["stash", "list"]), "");
}

#[test]
fn rebase_abort_restores_the_autostash() {
    let r = conflicted_repo();
    let g = git();
    r.commit_file("d.txt", "d\n", "d");
    r.sh(&["checkout", "-q", "other"]);
    r.write("d.txt", "dirty\n");
    r.sh(&["add", "d.txt"]);
    r.sh(&["commit", "-q", "-m", "d on other"]);
    r.write("d.txt", "dirtier\n");

    let res = ops::rebase(&g, &r.info, "main").unwrap();
    assert!(!res.ok && res.conflicts);
    assert_eq!(
        state::repo_state(r.path()).unwrap(),
        RepoStateKind::Rebasing
    );
    let res = ops::op_abort(&g, &r.info).unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
    assert_eq!(r.read("d.txt"), "dirtier\n");
    assert_eq!(r.sh(&["stash", "list"]), "");
}

#[test]
fn revert_and_reset() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a", "1\n", "one");
    let two = r.commit_file("a", "2\n", "two");
    assert!(ops::revert(&g, &r.info, &two).unwrap().ok);
    assert_eq!(r.read("a"), "1\n");
    let first = r.sh(&["rev-parse", "HEAD~2"]);
    assert!(ops::reset(&g, &r.info, &first, ResetMode::Hard).unwrap().ok);
    assert_eq!(r.head(), first);
    ops::reset(&g, &r.info, "HEAD", ResetMode::Soft).unwrap();
    ops::reset(&g, &r.info, "HEAD", ResetMode::Mixed).unwrap();
    ops::reset(&g, &r.info, "HEAD", ResetMode::Keep).unwrap();
}

#[test]
fn branches_checkout_and_tags() {
    let r = TestRepo::new();
    let g = git();
    let c = r.commit_file("a", "1", "one");
    ops::branch_create(&g, &r.info, "b1", &c, false).unwrap();
    ops::branch_create(&g, &r.info, "b2", "HEAD", true).unwrap();
    assert_eq!(r.sh(&["branch", "--show-current"]), "b2");
    ops::checkout(&g, &r.info, "main", None).unwrap();
    ops::checkout(&g, &r.info, "main", Some("from-main")).unwrap();
    assert_eq!(r.sh(&["branch", "--show-current"]), "from-main");
    ops::branch_rename(&g, &r.info, "b1", "renamed").unwrap();
    ops::checkout(&g, &r.info, "main", None).unwrap();
    ops::branch_delete(&g, &r.info, "renamed", false, false).unwrap();
    ops::branch_delete(&g, &r.info, "b2", true, false).unwrap();
    assert!(ops::branch_delete(&g, &r.info, "does-not-exist", false, false).is_err());

    ops::tag_create(&g, &r.info, "light", &c, None).unwrap();
    ops::tag_create(&g, &r.info, "annot", "", Some("release")).unwrap();
    let rf = refs::read_refs(&g, &r.info).unwrap();
    assert!(
        !rf.tags
            .iter()
            .find(|t| t.name == "light")
            .unwrap()
            .annotated
    );
    assert!(
        rf.tags
            .iter()
            .find(|t| t.name == "annot")
            .unwrap()
            .annotated
    );
    ops::tag_delete(&g, &r.info, "light").unwrap();
    assert!(!refs::read_refs(&g, &r.info)
        .unwrap()
        .tags
        .iter()
        .any(|t| t.name == "light"));
}

#[test]
fn stash_save_pop_apply_drop() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a.txt", "1\n", "init");
    r.write("a.txt", "dirty\n");
    r.write("u.txt", "untracked\n");

    let res = ops::stash_save(&g, &r.info, Some("wip"), true, false).unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(r.read("a.txt"), "1\n");
    assert!(!r.path().join("u.txt").exists());
    let stashes = refs::read_refs(&g, &r.info).unwrap().stashes;
    assert_eq!(stashes.len(), 1);
    assert!(stashes[0].message.contains("wip"));

    assert!(ops::stash_pop(&g, &r.info, 0, None).unwrap().ok);
    assert_eq!(r.read("a.txt"), "dirty\n");
    assert!(r.path().join("u.txt").exists());
    assert!(refs::read_refs(&g, &r.info).unwrap().stashes.is_empty());

    // keep-index, apply and drop
    ops::stage(&g, &r.info, &strs(&["a.txt"])).unwrap();
    ops::stash_save(&g, &r.info, None, false, true).unwrap();
    assert_eq!(status::working_tree(&g, &r.info).unwrap().staged.len(), 1);
    ops::stash_apply(&g, &r.info, 0, None).ok();
    assert_eq!(refs::read_refs(&g, &r.info).unwrap().stashes.len(), 1);
    assert!(ops::stash_drop(&g, &r.info, 0, None).unwrap().ok);
    assert!(refs::read_refs(&g, &r.info).unwrap().stashes.is_empty());
}

#[test]
fn stash_pop_conflict_reports_conflicts() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a.txt", "1\n", "init");
    r.write("a.txt", "stashed\n");
    ops::stash_save(&g, &r.info, None, false, false).unwrap();
    r.commit_file("a.txt", "committed\n", "other change");
    let res = ops::stash_pop(&g, &r.info, 0, None).unwrap();
    assert!(!res.ok && res.conflicts);
}

#[test]
fn push_pull_fetch_with_a_bare_remote() {
    let dir = tempfile::tempdir().unwrap();
    let bare = dir.path().join("remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    sh(&bare, &["init", "-q", "--bare", "-b", "main"], None);

    let a = TestRepo::named("a");
    let g = git();
    a.sh(&["remote", "add", "origin", bare.to_str().unwrap()]);
    a.commit_file("f", "1\n", "one");
    let res = ops::push(
        &g,
        &a.info,
        Some("origin"),
        Some("main"),
        false,
        true,
        false,
    )
    .unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(
        refs::repo_summary(&g, &a.info).unwrap().upstream.as_deref(),
        Some("origin/main")
    );

    // A second clone pushes a commit, the first one fetches and pulls it.
    let b_path = dir.path().join("b");
    sh(
        dir.path(),
        &[
            "clone",
            "-q",
            bare.to_str().unwrap(),
            b_path.to_str().unwrap(),
        ],
        None,
    );
    for (k, v) in [
        ("user.name", "B"),
        ("user.email", "b@e.com"),
        ("commit.gpgsign", "false"),
    ] {
        sh(&b_path, &["config", k, v], None);
    }
    std::fs::write(b_path.join("g"), "2\n").unwrap();
    sh(&b_path, &["add", "-A"], None);
    sh(&b_path, &["commit", "-q", "-m", "from b"], None);
    sh(&b_path, &["push", "-q"], None);

    assert!(ops::fetch(&g, &a.info, None, true).unwrap().ok);
    assert_eq!(refs::repo_summary(&g, &a.info).unwrap().behind, 1);
    assert!(ops::pull(&g, &a.info, false).unwrap().ok);
    assert_eq!(a.read("g"), "2\n");

    // Rejected push (non fast-forward) is an error.
    a.commit_file("h", "3\n", "local");
    sh(&b_path, &["pull", "-q", "--no-rebase"], None);
    std::fs::write(b_path.join("i"), "4\n").unwrap();
    sh(&b_path, &["add", "-A"], None);
    sh(&b_path, &["commit", "-q", "-m", "b again"], None);
    sh(&b_path, &["push", "-q"], None);
    assert!(ops::push(&g, &a.info, None, None, false, false, false).is_err());

    // Tags and remote branch deletion.
    ops::tag_create(&g, &a.info, "v1", "", None).unwrap();
    assert!(
        ops::push(&g, &a.info, Some("origin"), None, false, false, true)
            .unwrap()
            .ok
    );
    assert!(sh(&bare, &["tag", "-l"], None).contains("v1"));
    a.sh(&["branch", "gone-soon"]);
    ops::push(
        &g,
        &a.info,
        Some("origin"),
        Some("gone-soon"),
        false,
        false,
        false,
    )
    .unwrap();
    assert!(
        ops::branch_delete(&g, &a.info, "origin/gone-soon", false, true)
            .unwrap()
            .ok
    );
}
