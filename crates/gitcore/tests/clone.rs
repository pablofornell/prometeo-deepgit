//! `clone`: real clones from a local bare repository (`file://` and a plain path), the rules that
//! stop bad input, and cancel / timeout with a fake `git` that stays slow.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::time::{Duration, Instant};

use common::*;
use gitcore::clone::{plan_clone, run_clone, ProgressSink};
use gitcore::{clone, CancelToken, CloneOpts, CloneProgress, ConsoleEntry, Git, GitError};

/// A source repository with three commits on `main` and a branch `dev`, and a bare copy of it.
struct Source {
    _work: TestRepo,
    bare: tempfile::TempDir,
}

fn source() -> Source {
    let work = TestRepo::new();
    work.commit_file("a.txt", "1\n", "one");
    work.commit_file("b.txt", "2\n", "two");
    work.sh(&["checkout", "-q", "-b", "dev"]);
    work.commit_file("dev.txt", "d\n", "on dev");
    work.sh(&["checkout", "-q", "main"]);
    work.commit_file("c.txt", "3\n", "three");
    let bare = tempfile::tempdir().unwrap();
    let dest = bare.path().join("origin.git");
    let from = work.path().to_string_lossy().into_owned();
    sh(
        bare.path(),
        &["clone", "-q", "--bare", &from, &dest.to_string_lossy()],
        None,
    );
    Source { _work: work, bare }
}

impl Source {
    fn path(&self) -> String {
        self.bare
            .path()
            .join("origin.git")
            .to_string_lossy()
            .into_owned()
    }

    fn file_url(&self) -> String {
        format!("file://{}", self.path())
    }
}

type Events = Arc<Mutex<Vec<CloneProgress>>>;

fn collector() -> (Events, ProgressSink) {
    let events: Events = Arc::default();
    let sink = events.clone();
    (
        events,
        Arc::new(move |p| sink.lock().unwrap().push(p)) as ProgressSink,
    )
}

fn do_clone(
    url: &str,
    parent: &Path,
    name: &str,
    opts: &CloneOpts,
) -> (Result<PathBuf, GitError>, Events) {
    let (events, sink) = collector();
    let r = clone::clone(
        &git(),
        url,
        &parent.to_string_lossy(),
        name,
        opts,
        &CancelToken::new(),
        sink,
    );
    (r, events)
}

fn rev_count(repo: &Path) -> String {
    sh(repo, &["rev-list", "--count", "HEAD"], None)
}

#[test]
fn clones_from_a_file_url_with_progress() {
    let src = source();
    let parent = tempfile::tempdir().unwrap();
    let (r, events) = do_clone(
        &src.file_url(),
        parent.path(),
        "copy",
        &CloneOpts::default(),
    );
    let path = r.unwrap();
    assert_eq!(
        path,
        std::fs::canonicalize(parent.path()).unwrap().join("copy")
    );
    assert_eq!(rev_count(&path), "3");
    assert!(path.join("c.txt").exists());
    assert_eq!(
        sh(&path, &["rev-parse", "--abbrev-ref", "HEAD"], None),
        "main"
    );
    let events = events.lock().unwrap();
    assert!(!events.is_empty(), "no progress event");
    assert!(
        events
            .iter()
            .any(|e| e.phase == "Receiving objects" && e.percent == Some(100)),
        "{events:?}"
    );
    // each (phase, percent) once in a row
    assert!(events.windows(2).all(|w| w[0] != w[1]));
}

#[test]
fn clones_from_a_plain_path() {
    let src = source();
    let parent = tempfile::tempdir().unwrap();
    let (r, _) = do_clone(&src.path(), parent.path(), "plain", &CloneOpts::default());
    let path = r.unwrap();
    assert_eq!(rev_count(&path), "3");
    assert_eq!(
        sh(&path, &["remote", "get-url", "origin"], None),
        src.path()
    );
}

#[test]
fn branch_and_depth_are_passed_to_git() {
    let src = source();
    let parent = tempfile::tempdir().unwrap();
    let opts = CloneOpts {
        branch: Some("dev".into()),
        depth: Some(1),
        recurse_submodules: false,
    };
    let (r, _) = do_clone(&src.file_url(), parent.path(), "shallow", &opts);
    let path = r.unwrap();
    assert_eq!(
        sh(&path, &["rev-parse", "--abbrev-ref", "HEAD"], None),
        "dev"
    );
    assert_eq!(rev_count(&path), "1");
    assert_eq!(
        sh(&path, &["rev-parse", "--is-shallow-repository"], None),
        "true"
    );
}

#[test]
fn recurse_submodules_flag_is_accepted() {
    let src = source();
    let parent = tempfile::tempdir().unwrap();
    let opts = CloneOpts {
        recurse_submodules: true,
        ..CloneOpts::default()
    };
    let (r, _) = do_clone(&src.file_url(), parent.path(), "subs", &opts);
    assert_eq!(rev_count(&r.unwrap()), "3");
}

#[test]
fn an_unknown_branch_fails_and_leaves_nothing() {
    let src = source();
    let parent = tempfile::tempdir().unwrap();
    let opts = CloneOpts {
        branch: Some("nope".into()),
        ..CloneOpts::default()
    };
    let (r, _) = do_clone(&src.file_url(), parent.path(), "gone", &opts);
    assert!(matches!(r, Err(GitError::Command { .. })), "{r:?}");
    assert!(!parent.path().join("gone").exists());
}

#[test]
fn a_missing_repository_fails_and_leaves_nothing() {
    let parent = tempfile::tempdir().unwrap();
    let url = format!("file://{}/nowhere.git", parent.path().display());
    let (r, _) = do_clone(&url, parent.path(), "x", &CloneOpts::default());
    assert!(r.is_err());
    assert!(!parent.path().join("x").exists());
}

#[test]
fn an_existing_empty_folder_is_used_and_kept_when_the_clone_fails() {
    let src = source();
    let parent = tempfile::tempdir().unwrap();
    std::fs::create_dir(parent.path().join("empty")).unwrap();
    let (r, _) = do_clone(
        &src.file_url(),
        parent.path(),
        "empty",
        &CloneOpts::default(),
    );
    assert_eq!(rev_count(&r.unwrap()), "3");

    std::fs::create_dir(parent.path().join("keep")).unwrap();
    let bad = CloneOpts {
        branch: Some("nope".into()),
        ..CloneOpts::default()
    };
    let (r, _) = do_clone(&src.file_url(), parent.path(), "keep", &bad);
    assert!(r.is_err());
    assert!(
        parent.path().join("keep").is_dir(),
        "the folder was there before"
    );
    assert_eq!(
        std::fs::read_dir(parent.path().join("keep"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn a_folder_with_files_is_never_touched() {
    let src = source();
    let parent = tempfile::tempdir().unwrap();
    std::fs::create_dir(parent.path().join("full")).unwrap();
    std::fs::write(parent.path().join("full/mine.txt"), "precious").unwrap();
    let (r, _) = do_clone(
        &src.file_url(),
        parent.path(),
        "full",
        &CloneOpts::default(),
    );
    assert!(matches!(r, Err(GitError::Invalid(_))));
    assert_eq!(
        std::fs::read_to_string(parent.path().join("full/mine.txt")).unwrap(),
        "precious"
    );
}

#[test]
fn bad_input_is_refused_before_git_runs() {
    let parent = tempfile::tempdir().unwrap();
    let o = CloneOpts::default();
    for url in ["", "-u", "--upload-pack=x", "ext::sh -c id"] {
        let (r, events) = do_clone(url, parent.path(), "x", &o);
        assert!(matches!(r, Err(GitError::Invalid(_))), "{url:?}");
        assert!(events.lock().unwrap().is_empty());
    }
    for name in ["", "..", "a/b", "../escape"] {
        let (r, _) = do_clone("file:///x", parent.path(), name, &o);
        assert!(matches!(r, Err(GitError::Invalid(_))), "{name:?}");
    }
    assert!(!parent.path().parent().unwrap().join("escape").exists());
}

#[test]
fn the_clone_is_reported_to_the_console_without_a_repo() {
    let src = source();
    let parent = tempfile::tempdir().unwrap();
    let seen: Arc<Mutex<Vec<ConsoleEntry>>> = Arc::default();
    let sink = seen.clone();
    let g = Git::new(None).with_sink(Arc::new(move |e| sink.lock().unwrap().push(e)));
    let plan = plan_clone(
        &src.file_url(),
        &parent.path().to_string_lossy(),
        "c",
        &CloneOpts::default(),
    )
    .unwrap();
    let (_, progress) = collector();
    run_clone(
        &g,
        &plan,
        &CloneOpts::default(),
        &CancelToken::new(),
        progress,
    )
    .unwrap();
    let seen = seen.lock().unwrap();
    let entry = seen
        .iter()
        .find(|e| e.args.iter().any(|a| a == "clone"))
        .unwrap();
    assert_eq!(entry.repo_id, None);
    assert_eq!(entry.exit_code, Some(0));
    let dd = entry.args.iter().position(|a| a == "--").unwrap();
    assert_eq!(entry.args[dd + 1], src.file_url());
}

// ---------------------------------------------------------------- cancel and timeout

/// A `git` that starts a clone (makes the folder, writes a file, prints one progress line) and then
/// waits for 30 s, like a slow server.
#[cfg(unix)]
fn slow_git(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("slow-git");
    let text = r#"#!/bin/sh
for a in "$@"; do
  last="$a"
  [ "$a" = "--version" ] && { echo "git version 2.43.0"; exit 0; }
  [ "$a" = "clone" ] && is_clone=1
done
[ -n "$is_clone" ] || exit 1
mkdir -p "$last"
echo partial > "$last/partial"
printf 'Receiving objects:  10%% (1/10)\r' >&2
exec sleep 30
"#;
    std::fs::write(&script, text).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[cfg(unix)]
fn wait_for(events: &Events, what: &str) {
    let t = Instant::now();
    while events.lock().unwrap().is_empty() {
        assert!(t.elapsed() < Duration::from_secs(10), "no progress: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[test]
fn cancel_stops_the_clone_and_removes_the_folder_it_created() {
    let tools = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let g = Git::new(Some(slow_git(tools.path())));
    let plan = plan_clone(
        "https://example.org/r.git",
        &parent.path().to_string_lossy(),
        "r",
        &CloneOpts::default(),
    )
    .unwrap();
    assert!(!plan.target_existed);
    let (events, sink) = collector();
    let cancel = CancelToken::new();
    let worker = {
        let (plan, cancel) = (plan.clone(), cancel.clone());
        std::thread::spawn(move || run_clone(&g, &plan, &CloneOpts::default(), &cancel, sink))
    };
    wait_for(&events, "cancel");
    assert!(plan.target.join("partial").exists(), "the clone started");
    let t = Instant::now();
    cancel.cancel();
    let r = worker.join().unwrap();
    assert!(matches!(r, Err(GitError::Cancelled)), "{r:?}");
    assert!(t.elapsed() < Duration::from_secs(5), "cancel was slow");
    assert!(!plan.target.exists(), "the partial folder must be gone");
    assert!(parent.path().exists());
    assert_eq!(events.lock().unwrap()[0].phase, "Receiving objects");
    assert_eq!(events.lock().unwrap()[0].percent, Some(10));
}

#[cfg(unix)]
#[test]
fn cancel_keeps_a_folder_that_existed_but_empties_it() {
    let tools = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    std::fs::create_dir(parent.path().join("pre")).unwrap();
    let g = Git::new(Some(slow_git(tools.path())));
    let plan = plan_clone(
        "https://example.org/r.git",
        &parent.path().to_string_lossy(),
        "pre",
        &CloneOpts::default(),
    )
    .unwrap();
    assert!(plan.target_existed);
    let (events, sink) = collector();
    let cancel = CancelToken::new();
    let worker = {
        let (plan, cancel) = (plan.clone(), cancel.clone());
        std::thread::spawn(move || run_clone(&g, &plan, &CloneOpts::default(), &cancel, sink))
    };
    wait_for(&events, "cancel existing");
    cancel.cancel();
    assert!(matches!(worker.join().unwrap(), Err(GitError::Cancelled)));
    assert!(plan.target.is_dir());
    assert_eq!(std::fs::read_dir(&plan.target).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn a_cancel_before_the_start_still_cleans_up() {
    let tools = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let g = Git::new(Some(slow_git(tools.path())));
    let cancel = CancelToken::new();
    cancel.cancel();
    let (_, sink) = collector();
    let r = clone::clone(
        &g,
        "https://example.org/r.git",
        &parent.path().to_string_lossy(),
        "r",
        &CloneOpts::default(),
        &cancel,
        sink,
    );
    assert!(matches!(r, Err(GitError::Cancelled)), "{r:?}");
    assert!(!parent.path().join("r").exists());
}

#[cfg(unix)]
#[test]
fn a_silent_clone_is_killed_after_the_inactivity_timeout() {
    let tools = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let g = Git::new(Some(slow_git(tools.path()))).with_network_timeout(Duration::from_millis(400));
    let (_, sink) = collector();
    let t = Instant::now();
    let r = clone::clone(
        &g,
        "https://example.org/r.git",
        &parent.path().to_string_lossy(),
        "r",
        &CloneOpts::default(),
        &CancelToken::new(),
        sink,
    );
    assert!(
        matches!(&r, Err(GitError::Timeout { command, .. }) if command == "clone"),
        "{r:?}"
    );
    assert!(t.elapsed() < Duration::from_secs(10));
    assert!(!parent.path().join("r").exists());
}
