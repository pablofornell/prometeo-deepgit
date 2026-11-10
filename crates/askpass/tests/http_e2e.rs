//! The whole chain with a real `git fetch` over HTTP Basic auth: gitcore runner -> git -> helper
//! program -> broker -> (scripted) dialog and (in-memory) key store.
//!
//! A small HTTP server in this file puts `git http-backend` behind Basic auth (alice / s3cret).
//! Git's prompts are the same as for https: `Username for 'http://127.0.0.1:<port>'`, then
//! `Password for 'http://alice@127.0.0.1:<port>'`.
//!
//! The tests never touch the user's git configuration or key store: HOME and the git config
//! variables point to an empty temp dir, so no credential helper runs.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

use askpass::{
    Broker, CredentialStore, IndexedStore, MemoryBackend, Notice, PromptFuture, PromptKind,
    PromptReply, PromptRequest, Prompter,
};
use gitcore::{ops, AuthMode, Git, GitError, RepoInfo};

const HELPER: &str = env!("CARGO_BIN_EXE_askpass-helper");
/// base64("alice:s3cret")
const GOOD_AUTH: &str = "Basic YWxpY2U6czNjcmV0";
/// base64("alice@example.com:s3cret"): an e-mail login
const EMAIL_AUTH: &str = "Basic YWxpY2VAZXhhbXBsZS5jb206czNjcmV0";

static ISOLATE: Once = Once::new();

/// An empty HOME and no git config files, before any test starts a git process.
fn isolate() {
    ISOLATE.call_once(|| {
        let home = tempfile::tempdir().unwrap().keep();
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_CONFIG_HOME", home.join(".config"));
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        for var in ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "SSH_ASKPASS"] {
            std::env::remove_var(var);
        }
    });
}

fn git_in(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

// ------------------------------------------------------------------ the HTTP server

struct Server {
    port: u16,
    /// How many requests were refused with 401.
    refused: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port)); // wake the accept loop
    }
}

fn serve(root: PathBuf) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let refused = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (r2, s2) = (refused.clone(), stop.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if s2.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let (root, refused) = (root.clone(), r2.clone());
            std::thread::spawn(move || {
                let _ = handle(stream, &root, &refused);
            });
        }
    });
    Server {
        port,
        refused,
        stop,
    }
}

fn handle(mut stream: TcpStream, root: &Path, refused: &AtomicUsize) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let (method, target) = (
        parts.next().unwrap_or("").to_string(),
        parts.next().unwrap_or("").to_string(),
    );
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let header = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    let mut body = Vec::new();
    if let Some(len) = header("content-length").and_then(|l| l.parse::<usize>().ok()) {
        body.resize(len, 0);
        reader.read_exact(&mut body)?;
    }
    if !matches!(
        header("authorization").as_deref(),
        Some(GOOD_AUTH | EMAIL_AUTH)
    ) {
        refused.fetch_add(1, Ordering::SeqCst);
        return stream.write_all(
            b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
    }
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let mut cgi = Command::new("git");
    cgi.arg("http-backend")
        .env("GIT_PROJECT_ROOT", root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("REQUEST_METHOD", &method)
        .env("PATH_INFO", path)
        .env("QUERY_STRING", query)
        .env("REMOTE_USER", "alice")
        .env("CONTENT_TYPE", header("content-type").unwrap_or_default())
        .env("CONTENT_LENGTH", body.len().to_string())
        .env("GIT_PROTOCOL", header("git-protocol").unwrap_or_default())
        .env(
            "HTTP_CONTENT_ENCODING",
            header("content-encoding").unwrap_or_default(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cgi.spawn()?;
    child.stdin.take().unwrap().write_all(&body)?;
    let out = child.wait_with_output()?.stdout;
    let split = out
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| (i, 4))
        .or_else(|| out.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2)));
    let (head, payload) = match split {
        Some((i, n)) => (&out[..i], &out[i + n..]),
        None => (&out[..0], &out[..]),
    };
    let head = String::from_utf8_lossy(head).into_owned();
    let status = head
        .lines()
        .find_map(|l| l.strip_prefix("Status:"))
        .map_or("200 OK".to_string(), |s| s.trim().to_string());
    let mut response = format!("HTTP/1.1 {status}\r\n");
    for line in head.lines().filter(|l| !l.starts_with("Status:")) {
        response.push_str(line);
        response.push_str("\r\n");
    }
    response.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    ));
    stream.write_all(response.as_bytes())?;
    stream.write_all(payload)
}

// ------------------------------------------------------------------ scripted dialog

type Script = dyn Fn(&PromptRequest) -> Option<PromptReply> + Send + Sync;

struct Scripted {
    script: Box<Script>,
    asked: Mutex<Vec<PromptRequest>>,
    /// Waits this long before answering (a user typing).
    delay: Duration,
}

impl Scripted {
    fn new(
        delay: Duration,
        script: impl Fn(&PromptRequest) -> Option<PromptReply> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Scripted {
            script: Box::new(script),
            asked: Mutex::new(Vec::new()),
            delay,
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
        let delay = self.delay;
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            reply
        })
    }
    fn withdraw(&self, _: u64) {}
    fn notice(&self, _: Notice) {}
}

fn alice(remember: bool) -> Arc<Scripted> {
    Scripted::new(Duration::ZERO, move |req| match req.kind {
        PromptKind::Username => Some(PromptReply {
            answer: "alice".into(),
            secondary: Some("s3cret".into()),
            remember,
        }),
        _ => None,
    })
}

// ------------------------------------------------------------------ fixture

struct Fixture {
    _tmp: tempfile::TempDir,
    server: Server,
    repo: RepoInfo,
    work: PathBuf,
}

impl Fixture {
    /// A server with one commit on `main`, and an empty client repo whose `origin` is that server.
    fn new() -> Fixture {
        isolate();
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("srv");
        let bare = root.join("proj.git");
        std::fs::create_dir_all(&bare).unwrap();
        git_in(&bare, &["init", "--bare", "-b", "main"]);
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        git_in(&work, &["init", "-b", "main"]);
        std::fs::write(work.join("a.txt"), "1\n").unwrap();
        git_in(&work, &["add", "."]);
        git_in(&work, &["commit", "-m", "first"]);
        git_in(&work, &["push", bare.to_str().unwrap(), "main"]);

        let server = serve(root);
        let client = tmp.path().join("client");
        std::fs::create_dir_all(&client).unwrap();
        git_in(&client, &["init", "-b", "main"]);
        git_in(
            &client,
            &[
                "remote",
                "add",
                "origin",
                &format!("http://127.0.0.1:{}/proj.git", server.port),
            ],
        );
        let repo = RepoInfo {
            id: "client".into(),
            name: "client".into(),
            path: client.display().to_string(),
            color: 0,
            custom_color: None,
        };
        Fixture {
            _tmp: tmp,
            server,
            repo,
            work,
        }
    }

    /// A second repository on the same server and host, as the remote `second` of the client.
    fn add_second_remote(&self) {
        let bare = self._tmp.path().join("srv/proj2.git");
        std::fs::create_dir_all(&bare).unwrap();
        git_in(&bare, &["init", "--bare", "-b", "main"]);
        git_in(&self.work, &["push", bare.to_str().unwrap(), "main"]);
        git_in(
            Path::new(&self.repo.path),
            &[
                "remote",
                "add",
                "second",
                &format!("http://127.0.0.1:{}/proj2.git", self.server.port),
            ],
        );
    }

    fn rev(&self, name: &str) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.repo.path)
            .args(["rev-parse", "--verify", "-q", name])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A new commit on the server, so the next fetch has something to download.
    fn publish(&self, n: u32) {
        std::fs::write(self.work.join("a.txt"), format!("{n}\n")).unwrap();
        git_in(&self.work, &["commit", "-am", &format!("change {n}")]);
        let bare = self._tmp.path().join("srv/proj.git");
        git_in(&self.work, &["push", bare.to_str().unwrap(), "main"]);
    }

    fn remote_head(&self) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.repo.path)
            .args(["rev-parse", "--verify", "-q", "origin/main"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
}

type Store = IndexedStore<MemoryBackend>;

async fn broker(prompter: Arc<Scripted>, store: Arc<Store>) -> Arc<Broker> {
    Arc::new(
        Broker::start(prompter, store, HELPER.into())
            .await
            .expect("broker starts"),
    )
}

async fn fetch_all(git: Git, repo: RepoInfo) -> Result<gitcore::OpResult, GitError> {
    tokio::task::spawn_blocking(move || ops::fetch(&git, &repo, None, false))
        .await
        .unwrap()
}

async fn fetch(git: Git, repo: RepoInfo) -> Result<gitcore::OpResult, GitError> {
    tokio::task::spawn_blocking(move || ops::fetch(&git, &repo, Some("origin"), false))
        .await
        .unwrap()
}

fn new_store() -> Arc<Store> {
    Arc::new(IndexedStore::new(MemoryBackend::new(), None))
}

// ------------------------------------------------------------------ tests

#[tokio::test(flavor = "multi_thread")]
async fn a_fetch_asks_once_downloads_and_saves_only_after_success() {
    let fx = Fixture::new();
    let prompter = alice(true);
    let store = new_store();
    let broker = broker(prompter.clone(), store.clone()).await;
    let git = Git::new(None).with_auth(broker.clone());

    let res = fetch(git.clone(), fx.repo.clone())
        .await
        .expect("fetch works");
    assert!(res.ok, "{res:?}");
    assert_ne!(fx.remote_head(), "", "origin/main was fetched");
    // one dialog for the user name and the password together
    assert_eq!(prompter.count(), 1);
    {
        let asked = prompter.asked.lock().unwrap();
        assert_eq!(asked[0].kind, PromptKind::Username);
        assert_eq!(asked[0].command, "git fetch");
        assert_eq!(asked[0].repo_id.as_deref(), Some("client"));
        assert!(asked[0]
            .host
            .as_deref()
            .unwrap()
            .starts_with("http://127.0.0.1:"));
    }
    // saved after the success
    assert_eq!(store.keys().len(), 2, "{:?}", store.keys());
    assert_eq!(broker.live_tokens(), 0);

    // a new commit; the next fetch (user-started) uses the saved login: no dialog
    fx.publish(2);
    let before = fx.remote_head();
    fetch(git.clone(), fx.repo.clone())
        .await
        .expect("second fetch");
    assert_ne!(fx.remote_head(), before);
    assert_eq!(prompter.count(), 1, "saved credentials need no dialog");

    // a background fetch (Silent) works from the saved login too
    fx.publish(3);
    let before = fx.remote_head();
    let silent = git.clone().with_auth_mode(AuthMode::Silent);
    fetch(silent, fx.repo.clone()).await.expect("silent fetch");
    assert_ne!(fx.remote_head(), before);
    assert_eq!(prompter.count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn without_remember_nothing_is_saved_and_the_next_fetch_asks_again() {
    let fx = Fixture::new();
    let prompter = alice(false);
    let store = new_store();
    let broker = broker(prompter.clone(), store.clone()).await;
    let git = Git::new(None).with_auth(broker);
    fetch(git.clone(), fx.repo.clone()).await.unwrap();
    assert!(store.keys().is_empty());
    fetch(git, fx.repo.clone()).await.unwrap();
    assert_eq!(prompter.count(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rejected_saved_login_is_forgotten_and_the_error_is_clear() {
    let fx = Fixture::new();
    let prompter = alice(true);
    let store = new_store();
    let origin = format!("http://127.0.0.1:{}", fx.server.port);
    store.set(&format!("login:{origin}"), "alice").unwrap();
    store
        .set(
            &format!("http://alice@127.0.0.1:{}", fx.server.port),
            "old-password",
        )
        .unwrap();
    let broker = broker(prompter.clone(), store.clone()).await;
    let git = Git::new(None).with_auth(broker);

    let err = fetch(git.clone(), fx.repo.clone()).await.unwrap_err();
    let api: gitcore::ApiError = err.into();
    assert!(
        api.message.starts_with("Authentication failed"),
        "{}",
        api.message
    );
    assert_eq!(prompter.count(), 0, "the saved login was tried first");
    assert!(
        store.get(&format!("login:{origin}")).unwrap().is_none(),
        "the rejected login is deleted"
    );
    assert!(fx.server.refused.load(Ordering::SeqCst) >= 1);

    // now the user is asked again and the fetch works
    let res = fetch(git, fx.repo.clone()).await.unwrap();
    assert!(res.ok);
    assert_eq!(prompter.count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_and_silent_mode_fail_without_a_hang() {
    let fx = Fixture::new();
    let cancel = Scripted::new(Duration::ZERO, |_| None);
    let broker_c = broker(cancel.clone(), new_store()).await;
    let git = Git::new(None).with_auth(broker_c);
    let started = std::time::Instant::now();
    let err = fetch(git, fx.repo.clone()).await.unwrap_err();
    let api: gitcore::ApiError = err.into();
    assert!(
        api.message.starts_with("No credentials were given"),
        "{}",
        api.message
    );
    assert_eq!(cancel.count(), 1);

    let never = Scripted::new(Duration::ZERO, |_| unreachable!("Silent never prompts"));
    let broker_s = broker(never.clone(), new_store()).await;
    let silent = Git::new(None)
        .with_auth(broker_s)
        .with_auth_mode(AuthMode::Silent);
    let err = fetch(silent, fx.repo.clone()).await.unwrap_err();
    let api: gitcore::ApiError = err.into();
    assert!(
        api.message.starts_with("No credentials were given"),
        "{}",
        api.message
    );
    assert_eq!(never.count(), 0);
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_typist_does_not_trip_the_inactivity_timeout() {
    let fx = Fixture::new();
    // the "user" needs 1.5 s; git is silent meanwhile; the limit is 0.6 s
    let prompter = Scripted::new(Duration::from_millis(1500), |req| match req.kind {
        PromptKind::Username => Some(PromptReply {
            answer: "alice".into(),
            secondary: Some("s3cret".into()),
            remember: false,
        }),
        _ => None,
    });
    let broker = broker(prompter, new_store()).await;
    let git = Git::new(None)
        .with_auth(broker)
        .with_network_timeout(Duration::from_millis(600));
    let res = fetch(git, fx.repo.clone()).await.expect("not killed");
    assert!(res.ok);
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_all_with_two_remotes_on_one_host_keeps_the_saved_login_and_opens_no_retry_dialog() {
    let fx = Fixture::new();
    fx.add_second_remote();
    let prompter = alice(true);
    let store = new_store();
    let broker = broker(prompter.clone(), store.clone()).await;
    let git = Git::new(None).with_auth(broker.clone());

    // Interactive, nothing saved yet: git starts one process per remote and each asks for the
    // login. One dialog serves both.
    let res = fetch_all(git.clone(), fx.repo.clone())
        .await
        .expect("fetch --all");
    assert!(res.ok, "{res:?}");
    assert_ne!(fx.rev("origin/main"), "");
    assert_ne!(
        fx.rev("second/main"),
        "",
        "the second remote was fetched too"
    );
    assert_eq!(prompter.count(), 1);
    assert!(prompter.asked.lock().unwrap().iter().all(|r| !r.retry));
    assert_eq!(store.keys().len(), 2, "{:?}", store.keys());

    // Interactive with the saved login: no dialog, the login stays.
    fx.publish(2);
    fetch_all(git.clone(), fx.repo.clone())
        .await
        .expect("saved login");
    assert_eq!(prompter.count(), 1);
    assert_eq!(
        store.keys().len(),
        2,
        "the login was kept: {:?}",
        store.keys()
    );

    // Silent (the auto-fetch) with both remotes: it works and keeps the login. The old rule
    // read the second remote's question as a rejection and deleted the login, so the next
    // auto-fetch failed for good.
    for round in 3..=4 {
        fx.publish(round);
        let silent = git.clone().with_auth_mode(AuthMode::Silent);
        let res = fetch_all(silent, fx.repo.clone())
            .await
            .expect("silent fetch --all");
        assert!(res.ok, "round {round}: {res:?}");
        assert_eq!(store.keys().len(), 2, "round {round}: {:?}", store.keys());
        assert_eq!(prompter.count(), 1, "Silent never opens a dialog");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_all_with_two_remotes_asks_once_when_nothing_is_remembered() {
    let fx = Fixture::new();
    fx.add_second_remote();
    let prompter = alice(false);
    let store = new_store();
    let broker = broker(prompter.clone(), store.clone()).await;
    let git = Git::new(None).with_auth(broker);
    let res = fetch_all(git, fx.repo.clone()).await.expect("fetch --all");
    assert!(res.ok);
    assert_ne!(fx.rev("second/main"), "");
    assert_eq!(
        prompter.count(),
        1,
        "the typed login serves the second remote"
    );
    assert!(prompter.asked.lock().unwrap().iter().all(|r| !r.retry));
    assert!(store.keys().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_email_login_is_typed_once_not_twice() {
    // git 2.43 prints `Password for 'http://alice%40example.com@host'`
    let fx = Fixture::new();
    let prompter = Scripted::new(Duration::ZERO, |req| match req.kind {
        PromptKind::Username => Some(PromptReply {
            answer: "alice@example.com".into(),
            secondary: Some("s3cret".into()),
            remember: true,
        }),
        _ => None,
    });
    let store = new_store();
    let broker = broker(prompter.clone(), store.clone()).await;
    let git = Git::new(None).with_auth(broker);
    let res = fetch(git.clone(), fx.repo.clone()).await.expect("fetch");
    assert!(res.ok, "{res:?}");
    assert_eq!(
        prompter.count(),
        1,
        "one dialog, not a second one for the password"
    );
    assert_eq!(store.keys().len(), 2, "{:?}", store.keys());

    // the saved e-mail login works the next time without a dialog
    fx.publish(2);
    fetch(git, fx.repo.clone())
        .await
        .expect("saved e-mail login");
    assert_eq!(prompter.count(), 1);
}
