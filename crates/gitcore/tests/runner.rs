mod common;

use std::sync::{Arc, Mutex};

use common::*;
use gitcore::{ApiError, ConsoleEntry, Git, GitError};

#[test]
fn reports_console_entries_with_increasing_ids() {
    let r = TestRepo::new();
    r.commit_file("a", "1", "one");
    let seen: Arc<Mutex<Vec<ConsoleEntry>>> = Arc::default();
    let sink = seen.clone();
    let g = Git::new(None).with_sink(Arc::new(move |e| sink.lock().unwrap().push(e)));
    g.run(r.path(), Some("r1"), &["rev-parse", "HEAD"], false)
        .unwrap();
    g.run(r.path(), None, &["status", "--short"], false)
        .unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].repo_id.as_deref(), Some("r1"));
    assert_eq!(seen[0].args, vec!["rev-parse", "HEAD"]);
    assert_eq!(seen[0].exit_code, Some(0));
    assert_eq!(seen[0].stdout.trim(), r.head());
    assert!(seen[1].id > seen[0].id);
    assert!(seen[0].started_at > 1_600_000_000_000);
}

#[test]
fn non_zero_exit_is_a_command_error_and_output_is_truncated_in_the_entry() {
    let r = TestRepo::new();
    let seen: Arc<Mutex<Vec<ConsoleEntry>>> = Arc::default();
    let sink = seen.clone();
    let g = Git::new(None).with_sink(Arc::new(move |e| sink.lock().unwrap().push(e)));
    let err = g
        .run(r.path(), None, &["rev-parse", "--verify", "nope"], false)
        .unwrap_err();
    match &err {
        GitError::Command { args, code, stderr } => {
            assert_eq!(args, &["rev-parse", "--verify", "nope"]);
            assert_eq!(*code, 128);
            assert!(!stderr.is_empty());
        }
        other => panic!("unexpected {other:?}"),
    }
    let api: ApiError = err.into();
    assert!(api.message.contains("fatal") || api.message.contains("Needed"));
    assert!(api.detail.is_some());
    assert_eq!(seen.lock().unwrap()[0].exit_code, Some(128));

    // 100 KB of stdout is cut to ~8 KiB in the console entry.
    let big: String = "x".repeat(100_000);
    let out = g
        .run_stdin(
            r.path(),
            None,
            &["hash-object", "--stdin", "-w"],
            true,
            big.as_bytes(),
        )
        .unwrap();
    assert_eq!(out.stdout.trim().len(), 40);
    let out = g
        .run(
            r.path(),
            None,
            &["cat-file", "blob", out.stdout.trim()],
            false,
        )
        .unwrap();
    assert_eq!(out.stdout.len(), 100_000);
    let last = seen.lock().unwrap().last().cloned().unwrap();
    assert!(last.stdout.len() < 8 * 1024 + 32);
    assert!(last.stdout.ends_with("[truncated]"));
}

#[test]
fn outside_a_repo_is_not_a_repo_error() {
    let dir = tempfile::tempdir().unwrap();
    let g = Git::new(None);
    let err = g.run(dir.path(), None, &["status"], false).unwrap_err();
    assert!(matches!(err, GitError::NotARepo(_)), "{err:?}");
}

#[test]
fn missing_git_binary_is_an_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let g = Git::new(Some("/definitely/not/git".into()));
    assert!(matches!(
        g.run(dir.path(), None, &["status"], false),
        Err(GitError::Io(_))
    ));
}

#[test]
fn accepted_exit_codes_and_stdin() {
    let r = TestRepo::new();
    let g = Git::new(None);
    r.write("x.txt", "hi\n");
    let out = g
        .run_ok(
            r.path(),
            None,
            &["diff", "--no-index", "--", "/dev/null", "x.txt"],
            false,
            None,
            &[1],
        )
        .unwrap();
    assert_eq!(out.code, 1);
    assert!(out.stdout.contains("+hi"));
    assert!(g
        .run(
            r.path(),
            None,
            &["diff", "--no-index", "--", "/dev/null", "x.txt"],
            false
        )
        .is_err());
}
