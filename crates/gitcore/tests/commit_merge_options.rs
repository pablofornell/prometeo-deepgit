//! Sign-off on commit (`--signoff`) and the merge modes and options of the merge dialog.

mod common;

use common::*;
use gitcore::{ops, refs, state, status, ApiError, GitError, MergeMode, MergeOpts, RepoStateKind};

const SIGNOFF: &str = "Signed-off-by: Test <test@example.com>";

fn stage_file(r: &TestRepo, name: &str, content: &str) {
    r.write(name, content);
    r.sh(&["add", name]);
}

fn body(r: &TestRepo) -> String {
    r.sh(&["log", "-1", "--format=%B"])
}

fn count(text: &str, needle: &str) -> usize {
    text.lines().filter(|l| l.trim_end() == needle).count()
}

#[test]
fn commit_with_sign_off_adds_the_trailer_once() {
    let r = TestRepo::new();
    let g = git();
    stage_file(&r, "a", "1");
    ops::commit(&g, &r.info, "first\n\nbody", false, true).unwrap();
    let text = body(&r);
    assert_eq!(text, format!("first\n\nbody\n\n{SIGNOFF}"));
}

#[test]
fn commit_without_sign_off_has_no_trailer() {
    let r = TestRepo::new();
    let g = git();
    stage_file(&r, "a", "1");
    ops::commit(&g, &r.info, "first", false, false).unwrap();
    assert!(!body(&r).contains("Signed-off-by"));
}

#[test]
fn amend_with_sign_off_adds_the_trailer_when_missing_and_never_twice() {
    let r = TestRepo::new();
    let g = git();
    stage_file(&r, "a", "1");
    ops::commit(&g, &r.info, "first", false, false).unwrap();

    // `--amend --no-edit --signoff`: the trailer is added...
    ops::commit(&g, &r.info, "", true, true).unwrap();
    assert_eq!(count(&body(&r), SIGNOFF), 1);
    assert_eq!(r.sh(&["rev-list", "--count", "HEAD"]), "1");
    // ...and not added again.
    ops::commit(&g, &r.info, "", true, true).unwrap();
    assert_eq!(count(&body(&r), SIGNOFF), 1);

    // The message the UI sends after "Amend" already holds the trailer.
    ops::commit(&g, &r.info, &format!("reworded\n\n{SIGNOFF}"), true, true).unwrap();
    assert_eq!(body(&r), format!("reworded\n\n{SIGNOFF}"));

    // A new message without the trailer gets it.
    ops::commit(&g, &r.info, "plain", true, true).unwrap();
    assert_eq!(body(&r), format!("plain\n\n{SIGNOFF}"));
}

#[test]
fn a_sign_off_followed_by_another_trailer_is_not_repeated() {
    // git alone would add a second line here: it only looks at the last trailer.
    let r = TestRepo::new();
    let g = git();
    stage_file(&r, "a", "1");
    let message = format!("first\n\n{SIGNOFF}\nCo-authored-by: Ann <ann@example.com>");
    ops::commit(&g, &r.info, &message, false, true).unwrap();
    assert_eq!(count(&body(&r), SIGNOFF), 1);
    ops::commit(&g, &r.info, "", true, true).unwrap();
    assert_eq!(count(&body(&r), SIGNOFF), 1);
    ops::commit(&g, &r.info, &message, true, true).unwrap();
    assert_eq!(count(&body(&r), SIGNOFF), 1);
}

#[test]
fn sign_off_uses_the_committer_identity() {
    let r = TestRepo::new();
    let g = git();
    r.sh(&["config", "user.name", "Zed Zeta"]);
    r.sh(&["config", "user.email", "zed@example.org"]);
    stage_file(&r, "a", "1");
    ops::commit(&g, &r.info, "first", false, true).unwrap();
    assert!(body(&r).ends_with("Signed-off-by: Zed Zeta <zed@example.org>"));
    ops::commit(&g, &r.info, "", true, true).unwrap();
    assert_eq!(
        count(&body(&r), "Signed-off-by: Zed Zeta <zed@example.org>"),
        1
    );
}

// ---------------------------------------------------------------- merge

fn opts(mode: MergeMode) -> MergeOpts {
    MergeOpts {
        mode,
        ..MergeOpts::default()
    }
}

/// `main` and `other` have each one commit since `base`.
fn diverged() -> TestRepo {
    let r = TestRepo::new();
    r.commit_file("base", "1", "base");
    r.sh(&["checkout", "-q", "-b", "other"]);
    r.commit_file("other", "1", "on other");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("main", "1", "on main");
    r
}

/// `main` is behind `other`: a merge can fast-forward.
fn ahead() -> TestRepo {
    let r = TestRepo::new();
    r.commit_file("base", "1", "base");
    r.sh(&["checkout", "-q", "-b", "other"]);
    r.commit_file("other", "1", "on other");
    r.sh(&["checkout", "-q", "main"]);
    r
}

fn parents(r: &TestRepo) -> usize {
    r.sh(&["rev-list", "--parents", "-n", "1", "HEAD"])
        .split(' ')
        .count()
        - 1
}

fn merge_head_exists(r: &TestRepo) -> bool {
    r.path().join(".git/MERGE_HEAD").exists()
}

fn message_of(e: GitError) -> String {
    ApiError::from(e).message
}

#[test]
fn default_mode_fast_forwards_when_it_can_and_merges_when_it_cannot() {
    let r = ahead();
    let g = git();
    let tip = r.sh(&["rev-parse", "other"]);
    assert!(
        ops::merge(&g, &r.info, "other", &opts(MergeMode::Ff))
            .unwrap()
            .ok
    );
    assert_eq!(r.head(), tip);

    let r = diverged();
    assert!(
        ops::merge(&g, &r.info, "other", &opts(MergeMode::Ff))
            .unwrap()
            .ok
    );
    assert_eq!(parents(&r), 2);
}

#[test]
fn no_ff_always_creates_a_merge_commit() {
    let r = ahead();
    let g = git();
    let before = r.head();
    assert!(
        ops::merge(&g, &r.info, "other", &opts(MergeMode::NoFf))
            .unwrap()
            .ok
    );
    assert_eq!(parents(&r), 2);
    assert_eq!(r.sh(&["rev-parse", "HEAD^1"]), before);
}

#[test]
fn ff_only_fast_forwards_or_refuses_with_a_clear_message() {
    let g = git();
    let r = ahead();
    let tip = r.sh(&["rev-parse", "other"]);
    assert!(
        ops::merge(&g, &r.info, "other", &opts(MergeMode::FfOnly))
            .unwrap()
            .ok
    );
    assert_eq!(r.head(), tip);

    let r = diverged();
    let before = r.head();
    let err = ops::merge(&g, &r.info, "other", &opts(MergeMode::FfOnly)).unwrap_err();
    assert_eq!(
        message_of(err),
        "Cannot fast-forward: the branches have diverged. Choose another merge mode."
    );
    assert_eq!(r.head(), before);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
}

#[test]
fn squash_stages_the_changes_and_leaves_no_merge_head() {
    let r = diverged();
    let g = git();
    let before = r.head();
    assert!(
        ops::merge(&g, &r.info, "other", &opts(MergeMode::Squash))
            .unwrap()
            .ok
    );
    assert_eq!(r.head(), before);
    assert!(!merge_head_exists(&r));
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
    let tree = status::working_tree(&g, &r.info).unwrap();
    assert_eq!(tree.staged.len(), 1);
    assert_eq!(tree.staged[0].path, "other");
}

#[test]
fn the_message_goes_into_the_merge_commit() {
    let r = diverged();
    let g = git();
    let o = MergeOpts {
        message: Some("Bring in other\n\n- it has a body\n- and a bullet list".into()),
        ..opts(MergeMode::Ff)
    };
    assert!(ops::merge(&g, &r.info, "other", &o).unwrap().ok);
    assert_eq!(
        body(&r),
        "Bring in other\n\n- it has a body\n- and a bullet list"
    );
    assert_eq!(parents(&r), 2);
}

#[test]
fn a_message_that_looks_like_an_option_is_still_a_message() {
    let r = ahead();
    let g = git();
    let o = MergeOpts {
        message: Some("--abort everything".into()),
        ..opts(MergeMode::NoFf)
    };
    assert!(ops::merge(&g, &r.info, "other", &o).unwrap().ok);
    assert_eq!(body(&r), "--abort everything");
}

#[test]
fn a_blank_message_keeps_the_default_one() {
    let r = diverged();
    let g = git();
    let o = MergeOpts {
        message: Some("  \n ".into()),
        ..opts(MergeMode::Ff)
    };
    assert!(ops::merge(&g, &r.info, "other", &o).unwrap().ok);
    assert_eq!(body(&r), "Merge branch 'other'");
}

#[test]
fn no_commit_stops_before_the_merge_commit() {
    let r = diverged();
    let g = git();
    let before = r.head();
    let o = MergeOpts {
        no_commit: true,
        ..opts(MergeMode::Ff)
    };
    let res = ops::merge(&g, &r.info, "other", &o).unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(r.head(), before);
    assert!(merge_head_exists(&r));
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Merging);
    assert_eq!(refs::repo_summary(&g, &r.info).unwrap().staged, 1);
    // The merge is finished from the commit box, which is a plain commit.
    ops::commit(&g, &r.info, "Merge by hand", false, false).unwrap();
    assert_eq!(parents(&r), 2);
}

#[test]
fn options_that_do_not_go_together_are_refused_and_nothing_runs() {
    let r = diverged();
    let g = git();
    let before = r.head();
    let msg = Some("m".to_string());
    let bad = [
        MergeOpts {
            message: msg.clone(),
            ..opts(MergeMode::FfOnly)
        },
        MergeOpts {
            message: msg.clone(),
            ..opts(MergeMode::Squash)
        },
        MergeOpts {
            message: msg.clone(),
            no_commit: true,
            ..opts(MergeMode::Ff)
        },
        MergeOpts {
            no_commit: true,
            ..opts(MergeMode::FfOnly)
        },
        MergeOpts {
            no_commit: true,
            ..opts(MergeMode::Squash)
        },
        MergeOpts {
            message: Some("a\0b".into()),
            ..opts(MergeMode::Ff)
        },
    ];
    for o in &bad {
        let e = ops::merge(&g, &r.info, "other", o).unwrap_err();
        assert!(matches!(e, GitError::Invalid(_)), "{o:?}: {e}");
    }
    assert_eq!(r.head(), before);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
    // The target is checked as before.
    assert!(matches!(
        ops::merge(&g, &r.info, "--abort", &MergeOpts::default()),
        Err(GitError::Invalid(_))
    ));
}

#[test]
fn unrelated_histories_need_the_option() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("a", "1", "a");
    r.sh(&["checkout", "-q", "--orphan", "orphan"]);
    r.sh(&["rm", "-rfq", "."]);
    r.commit_file("z", "1", "z");
    r.sh(&["checkout", "-q", "main"]);
    let e = ops::merge(&g, &r.info, "orphan", &MergeOpts::default()).unwrap_err();
    assert!(message_of(e).starts_with("The branches have no common history."));
    let o = MergeOpts {
        allow_unrelated_histories: true,
        ..MergeOpts::default()
    };
    assert!(ops::merge(&g, &r.info, "orphan", &o).unwrap().ok);
    assert_eq!(parents(&r), 2);
}

#[test]
fn conflicts_still_come_back_as_a_result_with_options() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("c.txt", "base\n", "base");
    r.sh(&["checkout", "-q", "-b", "other"]);
    r.commit_file("c.txt", "other\n", "other");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("c.txt", "main\n", "main");
    let o = MergeOpts {
        message: Some("custom".into()),
        ..opts(MergeMode::NoFf)
    };
    let res = ops::merge(&g, &r.info, "other", &o).unwrap();
    assert!(!res.ok && res.conflicts);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Merging);
}

#[test]
fn merge_options_json_matches_the_frontend() {
    let d: MergeOpts = serde_json::from_str("{}").unwrap();
    assert_eq!(d, MergeOpts::default());
    assert_eq!(d.mode, MergeMode::Ff);
    let o: MergeOpts = serde_json::from_str(
        r#"{"mode":"ffOnly","message":null,"noCommit":false,"allowUnrelatedHistories":true}"#,
    )
    .unwrap();
    assert_eq!(o.mode, MergeMode::FfOnly);
    assert!(o.allow_unrelated_histories);
    let o: MergeOpts =
        serde_json::from_str(r#"{"mode":"noFf","message":"x","noCommit":true}"#).unwrap();
    assert_eq!(
        (o.mode, o.message.as_deref(), o.no_commit),
        (MergeMode::NoFf, Some("x"), true)
    );
    assert!(serde_json::from_str::<MergeOpts>(r#"{"mode":"rebase"}"#).is_err());
}
