//! The runner side of authentication: what a network command gets in its environment, that it
//! runs in its own session, that the broker hears the outcome, and that an open prompt pauses
//! the inactivity timeout. A fake broker stands in for the app.
#![cfg(unix)]

mod common;

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{git, TestRepo};
use gitcore::{ops, AuthBroker, AuthContext, AuthMode, AuthOp, AuthTicket, GitError};

#[derive(Default)]
struct Fake {
    /// (mode, repo id, command) of every `begin`.
    begun: Mutex<Vec<(AuthMode, Option<String>, String)>>,
    /// (success, stderr) of every finished command.
    outcomes: Arc<Mutex<Vec<(bool, String)>>>,
    /// The counter the runner watches; tests raise it to fake an open dialog.
    prompting: Arc<AtomicUsize>,
}

impl AuthBroker for Fake {
    fn begin(&self, mode: AuthMode, op: &AuthOp<'_>) -> Option<AuthTicket> {
        self.begun.lock().unwrap().push((
            mode,
            op.repo_id.map(str::to_string),
            op.command.to_string(),
        ));
        if mode == AuthMode::None {
            return None;
        }
        let outcomes = self.outcomes.clone();
        Some(AuthTicket::new(
            AuthContext {
                helper: "/opt/deepgit/helper".into(),
                env: vec![("DEEPGIT_ASKPASS_TOKEN".into(), "tok-123".into())],
                prompting: self.prompting.clone(),
            },
            Box::new(move |o| {
                outcomes
                    .lock()
                    .unwrap()
                    .push((o.success, o.stderr.to_string()));
            }),
        ))
    }
}

/// A remote whose transport runs `script_body` (it can write files, print, sleep, exit).
fn ext_remote(r: &TestRepo, script_body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let script = r.path().join(".git").join("transport.sh");
    std::fs::write(&script, format!("#!/bin/sh\n{script_body}\n")).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    r.sh(&["config", "protocol.ext.allow", "always"]);
    r.sh(&["remote", "add", "x", &format!("ext::{}", script.display())]);
}

fn repo_with_commit() -> TestRepo {
    let r = TestRepo::new();
    r.commit_file("a", "1\n", "init");
    r
}

/// Dumps the variables the transport sees into `out`, then fails like a rejected login.
fn dump_env_script(out: &Path) -> String {
    format!(
        "env | grep -E '^(GIT_ASKPASS|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|GIT_TERMINAL_PROMPT|DEEPGIT_ASKPASS_TOKEN|GIT_SSH_COMMAND)=' | sort > {}\nexit 1",
        out.display()
    )
}

fn env_dump(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[test]
fn interactive_commands_get_the_helper_and_no_batch_mode() {
    let r = repo_with_commit();
    let out = r.path().join("env.txt");
    ext_remote(&r, &dump_env_script(&out));
    let fake = Arc::new(Fake::default());
    let g = git().with_auth(fake.clone());
    let _ = ops::fetch(&g, &r.info, Some("x"), false);
    let env = env_dump(&out);
    assert!(env.contains("GIT_ASKPASS=/opt/deepgit/helper\n"), "{env}");
    assert!(env.contains("SSH_ASKPASS=/opt/deepgit/helper\n"), "{env}");
    assert!(env.contains("SSH_ASKPASS_REQUIRE=force\n"), "{env}");
    assert!(env.contains("GIT_TERMINAL_PROMPT=0\n"), "{env}");
    assert!(env.contains("DEEPGIT_ASKPASS_TOKEN=tok-123\n"), "{env}");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        assert!(
            !env.contains("GIT_SSH_COMMAND"),
            "BatchMode would block passphrases: {env}"
        );
    }
    let begun = fake.begun.lock().unwrap();
    assert_eq!(begun.len(), 1);
    assert_eq!(begun[0].0, AuthMode::Interactive);
    assert_eq!(begun[0].1.as_deref(), Some(r.info.id.as_str()));
    assert_eq!(begun[0].2, "git fetch");
}

#[test]
fn silent_commands_get_the_helper_for_git_but_ssh_stays_in_batch_mode() {
    let r = repo_with_commit();
    let out = r.path().join("env.txt");
    ext_remote(&r, &dump_env_script(&out));
    let g = git()
        .with_auth(Arc::new(Fake::default()))
        .with_auth_mode(AuthMode::Silent);
    let _ = ops::fetch(&g, &r.info, Some("x"), false);
    let env = env_dump(&out);
    assert!(env.contains("GIT_ASKPASS=/opt/deepgit/helper\n"), "{env}");
    assert!(env.contains("SSH_ASKPASS_REQUIRE=never\n"), "{env}");
    // (the user's own SSH_ASKPASS may pass through; ours must not)
    assert!(!env.contains("SSH_ASKPASS=/opt/deepgit"), "{env}");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        assert!(
            env.contains("GIT_SSH_COMMAND=ssh -o BatchMode=yes\n"),
            "{env}"
        );
    }
}

#[test]
fn without_a_broker_or_in_mode_none_nothing_asks() {
    let r = repo_with_commit();
    let out = r.path().join("env.txt");
    ext_remote(&r, &dump_env_script(&out));
    let _ = ops::fetch(&git(), &r.info, Some("x"), false);
    let env = env_dump(&out);
    assert!(!env.contains("/opt/deepgit"), "{env}");
    assert!(env.contains("SSH_ASKPASS_REQUIRE=never\n"), "{env}");

    std::fs::remove_file(&out).unwrap();
    let g = git()
        .with_auth(Arc::new(Fake::default()))
        .with_auth_mode(AuthMode::None);
    let _ = ops::fetch(&g, &r.info, Some("x"), false);
    let env = env_dump(&out);
    assert!(!env.contains("/opt/deepgit"), "{env}");
    assert!(env.contains("SSH_ASKPASS_REQUIRE=never\n"), "{env}");
}

#[test]
fn a_user_ssh_command_is_not_replaced_in_interactive_mode() {
    let r = repo_with_commit();
    let out = r.path().join("env.txt");
    ext_remote(&r, &dump_env_script(&out));
    r.sh(&["config", "core.sshCommand", "ssh -v"]);
    let g = git().with_auth(Arc::new(Fake::default()));
    let _ = ops::fetch(&g, &r.info, Some("x"), false);
    let env = env_dump(&out);
    assert!(
        !env.contains("GIT_SSH_COMMAND"),
        "core.sshCommand stays in charge: {env}"
    );
    assert!(env.contains("SSH_ASKPASS_REQUIRE=force\n"), "{env}");
}

#[test]
fn only_network_commands_get_the_auth_environment() {
    let r = repo_with_commit();
    let fake = Arc::new(Fake::default());
    let g = git().with_auth(fake.clone());
    g.run(
        r.path(),
        Some(&r.info.id),
        &["status", "--porcelain"],
        false,
    )
    .unwrap();
    assert!(fake.begun.lock().unwrap().is_empty());
}

#[test]
fn the_network_command_runs_in_its_own_session_without_a_terminal() {
    let r = repo_with_commit();
    // The transport writes its pid and waits (at most 10 s) until the test has looked at it.
    // `ps -o sid=` would be shorter, but the `ps` of macOS has no session id column.
    let pid_file = r.path().join("pid.txt");
    let seen = r.path().join("seen");
    ext_remote(
        &r,
        &format!(
            "echo $$ > '{pid}.tmp' && mv '{pid}.tmp' '{pid}'\n\
             i=0\nwhile [ ! -e '{seen}' ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done\nexit 1",
            pid = pid_file.display(),
            seen = seen.display()
        ),
    );
    let g = git().with_auth(Arc::new(Fake::default()));
    let info = r.info.clone();
    let fetch = std::thread::spawn(move || {
        let _ = ops::fetch(&g, &info, Some("x"), false);
    });
    let started = Instant::now();
    while !pid_file.exists() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the transport did not start"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let pid: i32 = env_dump(&pid_file)
        .trim()
        .parse()
        .expect("the transport wrote its pid");
    // SAFETY: getsid(2) only reads the session id of a process.
    let (sid, mine) = unsafe { (libc::getsid(pid), libc::getsid(0)) };
    let errno = std::io::Error::last_os_error();
    std::fs::write(&seen, "").unwrap();
    fetch.join().unwrap();
    assert_ne!(sid, -1, "getsid({pid}): {errno}");
    assert_ne!(
        sid, mine,
        "the command must not share the app's session (and its terminal)"
    );
}

#[test]
fn the_broker_hears_the_outcome_once_with_stderr() {
    let r = repo_with_commit();
    ext_remote(&r, "echo 'fatal: Authentication failed for x' >&2\nexit 1");
    let fake = Arc::new(Fake::default());
    let g = git().with_auth(fake.clone());
    let err = ops::fetch(&g, &r.info, Some("x"), false).unwrap_err();
    assert!(matches!(err, GitError::Command { .. }), "{err:?}");
    let outcomes = fake.outcomes.lock().unwrap();
    assert_eq!(outcomes.len(), 1);
    assert!(!outcomes[0].0);
    assert!(
        outcomes[0].1.contains("Authentication failed"),
        "{:?}",
        outcomes[0]
    );
}

#[test]
fn a_successful_command_reports_success() {
    let up = TestRepo::new();
    up.commit_file("a", "1\n", "init");
    let r = TestRepo::new();
    r.commit_file("b", "1\n", "other");
    r.sh(&["remote", "add", "x", &up.path().display().to_string()]);
    let fake = Arc::new(Fake::default());
    let g = git().with_auth(fake.clone());
    ops::fetch(&g, &r.info, Some("x"), false).unwrap();
    let outcomes = fake.outcomes.lock().unwrap();
    assert_eq!(outcomes.len(), 1);
    assert!(outcomes[0].0);
}

#[test]
fn a_killed_command_still_reports_and_revokes() {
    let r = repo_with_commit();
    ext_remote(&r, "sleep 60");
    let fake = Arc::new(Fake::default());
    let g = git()
        .with_auth(fake.clone())
        .with_network_timeout(Duration::from_millis(500));
    let err = ops::fetch(&g, &r.info, Some("x"), false).unwrap_err();
    assert!(matches!(err, GitError::Timeout { .. }), "{err:?}");
    let outcomes = fake.outcomes.lock().unwrap();
    assert_eq!(outcomes.len(), 1);
    assert!(!outcomes[0].0);
}

#[test]
fn an_open_prompt_pauses_the_inactivity_timeout() {
    let r = repo_with_commit();
    // Silent for 1.4 s, then fails: 3 times the 0.5 s inactivity limit.
    ext_remote(&r, "sleep 1.4\nexit 1");
    let fake = Arc::new(Fake::default());
    fake.prompting.store(1, Ordering::SeqCst); // a dialog is open the whole time
    let g = git()
        .with_auth(fake.clone())
        .with_network_timeout(Duration::from_millis(500));
    let started = Instant::now();
    let err = ops::fetch(&g, &r.info, Some("x"), false).unwrap_err();
    assert!(
        !matches!(err, GitError::Timeout { .. }),
        "the user was typing: {err:?}"
    );
    assert!(started.elapsed() >= Duration::from_millis(1300));

    // Control: the same command without an open prompt is killed.
    fake.prompting.store(0, Ordering::SeqCst);
    let err = ops::fetch(&g, &r.info, Some("x"), false).unwrap_err();
    assert!(matches!(err, GitError::Timeout { .. }), "{err:?}");
}

#[test]
fn the_absolute_cap_still_applies_while_a_prompt_is_open() {
    let r = repo_with_commit();
    ext_remote(&r, "sleep 60");
    let fake = Arc::new(Fake::default());
    fake.prompting.store(1, Ordering::SeqCst);
    let g = git()
        .with_auth(fake)
        .with_network_timeout(Duration::from_millis(300))
        .with_network_cap(Duration::from_millis(1200));
    let started = Instant::now();
    let err = ops::fetch(&g, &r.info, Some("x"), false).unwrap_err();
    assert!(matches!(err, GitError::Timeout { .. }), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// A `git` for clone tests: writes the askpass variables it got to `env.txt`
/// in its own folder, prints one progress line, then waits like a slow server (or an open dialog).
fn waiting_clone_git(dir: &Path) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("waiting-git");
    let text = format!(
        r#"#!/bin/sh
for a in "$@"; do
  [ "$a" = "--version" ] && {{ echo "git version 2.43.0"; exit 0; }}
  [ "$a" = "clone" ] && is_clone=1
done
[ -n "$is_clone" ] || exit 1
env | grep -E '^(GIT_ASKPASS|DEEPGIT_ASKPASS_TOKEN)=' | sort > {}/env.txt
printf 'Receiving objects:  10%% (1/10)\r' >&2
exec sleep 30
"#,
        dir.display()
    );
    std::fs::write(&script, text).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[test]
fn a_clone_asks_for_credentials_and_cancel_closes_its_session() {
    use gitcore::clone::{plan_clone, run_clone};
    use gitcore::{CancelToken, CloneOpts};

    let tools = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::default());
    fake.prompting.store(1, Ordering::SeqCst); // a login dialog is open while the clone waits
    let g = gitcore::Git::new(Some(waiting_clone_git(tools.path())))
        .with_auth(fake.clone())
        .with_network_timeout(Duration::from_millis(400));
    let plan = plan_clone(
        "https://example.org/private.git",
        &parent.path().to_string_lossy(),
        "private",
        &CloneOpts::default(),
    )
    .unwrap();
    let cancel = CancelToken::new();
    let worker = {
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            run_clone(&g, &plan, &CloneOpts::default(), &cancel, Arc::new(|_| {}))
        })
    };
    // Longer than the inactivity limit: the open dialog keeps the clone alive.
    std::thread::sleep(Duration::from_millis(1200));
    assert!(!worker.is_finished(), "the dialog is open: no timeout");
    let env = env_dump(&tools.path().join("env.txt"));
    assert!(env.contains("GIT_ASKPASS=/opt/deepgit/helper\n"), "{env}");
    assert!(env.contains("DEEPGIT_ASKPASS_TOKEN=tok-123\n"), "{env}");
    assert!(fake.outcomes.lock().unwrap().is_empty());

    let t = Instant::now();
    cancel.cancel();
    let r = worker.join().unwrap();
    assert!(matches!(r, Err(GitError::Cancelled)), "{r:?}");
    assert!(t.elapsed() < Duration::from_secs(5));
    let begun = fake.begun.lock().unwrap();
    assert_eq!(begun.len(), 1);
    assert_eq!(begun[0].0, AuthMode::Interactive);
    assert_eq!(begun[0].2, "git clone");
    // The ticket was finished (that closes the open prompt in the broker): the helper cannot keep waiting.
    let outcomes = fake.outcomes.lock().unwrap();
    assert_eq!(outcomes.len(), 1);
    assert!(!outcomes[0].0);
}
