//! Regression tests for the last review round of the Rust backend (cases `asc`, `race`, `cpe`,
//! `du` of the reviewer's probe, plus the timeout and push-refspec fixes).

mod common;

#[cfg(unix)]
use std::time::{Duration, Instant};

use common::*;
use gitcore::ops::HunkOpts;
#[cfg(unix)]
use gitcore::ApiError;
use gitcore::{diff, ops, refs, state, DiffSpec, GitError, RepoStateKind};

fn lines(n: usize, f: impl Fn(usize) -> String) -> String {
    (0..n).map(|i| f(i) + "\n").collect()
}

// ---------------------------------------------------------------- 2. autostash conflict

#[test]
fn autostash_conflict_after_a_successful_rebase_is_reported_as_conflicts() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "base\n", "base");
    r.sh(&["checkout", "-qb", "feat"]);
    r.commit_file("g", "feat\n", "F");
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file("f", "main\n", "M");
    r.sh(&["checkout", "-q", "feat"]);
    r.write("f", "dirty\n");
    let res = ops::rebase(&g, &r.info, "main").unwrap();
    assert!(!res.ok, "{res:?}");
    assert!(res.conflicts, "{res:?}");
    assert!(res.message.contains("stash@{0}"), "{}", res.message);
    assert!(res.message.starts_with("Rebase done"), "{}", res.message);
    // The changes really are kept in the stash and the file has conflict markers.
    assert_eq!(r.sh(&["stash", "list"]).lines().count(), 1);
    assert!(r.sh(&["status", "--short"]).contains("UU f"));
}

// ---------------------------------------------------------------- 4. hunk body identity

#[test]
fn a_hunk_with_the_same_header_but_other_content_is_refused() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", &lines(20, |i| format!("l{i}")), "init");
    let edit = |text: &str| {
        r.write(
            "f",
            &lines(20, |i| {
                if i == 10 {
                    text.to_string()
                } else {
                    format!("l{i}")
                }
            }),
        )
    };
    edit("seen");
    let ui = diff::file_diff(&g, &r.info, &DiffSpec::Unstaged, "f", None, 3).unwrap();
    let expected = ui.hunks[0].hunk_ref();
    assert!(expected.hash.is_some());
    // The user keeps editing the same line: the header numbers do not change.
    edit("UNSEEN work");
    let opts = HunkOpts {
        expected: Some(expected.clone()),
        ..HunkOpts::default()
    };
    for res in [
        ops::discard_hunk(&g, &r.info, "f", 0, &opts),
        ops::stage_hunk(&g, &r.info, "f", 0, false, &opts),
    ] {
        match res {
            Err(GitError::Invalid(m)) => assert_eq!(m, "The file changed. Reload the diff."),
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(r.read("f").contains("UNSEEN work"));
    assert_eq!(r.sh(&["diff", "--cached", "--name-only"]), "");

    // Without a hash only the header numbers are compared (older callers).
    let mut no_hash = expected.clone();
    no_hash.hash = None;
    ops::stage_hunk(
        &g,
        &r.info,
        "f",
        0,
        false,
        &HunkOpts {
            expected: Some(no_hash),
            ..HunkOpts::default()
        },
    )
    .unwrap();

    // A matching hash is accepted.
    let ui = diff::file_diff(&g, &r.info, &DiffSpec::Staged, "f", None, 3).unwrap();
    ops::stage_hunk(
        &g,
        &r.info,
        "f",
        0,
        true,
        &HunkOpts {
            expected: Some(ui.hunks[0].hunk_ref()),
            ..HunkOpts::default()
        },
    )
    .unwrap();
    assert_eq!(r.sh(&["diff", "--cached", "--name-only"]), "");
}

// ---------------------------------------------------------------- 8. continue stops without conflicts

#[test]
fn continue_that_stops_on_an_empty_commit_is_a_stopped_result() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "base\n", "base");
    r.sh(&["checkout", "-qb", "side"]);
    r.commit_file("f", "side\n", "A");
    r.commit_file("g", "g\n", "B");
    let b = r.head();
    let a = r.sh(&["rev-parse", "HEAD~"]);
    r.sh(&["checkout", "-q", "main"]);
    r.write("f", "main\n");
    r.write("g", "g\n");
    r.sh(&["add", "-A"]);
    r.sh(&["commit", "-qm", "M"]);
    let res = ops::cherry_pick(&g, &r.info, &[a, b]).unwrap();
    assert!(!res.ok && res.conflicts, "{res:?}");
    r.write("f", "resolved\n");
    r.sh(&["add", "f"]);
    // B is empty on top of A + M: continuing commits A, then stops on B.
    let res = ops::op_continue(&g, &r.info).unwrap();
    assert!(!res.ok, "{res:?}");
    assert!(!res.conflicts, "{res:?}");
    assert!(res.message.contains("empty"), "{}", res.message);
    assert_eq!(
        state::repo_state(r.path()).unwrap(),
        RepoStateKind::CherryPicking
    );
    // Skipping it finishes the operation.
    assert!(ops::op_skip(&g, &r.info).unwrap().ok);
    assert_eq!(state::repo_state(r.path()).unwrap(), RepoStateKind::Clean);
}

// ---------------------------------------------------------------- 10. push refspecs

fn bare_remote(r: &TestRepo) -> tempfile::TempDir {
    let up = tempfile::tempdir().unwrap();
    sh(up.path(), &["init", "-q", "--bare", "-b", "main"], None);
    r.sh(&["remote", "add", "origin", up.path().to_str().unwrap()]);
    up
}

#[test]
fn push_refuses_refspec_syntax_in_the_branch() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "1\n", "init");
    let up = bare_remote(&r);
    for bad in [
        "+main",
        ":main",
        "main:other",
        "main^",
        "main~1",
        "+refs/heads/main",
    ] {
        for res in [
            ops::push(&g, &r.info, Some("origin"), Some(bad), false, false, false),
            ops::branch_delete(&g, &r.info, &format!("origin/{bad}"), false, true),
        ] {
            assert!(matches!(res, Err(GitError::Invalid(_))), "{bad}: {res:?}");
        }
    }
    assert_eq!(sh(up.path(), &["branch"], None), "");
}

#[test]
fn push_uses_a_fully_qualified_refspec() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "1\n", "init");
    // A tag with the branch's name would make a bare `main` ambiguous.
    r.sh(&["tag", "main"]);
    let up = bare_remote(&r);
    let res = ops::push(
        &g,
        &r.info,
        Some("origin"),
        Some("main"),
        false,
        true,
        false,
    )
    .unwrap();
    assert!(res.ok, "{res:?}");
    assert_eq!(
        sh(up.path(), &["rev-parse", "refs/heads/main"], None),
        r.head()
    );
    assert!(sh(up.path(), &["tag"], None).is_empty());
}

// ---------------------------------------------------------------- remote branch delete by full name

#[test]
fn deleting_a_remote_branch_by_its_full_name_works() {
    let r = TestRepo::new();
    let g = git();
    r.commit_file("f", "1\n", "init");
    let up = bare_remote(&r);
    r.sh(&["push", "-q", "origin", "main", "main:develop"]);
    r.sh(&["fetch", "-q"]);
    ops::branch_create(&g, &r.info, "feature", "origin/develop", true).unwrap();
    let list = refs::read_refs(&g, &r.info).unwrap();
    let full = list
        .local
        .iter()
        .find(|b| b.name == "feature")
        .and_then(|b| b.upstream.clone())
        .expect("upstream");
    assert_eq!(full, "origin/develop");
    r.sh(&["checkout", "-q", "main"]);
    let res = ops::branch_delete(&g, &r.info, &full, false, true).unwrap();
    assert!(res.ok, "{res:?}");
    assert_eq!(sh(up.path(), &["branch"], None), "* main");
}

// ---------------------------------------------------------------- 6/7. network timeouts
//
// Unix only: the remote's transport is a `#!/bin/sh` script that git runs as a program, which
// Windows cannot do. The time limits of network commands stay untested on Windows.

#[cfg(unix)]
fn ext_remote(r: &TestRepo, script_body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let script = r.path().join(".git").join("transport.sh");
    std::fs::write(&script, format!("#!/bin/sh\n{script_body}\n")).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    r.sh(&["config", "protocol.ext.allow", "always"]);
    r.sh(&["remote", "add", "x", &format!("ext::{}", script.display())]);
}

/// The transport prints to stderr (which the runner reads) every 200 ms for about 3 s, then fails.
#[cfg(unix)]
const CHATTY: &str =
    "i=0\nwhile [ $i -lt 15 ]; do echo tick >&2; sleep 0.2; i=$((i+1)); done\nexit 1";

#[cfg(unix)]
#[test]
fn output_resets_the_inactivity_timeout() {
    let r = TestRepo::new();
    r.commit_file("a", "1\n", "init");
    ext_remote(&r, CHATTY);
    // The command runs ~3 s, far past the 1 s inactivity limit, but never stays silent for 1 s.
    let g = git().with_network_timeout(Duration::from_secs(1));
    let err = ops::fetch(&g, &r.info, Some("x"), false).unwrap_err();
    assert!(!matches!(err, GitError::Timeout { .. }), "{err:?}");
}

#[cfg(unix)]
#[test]
fn the_absolute_cap_still_stops_a_chatty_command() {
    let r = TestRepo::new();
    r.commit_file("a", "1\n", "init");
    ext_remote(&r, CHATTY);
    let g = git()
        .with_network_timeout(Duration::from_secs(1))
        .with_network_cap(Duration::from_millis(1200));
    let start = Instant::now();
    let err = ops::fetch(&g, &r.info, Some("x"), false).unwrap_err();
    assert!(matches!(err, GitError::Timeout { .. }), "{err:?}");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "{:?}",
        start.elapsed()
    );
}

#[cfg(unix)]
#[test]
fn a_pull_killed_with_a_lock_file_left_says_so() {
    let r = TestRepo::new();
    r.commit_file("a", "1\n", "init");
    ext_remote(&r, "sleep 60");
    r.sh(&["config", "branch.main.remote", "x"]);
    r.sh(&["config", "branch.main.merge", "refs/heads/main"]);
    std::fs::write(r.path().join(".git").join("index.lock"), "").unwrap();
    let g = git().with_network_timeout(Duration::from_millis(500));
    let err = ops::pull(&g, &r.info, false).unwrap_err();
    assert!(matches!(err, GitError::Timeout { .. }), "{err:?}");
    let api: ApiError = err.into();
    assert!(api.message.contains(".git/index.lock"), "{}", api.message);
    // The lock is left alone.
    assert!(r.path().join(".git").join("index.lock").exists());
}

#[cfg(unix)]
#[test]
fn a_timeout_without_a_lock_file_has_no_lock_hint() {
    let r = TestRepo::new();
    r.commit_file("a", "1\n", "init");
    ext_remote(&r, "sleep 60");
    let g = git().with_network_timeout(Duration::from_millis(500));
    let err = ops::fetch(&g, &r.info, Some("x"), false).unwrap_err();
    assert!(!err.to_string().contains("lock"), "{err}");
}
