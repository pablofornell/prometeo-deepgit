//! End to end: the real helper program <-> the broker, driven by real `git` and `ssh-keygen`.
//! No UI and no system key store: a scripted `Prompter` plays the dialog and `MemoryBackend`
//! the key store.
//!
//! `git credential fill` is the way to get a genuine git prompt without a server: with no
//! credential helper, git asks "Username for ..." and "Password for ..." through `GIT_ASKPASS`.

#![cfg(unix)]

use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use askpass::{
    Broker, CredentialStore, IndexedStore, MemoryBackend, Notice, PromptFuture, PromptKind,
    PromptReply, PromptRequest, Prompter,
};
use gitcore::{AuthMode, AuthOutcome, Git};

const HELPER: &str = env!("CARGO_BIN_EXE_askpass-helper");

type Script = dyn Fn(&PromptRequest) -> Option<PromptReply> + Send + Sync;

/// Answers every prompt with `script` and remembers what it was asked.
struct Scripted {
    script: Box<Script>,
    asked: Mutex<Vec<PromptRequest>>,
    withdrawn: Mutex<Vec<u64>>,
    notices: Mutex<Vec<Notice>>,
    /// Never answer: the dialog stays open.
    hang: bool,
}

impl Scripted {
    fn new(
        script: impl Fn(&PromptRequest) -> Option<PromptReply> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Scripted {
            script: Box::new(script),
            asked: Mutex::new(Vec::new()),
            withdrawn: Mutex::new(Vec::new()),
            notices: Mutex::new(Vec::new()),
            hang: false,
        })
    }

    fn hanging() -> Arc<Self> {
        Arc::new(Scripted {
            script: Box::new(|_| None),
            asked: Mutex::new(Vec::new()),
            withdrawn: Mutex::new(Vec::new()),
            notices: Mutex::new(Vec::new()),
            hang: true,
        })
    }

    fn count(&self) -> usize {
        self.asked.lock().unwrap().len()
    }
}

impl Prompter for Scripted {
    fn ask(&self, request: PromptRequest) -> PromptFuture {
        let reply = (self.script)(&request);
        self.asked.lock().unwrap().push(request);
        let hang = self.hang;
        Box::pin(async move {
            if hang {
                std::future::pending::<()>().await;
            }
            reply
        })
    }

    fn withdraw(&self, id: u64) {
        self.withdrawn.lock().unwrap().push(id);
    }

    fn notice(&self, notice: Notice) {
        self.notices.lock().unwrap().push(notice);
    }
}

fn reply(answer: &str, secondary: Option<&str>, remember: bool) -> Option<PromptReply> {
    Some(PromptReply {
        answer: answer.to_string(),
        secondary: secondary.map(str::to_string),
        remember,
    })
}

type Store = IndexedStore<MemoryBackend>;

async fn broker(prompter: Arc<Scripted>, store: Arc<Store>, tcp: bool) -> Arc<Broker> {
    let helper = HELPER.into();
    let broker = if tcp {
        Broker::start_tcp(prompter, store, helper).await
    } else {
        Broker::start(prompter, store, helper).await
    };
    Arc::new(broker.expect("broker starts"))
}

fn git_with(broker: &Arc<Broker>, mode: AuthMode) -> Git {
    Git::new(None)
        .with_auth(broker.clone())
        .with_auth_mode(mode)
}

/// `git credential fill` for https://example.com under the auth environment of `git`.
/// Returns (output, ticket outcome was reported with `success`).
fn credential_fill(git: &Git, finish_with: Option<(bool, &str)>) -> Output {
    let ticket = git.begin_auth(None, "git test");
    let mut cmd = Command::new("git");
    cmd.args(["-c", "credential.helper=", "credential", "fill"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    git.apply_auth(&mut cmd, None, ticket.as_ref());
    if let Some(t) = &ticket {
        let token = &t
            .ctx
            .env
            .iter()
            .find(|(k, _)| k == "DEEPGIT_ASKPASS_TOKEN")
            .unwrap()
            .1;
        assert!(
            cmd.get_args()
                .all(|a| !a.to_string_lossy().contains(token.as_str())),
            "the token must never be on the command line"
        );
    }
    let mut child = cmd.spawn().expect("git starts");
    {
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"protocol=https\nhost=example.com\n\n")
            .unwrap();
    }
    let out = child.wait_with_output().unwrap();
    if let (Some(t), Some((success, stderr))) = (ticket, finish_with) {
        t.finish(&AuthOutcome { success, stderr });
    }
    out
}

async fn fill(git: Git, finish_with: Option<(bool, &'static str)>) -> Output {
    tokio::task::spawn_blocking(move || credential_fill(&git, finish_with))
        .await
        .unwrap()
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn new_store() -> Arc<Store> {
    Arc::new(IndexedStore::new(MemoryBackend::new(), None))
}

// ------------------------------------------------------------------ HTTPS through git

#[tokio::test(flavor = "multi_thread")]
async fn git_credential_fill_gets_user_and_password_from_one_dialog() {
    let prompter = Scripted::new(|req| match req.kind {
        PromptKind::Username => reply("alice", Some("s3cret"), false),
        _ => None,
    });
    let broker = broker(prompter.clone(), new_store(), false).await;
    let out = fill(git_with(&broker, AuthMode::Interactive), None).await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = stdout(&out);
    assert!(text.contains("username=alice\n"), "{text}");
    assert!(text.contains("password=s3cret\n"), "{text}");
    // git asked twice, the user saw one dialog
    let asked = prompter.asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].kind, PromptKind::Username);
    assert!(asked[0].with_password);
    assert_eq!(asked[0].host.as_deref(), Some("https://example.com"));
    assert_eq!(asked[0].command, "git test");
}

#[tokio::test(flavor = "multi_thread")]
async fn two_dialogs_when_the_ui_returns_only_the_user_name() {
    let prompter = Scripted::new(|req| match req.kind {
        PromptKind::Username => reply("bob", None, false),
        PromptKind::Password => reply("hunter2", None, false),
        _ => None,
    });
    let broker = broker(prompter.clone(), new_store(), true).await; // TCP form
    let out = fill(git_with(&broker, AuthMode::Interactive), None).await;
    let text = stdout(&out);
    assert!(
        text.contains("username=bob\n") && text.contains("password=hunter2\n"),
        "{text}"
    );
    let asked = prompter.asked.lock().unwrap();
    assert_eq!(asked.len(), 2);
    assert_eq!(asked[1].kind, PromptKind::Password);
    assert_eq!(asked[1].user.as_deref(), Some("bob"));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_makes_git_fail_without_a_password() {
    let prompter = Scripted::new(|_| None);
    let broker = broker(prompter.clone(), new_store(), false).await;
    let out = fill(git_with(&broker, AuthMode::Interactive), None).await;
    assert!(!out.status.success());
    assert!(!stdout(&out).contains("password="));
    assert_eq!(prompter.count(), 1);
    // the ticket was dropped without `finish`: dropping revokes the token too
    assert_eq!(broker.live_tokens(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn remembered_credentials_are_saved_only_after_success_and_used_silently() {
    let prompter = Scripted::new(|req| match req.kind {
        PromptKind::Username => reply("alice", Some("s3cret"), true),
        _ => None,
    });
    let store = new_store();
    let broker = broker(prompter.clone(), store.clone(), false).await;

    // The command is still running: nothing is saved yet. (Failure: nothing saved at all.)
    let out = fill(
        git_with(&broker, AuthMode::Interactive),
        Some((false, "fatal: some other error")),
    )
    .await;
    assert!(out.status.success());
    assert!(store.keys().is_empty(), "a failed command saves nothing");

    // Success: both are saved.
    let out = fill(git_with(&broker, AuthMode::Interactive), Some((true, ""))).await;
    assert!(out.status.success());
    assert_eq!(
        store.get("login:https://example.com").unwrap().as_deref(),
        Some("alice")
    );
    assert_eq!(
        store.get("https://alice@example.com").unwrap().as_deref(),
        Some("s3cret")
    );
    assert_eq!(broker.live_tokens(), 0);
    let dialogs = prompter.count();
    assert_eq!(dialogs, 2);

    // A background command (Silent) answers from the store: no dialog.
    let out = fill(git_with(&broker, AuthMode::Silent), Some((true, ""))).await;
    let text = stdout(&out);
    assert!(
        text.contains("username=alice\n") && text.contains("password=s3cret\n"),
        "{text}"
    );
    assert_eq!(prompter.count(), dialogs, "Silent never opens a dialog");

    // An interactive command also uses the saved credentials first.
    let out = fill(git_with(&broker, AuthMode::Interactive), Some((true, ""))).await;
    assert!(stdout(&out).contains("password=s3cret\n"));
    assert_eq!(prompter.count(), dialogs);

    // git rejected them: the saved entries are deleted, so the next run asks again.
    let out = fill(
        git_with(&broker, AuthMode::Interactive),
        Some((
            false,
            "fatal: Authentication failed for 'https://example.com/'",
        )),
    )
    .await;
    assert!(out.status.success());
    assert!(store.keys().is_empty(), "{:?}", store.keys());
    let out = fill(git_with(&broker, AuthMode::Interactive), Some((true, ""))).await;
    assert!(out.status.success());
    assert_eq!(
        prompter.count(),
        dialogs + 1,
        "asked again after the failure"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_host_an_error_names_loses_its_saved_login() {
    let store = new_store();
    for (k, v) in [
        ("login:https://example.com", "alice"),
        ("https://alice@example.com", "s3cret"),
        ("login:https://other.example.org", "bob"),
        ("https://bob@other.example.org", "hunter2"),
    ] {
        store.set(k, v).unwrap();
    }
    let prompter = Scripted::new(|_| None);
    let broker = broker(prompter, store.clone(), false).await;

    // `fill` uses example.com only; a permission error that is not about logins deletes nothing
    for text in [
        "remote: Permission denied to update branch main",
        "error: unable to unlink old 'x': Permission denied",
        "fatal: could not create work tree dir 'r': Permission denied",
    ] {
        fill(
            git_with(&broker, AuthMode::Interactive),
            Some((false, text)),
        )
        .await;
        assert_eq!(store.keys().len(), 4, "{text}: {:?}", store.keys());
    }
    // an error that names another host leaves this one alone
    fill(
        git_with(&broker, AuthMode::Interactive),
        Some((
            false,
            "fatal: Authentication failed for 'https://other.example.org/r.git'",
        )),
    )
    .await;
    assert_eq!(store.keys().len(), 4);
    // naming this host removes its entries, and only those
    fill(
        git_with(&broker, AuthMode::Interactive),
        Some((
            false,
            "fatal: Authentication failed for 'https://example.com/r.git'",
        )),
    )
    .await;
    let mut left = store.keys();
    left.sort();
    assert_eq!(
        left,
        [
            "https://bob@other.example.org",
            "login:https://other.example.org"
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn silent_mode_without_saved_credentials_fails_fast_and_never_prompts() {
    let prompter = Scripted::new(|_| reply("x", Some("y"), false));
    let broker = broker(prompter.clone(), new_store(), false).await;
    let started = std::time::Instant::now();
    let out = fill(git_with(&broker, AuthMode::Silent), None).await;
    assert!(!out.status.success());
    assert_eq!(prompter.count(), 0);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_credential_store_setting_off_means_no_reads_no_saves() {
    let prompter = Scripted::new(|req| match req.kind {
        PromptKind::Username => reply("alice", Some("s3cret"), true),
        _ => None,
    });
    let store = new_store();
    store.set("login:https://example.com", "mallory").unwrap();
    let broker = broker(prompter.clone(), store.clone(), false).await;
    broker.set_use_store(false);
    let out = fill(git_with(&broker, AuthMode::Interactive), Some((true, ""))).await;
    assert!(
        stdout(&out).contains("username=alice\n"),
        "the saved user name is not used"
    );
    let asked = prompter.asked.lock().unwrap();
    assert!(
        !asked[0].can_remember,
        "no Remember checkbox when the store is off"
    );
    drop(asked);
    assert_eq!(
        store.keys(),
        vec!["login:https://example.com"],
        "nothing new saved"
    );
    assert_eq!(
        store.get("login:https://example.com").unwrap().as_deref(),
        Some("mallory")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_key_store_hides_remember_and_tells_the_user_once() {
    let prompter = Scripted::new(|req| match req.kind {
        PromptKind::Username => reply("alice", Some("s3cret"), true),
        _ => None,
    });
    let store = Arc::new(IndexedStore::new(MemoryBackend::unavailable(), None));
    let broker = broker(prompter.clone(), store, false).await;
    for _ in 0..2 {
        let out = fill(git_with(&broker, AuthMode::Interactive), Some((true, ""))).await;
        assert!(
            stdout(&out).contains("password=s3cret\n"),
            "login still works"
        );
    }
    let asked = prompter.asked.lock().unwrap();
    assert!(asked.iter().all(|r| !r.can_remember));
    assert_eq!(prompter.notices.lock().unwrap().len(), 1, "told once");
}

// ------------------------------------------------------------------ token rules

/// Runs the helper program by hand with the environment `ticket` produced.
fn run_helper(env: &[(String, String)], prompt: &str, extra: &[(&str, &str)]) -> Output {
    let mut cmd = Command::new(HELPER);
    cmd.arg(prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    for (k, v) in extra {
        cmd.env(k, v);
    }
    cmd.output().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_works_only_while_its_command_runs() {
    let prompter = Scripted::new(|_| reply("pw", None, false));
    let broker = broker(prompter.clone(), new_store(), false).await;
    let git = git_with(&broker, AuthMode::Interactive);
    let ticket = git.begin_auth(None, "git push").unwrap();
    let env = ticket.ctx.env.clone();
    let prompt = "Password for 'https://u@h': ";

    let (e1, p1) = (env.clone(), prompt.to_string());
    let live = tokio::task::spawn_blocking(move || run_helper(&e1, &p1, &[]))
        .await
        .unwrap();
    assert_eq!(live.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&live.stdout), "pw\n");

    ticket.finish(&AuthOutcome {
        success: true,
        stderr: "",
    });
    let (e2, p2) = (env.clone(), prompt.to_string());
    let dead = tokio::task::spawn_blocking(move || run_helper(&e2, &p2, &[]))
        .await
        .unwrap();
    assert_eq!(dead.status.code(), Some(1));
    assert!(
        dead.stdout.is_empty(),
        "nothing on stdout without a live token"
    );

    // a made-up token never works
    let forged: Vec<(String, String)> = env
        .iter()
        .map(|(k, v)| {
            if k == "DEEPGIT_ASKPASS_TOKEN" {
                (k.clone(), "0".repeat(64))
            } else {
                (k.clone(), v.clone())
            }
        })
        .collect();
    let git2 = git.clone();
    let _keep = git2.begin_auth(None, "git fetch").unwrap();
    let bad = tokio::task::spawn_blocking(move || {
        run_helper(&forged, "Password for 'https://u@h': ", &[])
    })
    .await
    .unwrap();
    assert_eq!(bad.status.code(), Some(1));
    assert!(bad.stdout.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ssh_host_key_question_is_answered_yes_or_refused() {
    let accept = Scripted::new(|req| {
        assert_eq!(req.kind, PromptKind::Hostkey);
        assert!(
            req.prompt.contains("SHA256:abc"),
            "the fingerprint reaches the dialog"
        );
        reply("accept", None, false)
    });
    let b = broker(accept, new_store(), false).await;
    let ticket = b_git(&b).begin_auth(None, "git fetch").unwrap();
    let env = ticket.ctx.env.clone();
    let question = "The authenticity of host 'h (1.2.3.4)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
    let out = tokio::task::spawn_blocking(move || {
        run_helper(&env, question, &[("SSH_ASKPASS_PROMPT", "confirm")])
    })
    .await
    .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "yes\n");

    let reject = Scripted::new(|_| None);
    let b = broker(reject, new_store(), false).await;
    let ticket2 = b_git(&b).begin_auth(None, "git fetch").unwrap();
    let env = ticket2.ctx.env.clone();
    let out = tokio::task::spawn_blocking(move || {
        run_helper(&env, question, &[("SSH_ASKPASS_PROMPT", "confirm")])
    })
    .await
    .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    drop(ticket);
}

fn b_git(b: &Arc<Broker>) -> Git {
    git_with(b, AuthMode::Interactive)
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unanswered_prompt_is_cancelled_after_the_timeout() {
    let prompter = Scripted::hanging();
    let b = broker(prompter.clone(), new_store(), false).await;
    b.set_prompt_timeout(Duration::from_millis(300));
    let ticket = b_git(&b).begin_auth(None, "git push").unwrap();
    let env = ticket.ctx.env.clone();
    let started = std::time::Instant::now();
    let out =
        tokio::task::spawn_blocking(move || run_helper(&env, "Password for 'https://u@h': ", &[]))
            .await
            .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(
        prompter.withdrawn.lock().unwrap().len(),
        1,
        "the dialog is withdrawn"
    );
    assert_eq!(ticket.ctx.prompting.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_prompt_still_open_when_git_ends_is_withdrawn_and_pauses_the_clock_meanwhile() {
    let prompter = Scripted::hanging();
    let b = broker(prompter.clone(), new_store(), false).await;
    let ticket = b_git(&b).begin_auth(None, "git push").unwrap();
    let env = ticket.ctx.env.clone();
    let prompting = ticket.ctx.prompting.clone();
    let helper =
        tokio::task::spawn_blocking(move || run_helper(&env, "Password for 'https://u@h': ", &[]));
    // the dialog opens: the runner must see "prompting"
    for _ in 0..100 {
        if prompting.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(prompting.load(Ordering::SeqCst), 1);
    // git is killed: the ticket finishes, the helper gets a cancel, the dialog is withdrawn
    ticket.finish(&AuthOutcome {
        success: false,
        stderr: "",
    });
    let out = helper.await.unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(prompter.withdrawn.lock().unwrap().len(), 1);
    assert_eq!(prompting.load(Ordering::SeqCst), 0);
}

// ------------------------------------------------------------------ ssh passphrase

fn have(tool: &str) -> bool {
    Command::new(tool)
        .arg("-V")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
        || Command::new("which")
            .arg(tool)
            .output()
            .is_ok_and(|o| o.status.success())
}

fn keygen(dir: &Path, passphrase: &str) -> std::path::PathBuf {
    let key = dir.join("id_test");
    let st = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", passphrase, "-C", "test", "-f"])
        .arg(&key)
        .stdin(Stdio::null())
        .status()
        .unwrap();
    assert!(st.success());
    key
}

/// A private ssh-agent for the test; killed on drop.
struct Agent {
    child: std::process::Child,
    sock: std::path::PathBuf,
}

impl Agent {
    fn start(dir: &Path) -> Agent {
        let sock = dir.join("agent.sock");
        let child = Command::new("ssh-agent")
            .args(["-D", "-a"])
            .arg(&sock)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("ssh-agent starts");
        for _ in 0..100 {
            if sock.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Agent { child, sock }
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `ssh-add <key>` asks for the passphrase like ssh does (`Enter passphrase for <path>:`). It runs
/// under the Interactive environment and in its own session, as the runner starts git: there is
/// no terminal to fall back to.
fn ssh_add(git: &Git, key: &Path, agent: &Agent) -> Output {
    use std::os::unix::process::CommandExt;
    let ticket = git.begin_auth(None, "git fetch");
    let mut cmd = Command::new("ssh-add");
    cmd.arg(key)
        .env("SSH_AUTH_SOCK", &agent.sock)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    git.apply_auth(&mut cmd, None, ticket.as_ref());
    // SAFETY: setsid(2) only.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let out = cmd.output().unwrap();
    if let Some(t) = ticket {
        t.finish(&AuthOutcome {
            success: out.status.success(),
            stderr: "",
        });
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ssh_key_passphrase_is_asked_through_the_helper_without_a_terminal() {
    if !have("ssh-keygen") || !have("ssh-add") || !have("ssh-agent") {
        eprintln!("OpenSSH tools not found: skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let key = keygen(dir.path(), "correct horse");
    let key_text = key.display().to_string();
    let agent = Arc::new(Agent::start(dir.path()));

    let right = Scripted::new({
        let key_text = key_text.clone();
        move |req| {
            assert_eq!(req.kind, PromptKind::Passphrase);
            assert_eq!(req.key_path.as_deref(), Some(key_text.as_str()));
            reply("correct horse", None, true)
        }
    });
    let store = new_store();
    let b = broker(right.clone(), store.clone(), false).await;
    let (git, k, a) = (b_git(&b), key.clone(), agent.clone());
    let out = tokio::task::spawn_blocking(move || ssh_add(&git, &k, &a))
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(right.count(), 1);
    assert_eq!(
        store.get(&key_text).unwrap().as_deref(),
        Some("correct horse"),
        "saved after success"
    );

    // the saved passphrase is used without a dialog
    let (git, k, a) = (b_git(&b), key.clone(), agent.clone());
    let out = tokio::task::spawn_blocking(move || ssh_add(&git, &k, &a))
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(right.count(), 1);

    // a wrong passphrase: ssh asks again (retry flag, ssh-add asks until it gets an empty answer);
    // the second time the user cancels. Nothing is saved.
    let wrong = Scripted::new(|req| {
        if req.retry {
            None
        } else {
            reply("nope", None, true)
        }
    });
    let store2 = new_store();
    let b2 = broker(wrong.clone(), store2.clone(), false).await;
    let (git, k, a) = (b_git(&b2), key.clone(), agent.clone());
    let out = tokio::task::spawn_blocking(move || ssh_add(&git, &k, &a))
        .await
        .unwrap();
    assert!(!out.status.success());
    assert!(store2.keys().is_empty());
    let asked = wrong.asked.lock().unwrap();
    assert_eq!(asked.len(), 2, "ssh-add asked again after the wrong answer");
    assert!(!asked[0].retry && asked[1].retry);
}

// ------------------------------------------------------------------ helper never needs a display

#[test]
fn the_helper_without_the_ipc_variables_exits_1_and_prints_nothing() {
    let out = Command::new(HELPER)
        .arg("Password: ")
        .env_remove("DEEPGIT_ASKPASS")
        .env_remove("DEEPGIT_ASKPASS_ENDPOINT")
        .env_remove("DEEPGIT_ASKPASS_TOKEN")
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
}
