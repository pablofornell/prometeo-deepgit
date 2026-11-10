//! The credential broker: gives each network command a token, answers the helper's questions
//! (from the key store, or through the UI) and saves or forgets credentials when the command ends.
//!
//! Rules (the design follows IntelliJ's `GitHandlerAuthenticationManager`):
//!
//! - A request is served only with a live token. The token dies when the git process ends.
//! - `Silent`: answer from saved credentials only, never open a dialog.
//! - `Interactive`: saved credential first, then the dialog. git asks an HTTPS user name and the
//!   password as two prompts; the user name dialog has a password field too, and the second
//!   prompt is answered from it without a second dialog.
//! - Nothing is saved while the command runs. After it exits 0 the credentials the user asked to
//!   remember are saved (on a thread of their own: a locked key store delays the command by at
//!   most `SAVE_WAIT` and is never marked unavailable because it was slow).
//! - A saved credential is deleted only on a precise sign that its own host rejected it
//!   (`rejected_keys`: "Authentication failed for '<url>'", an HTTP 401 / 403 line, ssh's
//!   `user@host: Permission denied (...password...)`), never on a bare "Permission denied", and
//!   only the entries of the host the error names. The next run asks again.
//! - One command can ask the same question many times without being rejected: `git fetch --all`
//!   starts one git per remote, submodules start more, and each asks for the same login. So the
//!   command keeps what it answered (`OpState::given`) and answers a repeat the same way. A repeat
//!   counts as a rejection only where the same process asks again after a wrong answer: ssh
//!   (passphrase, password, PIN) asks up to three times in one process. The helper reports the pid
//!   of the process that asks (`Request::ppid`); a repeat from the same pid is a rejection (the
//!   saved entry is deleted and the dialog opens with `retry`), a repeat from another pid, or any
//!   repeat of an HTTPS question (git fails right after a rejected login and never asks twice), is
//!   answered again. Without a pid (Windows) every ssh repeat counts as a rejection.
//! - A prompt nobody answers within `PROMPT_TIMEOUT` is cancelled; so is one still open when git
//!   is killed. While a prompt is open the runner does not count inactivity.
//! - A secret is never logged and never put in an error.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::Duration;

use gitcore::{AuthBroker, AuthContext, AuthMode, AuthOp, AuthOutcome, AuthTicket};
use serde::Serialize;
use tokio::sync::watch;

use crate::prompt::{parse, split_url, store_key, Prompt, PromptKind};
use crate::protocol::{Request, ENV_ENDPOINT, ENV_MARKER, ENV_TOKEN};
use crate::server::{Handler, Server};
use crate::store::{CredentialStore, StoreError};

/// A prompt nobody answers is cancelled after this long.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// One key store call (a locked keyring can wait for the user) may take this long.
const STORE_TIMEOUT: Duration = Duration::from_secs(30);
/// The end of a command waits this long for its credentials to be saved or forgotten; after that
/// the key store call goes on in the background.
pub const SAVE_WAIT: Duration = Duration::from_secs(3);

/// What the dialog shows. Sent to the window as the `auth-prompt` event (camelCase JSON).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub id: u64,
    pub kind: PromptKind,
    /// The text git or ssh sent; for a host key it holds the fingerprint.
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    /// `git push`
    pub command: String,
    /// A `username` dialog that also asks the password (git asks it next).
    pub with_password: bool,
    /// Show the "Remember" checkbox (the key store works and the prompt can be saved).
    pub can_remember: bool,
    /// The previous answer to this same question was rejected.
    pub retry: bool,
}

/// The user's reply to a dialog. A cancel is `None`, not a reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptReply {
    pub answer: String,
    /// The password of a `with_password` dialog.
    pub secondary: Option<String>,
    pub remember: bool,
}

/// Things the user should hear about once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    /// Credentials cannot be saved: the key store does not work. Holds a short reason.
    StoreUnavailable(String),
}

pub type PromptFuture = Pin<Box<dyn Future<Output = Option<PromptReply>> + Send>>;

/// The UI side. The app emits `auth-prompt` and resolves the future from the `auth_reply`
/// command; tests answer directly.
pub trait Prompter: Send + Sync + 'static {
    /// Shows the dialog and waits. The future may be dropped (timeout, git killed): then
    /// `withdraw` follows.
    fn ask(&self, request: PromptRequest) -> PromptFuture;
    /// Removes a dialog that is no longer wanted.
    fn withdraw(&self, id: u64);
    fn notice(&self, notice: Notice);
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Counts a request as "prompting" for as long as it lives.
struct Busy(Arc<AtomicUsize>);

impl Busy {
    fn new(counter: &Arc<AtomicUsize>) -> Busy {
        counter.fetch_add(1, Ordering::SeqCst);
        Busy(counter.clone())
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A password typed in the combined dialog, waiting for git's second prompt.
struct PendingPassword {
    origin: String,
    user: String,
    password: String,
    remember: bool,
}

/// What a command answered to one question, and which git or ssh process got the answer.
struct Given {
    secret: String,
    child: Option<u32>,
}

#[derive(Default)]
struct OpState {
    /// To save after the command exits 0: (key, secret).
    saves: Vec<(String, String)>,
    /// Saved entries this command used.
    used: Vec<String>,
    /// The answer to every key asked so far (from the key store or a dialog).
    given: HashMap<String, Given>,
    pending_password: Option<PendingPassword>,
}

/// What an earlier answer to the same key means for a new question.
enum Prior {
    /// Not asked before.
    First,
    /// Another git or ssh process of the same command asks: answer the same.
    Reuse(String),
    /// The process that got the answer asks again: it was wrong.
    Rejected,
}

impl OpState {
    /// Looks at an earlier answer to `key`. `http`: an HTTPS question (never a rejection, see the
    /// module docs). A rejection forgets the answer, here only; the caller deletes the saved entry.
    fn prior(&mut self, key: &str, http: bool, child: Option<u32>) -> Prior {
        let Some(g) = self.given.get_mut(key) else {
            return Prior::First;
        };
        let same_child = match (g.child, child) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        };
        if http || !same_child {
            // from now on the answer belongs to the process that used it last
            g.child = child;
            return Prior::Reuse(g.secret.clone());
        }
        self.given.remove(key);
        self.saves.retain(|(k, _)| k != key);
        self.used.retain(|k| k != key);
        Prior::Rejected
    }

    fn give(&mut self, key: &str, secret: &str, child: Option<u32>) {
        self.given.insert(
            key.to_string(),
            Given {
                secret: secret.to_string(),
                child,
            },
        );
    }
}

/// The result of `Inner::known`.
enum Found {
    Answer(String),
    /// The same process asked again: the earlier answer was wrong.
    Rejected,
    Nothing,
}

/// One network command.
struct Op {
    mode: AuthMode,
    repo_id: Option<String>,
    command: String,
    prompting: Arc<AtomicUsize>,
    /// Becomes true when the command ends: open prompts are withdrawn.
    closed: watch::Sender<bool>,
    state: Mutex<OpState>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StoreState {
    Unknown,
    Usable,
    Unavailable,
}

struct Inner {
    prompter: Arc<dyn Prompter>,
    store: Arc<dyn CredentialStore>,
    use_store: AtomicBool,
    store_state: Mutex<StoreState>,
    ops: Mutex<HashMap<String, Arc<Op>>>,
    next_prompt_id: AtomicU64,
    /// Milliseconds an unanswered prompt waits.
    prompt_timeout_ms: AtomicU64,
    /// Milliseconds the end of a command waits for the key store (`SAVE_WAIT`).
    save_wait_ms: AtomicU64,
}

/// The broker the app hands to `Git::with_auth`.
pub struct Broker {
    inner: Arc<Inner>,
    server: Server,
    helper: PathBuf,
}

impl Broker {
    /// Starts the IPC server (platform default transport) and returns the broker. `helper` is the
    /// program git and ssh run to ask: the app's own executable.
    pub async fn start(
        prompter: Arc<dyn Prompter>,
        store: Arc<dyn CredentialStore>,
        helper: PathBuf,
    ) -> io::Result<Broker> {
        let inner = Inner::new(prompter, store);
        let server = Server::start(inner.handler()).await?;
        Ok(Broker {
            inner,
            server,
            helper,
        })
    }

    /// Like `start` over loopback TCP (Windows form, also used by the tests).
    pub async fn start_tcp(
        prompter: Arc<dyn Prompter>,
        store: Arc<dyn CredentialStore>,
        helper: PathBuf,
    ) -> io::Result<Broker> {
        let inner = Inner::new(prompter, store);
        let server = Server::start_tcp(inner.handler()).await?;
        Ok(Broker {
            inner,
            server,
            helper,
        })
    }

    /// The setting `useCredentialStore`: when false nothing is read from or saved to the key
    /// store (dialogs still work).
    pub fn set_use_store(&self, on: bool) {
        self.inner.use_store.store(on, Ordering::SeqCst);
        // A key store that failed may work now; probe again on the next dialog.
        *lock(&self.inner.store_state) = StoreState::Unknown;
    }

    /// Forgets every credential DeepGit saved (blocking). Returns how many were removed.
    pub fn clear_credentials(&self) -> Result<usize, StoreError> {
        self.inner.store.clear_all()
    }

    /// Number of commands with a live token (for tests and diagnostics).
    pub fn live_tokens(&self) -> usize {
        lock(&self.inner.ops).len()
    }

    /// Overrides how long an unanswered prompt waits (tests).
    pub fn set_prompt_timeout(&self, d: Duration) {
        self.inner
            .prompt_timeout_ms
            .store(d.as_millis() as u64, Ordering::SeqCst);
    }

    /// Overrides how long the end of a command waits for the key store (tests).
    pub fn set_save_wait(&self, d: Duration) {
        self.inner
            .save_wait_ms
            .store(d.as_millis() as u64, Ordering::SeqCst);
    }

    pub fn endpoint(&self) -> String {
        self.server.endpoint().to_env()
    }

    /// Stops the IPC server and removes its socket (the app calls this on exit).
    pub fn shutdown(&self) {
        self.server.shutdown();
    }
}

impl AuthBroker for Broker {
    fn begin(&self, mode: AuthMode, op: &AuthOp<'_>) -> Option<AuthTicket> {
        if mode == AuthMode::None {
            return None;
        }
        let token = random_token().ok()?;
        let prompting = Arc::new(AtomicUsize::new(0));
        let (closed, _) = watch::channel(false);
        lock(&self.inner.ops).insert(
            token.clone(),
            Arc::new(Op {
                mode,
                repo_id: op.repo_id.map(str::to_string),
                command: op.command.to_string(),
                prompting: prompting.clone(),
                closed,
                state: Mutex::new(OpState::default()),
            }),
        );
        let ctx = AuthContext {
            helper: self.helper.clone(),
            env: vec![
                (ENV_MARKER.into(), "1".into()),
                (ENV_ENDPOINT.into(), self.server.endpoint().to_env()),
                (ENV_TOKEN.into(), token.clone()),
            ],
            prompting,
        };
        let inner = self.inner.clone();
        Some(AuthTicket::new(
            ctx,
            Box::new(move |outcome| inner.finish(&token, outcome)),
        ))
    }
}

/// An HTTPS question: git fails right after a rejected login and never asks twice in one process.
fn is_http(p: &Prompt) -> bool {
    p.kind == PromptKind::Username || p.url.is_some()
}

fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The first `'quoted'` text of `line`.
fn first_quoted(line: &str) -> Option<&str> {
    let start = line.find('\'')? + 1;
    let len = line[start..].find('\'')?;
    Some(&line[start..start + len])
}

/// `scheme://host[:port]` of a URL, lower case.
fn origin_of(url: &str) -> Option<String> {
    split_url(url).map(|(origin, _)| origin.to_ascii_lowercase())
}

/// The HTTPS origin a saved key belongs to: `login:<origin>` or `<url as git printed it>`.
fn http_origin_of_key(key: &str) -> Option<String> {
    if let Some(origin) = key.strip_prefix("login:") {
        return origin_of(origin);
    }
    if key.starts_with("ssh://") || key.starts_with("pin:") {
        return None;
    }
    origin_of(key)
}

/// `alice@host` of an ssh password key `ssh://alice@host[:port]`.
fn ssh_who_of_key(key: &str) -> Option<String> {
    let who = key.strip_prefix("ssh://")?;
    let who = match who.rsplit_once(':') {
        Some((head, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => who,
    };
    Some(who.to_ascii_lowercase())
}

/// Which of the saved entries a command used (`used`: store keys) its host rejected, judged by the
/// command's stderr. Only precise signs count, each tied to the host it names:
///
/// - `Authentication failed for '<url>'` and `... 'url': The requested URL returned error: 401|403`:
///   the HTTPS entries (`login:<origin>` and `<scheme>://<user>@<host>`) of that origin;
/// - an HTTPS sign without a URL (`HTTP Basic: Access denied`, `Invalid username or password`):
///   the entries of the one HTTPS origin the command used (with several origins: none);
/// - ssh's `<user>@<host>: Permission denied (<methods>)` when the methods include `password` or
///   `keyboard-interactive`: the ssh password entry of that user and host.
///
/// A bare "Permission denied" (a server hook, a local file, a work tree that cannot be created)
/// is never a sign. Passphrases and PINs are not deleted here: a wrong one is caught while the
/// command runs (ssh asks again, see the module docs).
pub fn rejected_keys(stderr: &str, used: &[String]) -> Vec<String> {
    let mut origins: Vec<String> = Vec::new();
    let mut unnamed_http = false;
    let mut ssh: Vec<String> = Vec::new();
    for line in stderr.lines() {
        let line = line.trim();
        let lower = line.to_lowercase();
        if let Some(i) = lower.find("authentication failed for") {
            match first_quoted(&line[i..]).and_then(origin_of) {
                Some(o) => origins.push(o),
                None => unnamed_http = true,
            }
        } else if lower.contains("error: 401") || lower.contains("error: 403") {
            match first_quoted(line).and_then(origin_of) {
                Some(o) => origins.push(o),
                None => unnamed_http = true,
            }
        } else if lower.contains("http basic: access denied")
            || lower.contains("invalid username or password")
        {
            unnamed_http = true;
        } else if let Some(i) = lower.find(": permission denied (") {
            let methods = &lower[i + ": permission denied (".len()..];
            if methods.contains("password") || methods.contains("keyboard-interactive") {
                if let Some(who) = line[..i].split_whitespace().last() {
                    ssh.push(who.to_ascii_lowercase());
                }
            }
        }
    }
    if unnamed_http {
        let mut used_origins: Vec<String> =
            used.iter().filter_map(|k| http_origin_of_key(k)).collect();
        used_origins.sort();
        used_origins.dedup();
        if let [only] = used_origins.as_slice() {
            origins.push(only.clone());
        }
    }
    used.iter()
        .filter(|key| {
            http_origin_of_key(key).is_some_and(|o| origins.contains(&o))
                || ssh_who_of_key(key).is_some_and(|w| ssh.contains(&w))
        })
        .cloned()
        .collect()
}

impl Inner {
    fn new(prompter: Arc<dyn Prompter>, store: Arc<dyn CredentialStore>) -> Arc<Inner> {
        Arc::new(Inner {
            prompter,
            store,
            use_store: AtomicBool::new(true),
            store_state: Mutex::new(StoreState::Unknown),
            ops: Mutex::new(HashMap::new()),
            next_prompt_id: AtomicU64::new(1),
            prompt_timeout_ms: AtomicU64::new(PROMPT_TIMEOUT.as_millis() as u64),
            save_wait_ms: AtomicU64::new(SAVE_WAIT.as_millis() as u64),
        })
    }

    fn handler(self: &Arc<Self>) -> Handler {
        let inner = self.clone();
        Arc::new(move |req| {
            let inner = inner.clone();
            Box::pin(async move { inner.handle(req).await })
        })
    }

    /// The command ended: revoke the token, withdraw open prompts, then save or forget.
    fn finish(self: &Arc<Self>, token: &str, outcome: &AuthOutcome<'_>) {
        let Some(op) = lock(&self.ops).remove(token) else {
            return;
        };
        let _ = op.closed.send(true);
        if !self.use_store.load(Ordering::SeqCst) {
            return;
        }
        let (saves, used) = {
            let mut st = lock(&op.state);
            (std::mem::take(&mut st.saves), std::mem::take(&mut st.used))
        };
        if outcome.success {
            if saves.is_empty() {
                return;
            }
            self.store_job(move |inner| {
                for (key, secret) in saves {
                    if let Err(e) = inner.store.set(&key, &secret) {
                        inner.store_failed(&e);
                        break;
                    }
                }
            });
        } else {
            let doomed = rejected_keys(outcome.stderr, &used);
            if doomed.is_empty() {
                return;
            }
            self.store_job(move |inner| {
                for key in doomed {
                    let _ = inner.store.delete(&key);
                }
            });
        }
    }

    /// Runs a key store job on its own thread and waits for it at most `SAVE_WAIT`: a locked
    /// Secret Service must not hold the runner thread (and the push behind it) for long. A job
    /// that is still running when the wait ends goes on in the background. Slowness never marks
    /// the store unavailable; only an error the store returns does.
    fn store_job(self: &Arc<Self>, job: impl FnOnce(&Inner) + Send + 'static) {
        let inner = self.clone();
        let (done, finished) = mpsc::channel();
        std::thread::spawn(move || {
            job(&inner);
            let _ = done.send(());
        });
        let wait = Duration::from_millis(self.save_wait_ms.load(Ordering::SeqCst));
        let _ = finished.recv_timeout(wait);
    }

    async fn handle(&self, req: Request) -> Option<String> {
        let op = lock(&self.ops).get(&req.token).cloned()?;
        let _busy = Busy::new(&op.prompting);
        let mut prompt = parse(&req.prompt, req.hint.as_deref());
        prompt.port = req.ssh_port;
        let child = req.ppid;
        match op.mode {
            AuthMode::Interactive => self.interactive(&op, prompt, child).await,
            AuthMode::Silent => self.silent(&op, &prompt, child).await,
            AuthMode::None => None,
        }
    }

    async fn silent(&self, op: &Op, prompt: &Prompt, child: Option<u32>) -> Option<String> {
        let key = store_key(prompt)?;
        match self.known(op, &key, is_http(prompt), child).await {
            Found::Answer(secret) => Some(secret),
            Found::Rejected | Found::Nothing => None,
        }
    }

    async fn interactive(&self, op: &Op, prompt: Prompt, child: Option<u32>) -> Option<String> {
        let key = store_key(&prompt);
        let http = is_http(&prompt);
        match prompt.kind {
            PromptKind::Hostkey => {
                self.ask_ui(op, &prompt, false, false, false).await?;
                Some("yes".to_string())
            }
            PromptKind::Unknown => {
                Some(self.ask_ui(op, &prompt, false, false, false).await?.answer)
            }
            PromptKind::Username => {
                let key = key?;
                let mut retry = false;
                match self.known(op, &key, http, child).await {
                    Found::Answer(user) => return Some(user),
                    Found::Rejected => retry = true,
                    Found::Nothing => {}
                }
                let reply = self.ask_ui(op, &prompt, true, true, retry).await?;
                let mut st = lock(&op.state);
                st.give(&key, &reply.answer, child);
                if reply.remember && !reply.answer.is_empty() {
                    st.saves.push((key, reply.answer.clone()));
                }
                if let (Some(password), Some(origin)) = (reply.secondary, prompt.host) {
                    st.pending_password = Some(PendingPassword {
                        origin,
                        user: reply.answer.clone(),
                        password,
                        remember: reply.remember,
                    });
                }
                Some(reply.answer)
            }
            PromptKind::Password | PromptKind::Passphrase | PromptKind::Pin => {
                if let Some(pw) = self.take_pending_password(op, &prompt, key.as_deref(), child) {
                    return Some(pw);
                }
                let mut retry = false;
                if let Some(key) = &key {
                    match self.known(op, key, http, child).await {
                        Found::Answer(secret) => return Some(secret),
                        Found::Rejected => retry = true,
                        Found::Nothing => {}
                    }
                }
                let reply = self
                    .ask_ui(op, &prompt, false, key.is_some(), retry)
                    .await?;
                if let Some(key) = key {
                    let mut st = lock(&op.state);
                    st.give(&key, &reply.answer, child);
                    if reply.remember && !reply.answer.is_empty() {
                        st.saves.push((key, reply.answer.clone()));
                    }
                }
                Some(reply.answer)
            }
        }
    }

    /// The password typed next to the user name, when this prompt is the one it was typed for.
    fn take_pending_password(
        &self,
        op: &Op,
        prompt: &Prompt,
        key: Option<&str>,
        child: Option<u32>,
    ) -> Option<String> {
        if prompt.kind != PromptKind::Password {
            return None;
        }
        let mut st = lock(&op.state);
        let pending = st.pending_password.as_ref()?;
        let same_host = prompt.host.as_deref() == Some(pending.origin.as_str());
        // git prints the user name percent-encoded; `Prompt::user` is decoded
        let same_user = prompt.user.as_deref().is_none_or(|u| u == pending.user);
        if !same_host || !same_user {
            return None;
        }
        let pending = st.pending_password.take()?;
        if let Some(key) = key {
            st.give(key, &pending.password, child);
            if pending.remember && !pending.password.is_empty() {
                st.saves.push((key.to_string(), pending.password.clone()));
            }
        }
        Some(pending.password)
    }

    /// What this command knows for `key`: its own earlier answer (see `OpState::prior`), else the
    /// saved credential. A rejection deletes the saved entry.
    async fn known(&self, op: &Op, key: &str, http: bool, child: Option<u32>) -> Found {
        let prior = lock(&op.state).prior(key, http, child);
        match prior {
            Prior::Reuse(secret) => return Found::Answer(secret),
            Prior::Rejected => {
                if self.use_store.load(Ordering::SeqCst) && !self.store_unavailable() {
                    self.forget(key).await;
                }
                return Found::Rejected;
            }
            Prior::First => {}
        }
        if !self.use_store.load(Ordering::SeqCst) || self.store_unavailable() {
            return Found::Nothing;
        }
        let Some(secret) = self.store_call(|s, k| s.get(k), key).await.flatten() else {
            return Found::Nothing;
        };
        let mut st = lock(&op.state);
        st.give(key, &secret, child);
        st.used.push(key.to_string());
        Found::Answer(secret)
    }

    async fn forget(&self, key: &str) {
        let _ = self.store_call(|s, k| s.delete(k), key).await;
    }

    /// One key store call off the async threads, with a time limit. An error the store returns
    /// marks it as unavailable (the user hears of it once) and gives `None`; a call that takes
    /// longer than the limit gives `None` too but changes nothing: a locked key store may work
    /// later.
    async fn store_call<T, F>(&self, f: F, key: &str) -> Option<T>
    where
        T: Send + 'static,
        F: FnOnce(&dyn CredentialStore, &str) -> Result<T, StoreError> + Send + 'static,
    {
        let store = self.store.clone();
        let key = key.to_string();
        let job = tokio::task::spawn_blocking(move || f(store.as_ref(), &key));
        match tokio::time::timeout(STORE_TIMEOUT, job).await {
            Ok(Ok(Ok(v))) => Some(v),
            Ok(Ok(Err(e))) => {
                self.store_failed(&e);
                None
            }
            _ => None,
        }
    }

    fn store_unavailable(&self) -> bool {
        *lock(&self.store_state) == StoreState::Unavailable
    }

    fn store_failed(&self, e: &StoreError) {
        let first = {
            let mut st = lock(&self.store_state);
            let first = *st != StoreState::Unavailable;
            *st = StoreState::Unavailable;
            first
        };
        if first {
            self.prompter
                .notice(Notice::StoreUnavailable(e.to_string()));
        }
    }

    /// True when "Remember" can be offered: the setting is on and the key store answers.
    async fn can_remember(&self) -> bool {
        if !self.use_store.load(Ordering::SeqCst) {
            return false;
        }
        let state = *lock(&self.store_state);
        match state {
            StoreState::Usable => true,
            StoreState::Unavailable => false,
            StoreState::Unknown => {
                let ok = self.store_call(|s, _| s.probe(), "").await.is_some();
                if ok {
                    let mut st = lock(&self.store_state);
                    if *st == StoreState::Unknown {
                        *st = StoreState::Usable;
                    }
                }
                ok
            }
        }
    }

    /// Shows the dialog and waits for the reply, the timeout or the end of the command.
    async fn ask_ui(
        &self,
        op: &Op,
        prompt: &Prompt,
        with_password: bool,
        offer_remember: bool,
        retry: bool,
    ) -> Option<PromptReply> {
        let can_remember = offer_remember && self.can_remember().await;
        let id = self.next_prompt_id.fetch_add(1, Ordering::Relaxed);
        let request = PromptRequest {
            id,
            kind: prompt.kind,
            prompt: prompt.text.clone(),
            host: prompt.host.clone(),
            user: prompt.user.clone(),
            key_path: prompt.key_path.clone(),
            repo_id: op.repo_id.clone(),
            command: op.command.clone(),
            with_password,
            can_remember,
            retry,
        };
        let mut closed = op.closed.subscribe();
        let reply = self.prompter.ask(request);
        let wait = Duration::from_millis(self.prompt_timeout_ms.load(Ordering::SeqCst));
        let result = tokio::select! {
            r = reply => Some(r),
            _ = tokio::time::sleep(wait) => None,
            _ = closed.wait_for(|c| *c) => None,
        };
        match result {
            Some(r) => r,
            None => {
                self.prompter.withdraw(id);
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{IndexedStore, MemoryBackend};

    type Answer = Box<dyn Fn(&PromptRequest) -> Option<PromptReply> + Send + Sync>;

    /// A dialog that answers from a closure and remembers what it was asked.
    struct Scripted {
        answer: Answer,
        asked: Mutex<Vec<PromptRequest>>,
        notices: Mutex<Vec<Notice>>,
    }

    impl Scripted {
        fn new(
            answer: impl Fn(&PromptRequest) -> Option<PromptReply> + Send + Sync + 'static,
        ) -> Arc<Self> {
            Arc::new(Scripted {
                answer: Box::new(answer),
                asked: Mutex::new(Vec::new()),
                notices: Mutex::new(Vec::new()),
            })
        }
    }

    impl Prompter for Scripted {
        fn ask(&self, request: PromptRequest) -> PromptFuture {
            let reply = (self.answer)(&request);
            lock(&self.asked).push(request);
            Box::pin(async move { reply })
        }
        fn withdraw(&self, _: u64) {}
        fn notice(&self, n: Notice) {
            lock(&self.notices).push(n);
        }
    }

    fn typed(answer: &str, remember: bool) -> Option<PromptReply> {
        Some(PromptReply {
            answer: answer.into(),
            secondary: None,
            remember,
        })
    }

    type Store = IndexedStore<MemoryBackend>;

    fn store_with(entries: &[(&str, &str)]) -> Arc<Store> {
        let s = Arc::new(IndexedStore::new(MemoryBackend::new(), None));
        for (k, v) in entries {
            s.set(k, v).unwrap();
        }
        s
    }

    /// An `Inner` with one live command (token "t") in `mode`.
    fn inner_with_op(
        prompter: Arc<dyn Prompter>,
        store: Arc<dyn CredentialStore>,
        mode: AuthMode,
    ) -> Arc<Inner> {
        let inner = Inner::new(prompter, store);
        let (closed, _) = watch::channel(false);
        lock(&inner.ops).insert(
            "t".into(),
            Arc::new(Op {
                mode,
                repo_id: None,
                command: "git fetch".into(),
                prompting: Arc::new(AtomicUsize::new(0)),
                closed,
                state: Mutex::new(OpState::default()),
            }),
        );
        inner
    }

    fn ask(prompt: &str, ppid: u32) -> Request {
        Request {
            v: 1,
            token: "t".into(),
            prompt: prompt.into(),
            hint: None,
            ppid: Some(ppid),
            ssh_port: None,
        }
    }

    const PASSPHRASE: &str = "Enter passphrase for key '/k/id': ";
    const HTTP_USER: &str = "Username for 'https://h.example.com': ";
    const HTTP_PASS: &str = "Password for 'https://alice@h.example.com': ";

    #[tokio::test]
    async fn a_second_git_process_asking_the_same_question_is_not_a_rejection() {
        // `git fetch --all` with two remotes on one host: each git child asks for the same login
        for mode in [AuthMode::Silent, AuthMode::Interactive] {
            let store = store_with(&[
                ("login:https://h.example.com", "alice"),
                ("https://alice@h.example.com", "s3cret"),
            ]);
            let ui = Scripted::new(|_| panic!("a saved login needs no dialog"));
            let inner = inner_with_op(ui.clone(), store.clone(), mode);
            for child in [10, 11, 12] {
                assert_eq!(
                    inner.handle(ask(HTTP_USER, child)).await.as_deref(),
                    Some("alice"),
                    "{mode:?} child {child}"
                );
                assert_eq!(
                    inner.handle(ask(HTTP_PASS, child)).await.as_deref(),
                    Some("s3cret")
                );
            }
            // even the same process asking twice: git never re-asks after a rejection, so it is no sign
            assert_eq!(
                inner.handle(ask(HTTP_PASS, 12)).await.as_deref(),
                Some("s3cret")
            );
            assert_eq!(store.keys().len(), 2, "{mode:?}: the login stays saved");
            assert!(lock(&ui.asked).is_empty());
        }
    }

    #[tokio::test]
    async fn a_login_typed_once_serves_every_git_process_of_the_command() {
        let ui = Scripted::new(|r| match r.kind {
            PromptKind::Username => Some(PromptReply {
                answer: "alice".into(),
                secondary: Some("s3cret".into()),
                remember: false,
            }),
            _ => None,
        });
        let inner = inner_with_op(ui.clone(), store_with(&[]), AuthMode::Interactive);
        for child in [1, 2] {
            assert_eq!(
                inner.handle(ask(HTTP_USER, child)).await.as_deref(),
                Some("alice")
            );
            assert_eq!(
                inner.handle(ask(HTTP_PASS, child)).await.as_deref(),
                Some("s3cret")
            );
        }
        assert_eq!(lock(&ui.asked).len(), 1, "one dialog for the whole command");
        assert!(!lock(&ui.asked)[0].retry);
    }

    #[tokio::test]
    async fn ssh_asking_again_in_the_same_process_is_a_rejection_but_another_process_is_not() {
        let store = store_with(&[("/k/id", "old")]);
        let ui = Scripted::new(|r| {
            assert!(r.retry, "only a rejection opens a dialog here");
            typed("new", true)
        });
        let inner = inner_with_op(ui.clone(), store.clone(), AuthMode::Interactive);
        // process 1 gets the saved passphrase; process 2 (another remote) gets it too
        assert_eq!(
            inner.handle(ask(PASSPHRASE, 1)).await.as_deref(),
            Some("old")
        );
        assert_eq!(
            inner.handle(ask(PASSPHRASE, 2)).await.as_deref(),
            Some("old")
        );
        assert!(lock(&ui.asked).is_empty());
        assert_eq!(store.get("/k/id").unwrap().as_deref(), Some("old"));
        // process 2 asks again: its answer was wrong. The saved entry goes, the dialog opens with `retry`
        assert_eq!(
            inner.handle(ask(PASSPHRASE, 2)).await.as_deref(),
            Some("new")
        );
        assert_eq!(lock(&ui.asked).len(), 1);
        assert!(store.get("/k/id").unwrap().is_none());
        // the typed passphrase is what the next process gets, and it is saved at the end
        assert_eq!(
            inner.handle(ask(PASSPHRASE, 3)).await.as_deref(),
            Some("new")
        );
        inner.finish(
            "t",
            &AuthOutcome {
                success: true,
                stderr: "",
            },
        );
        assert_eq!(store.get("/k/id").unwrap().as_deref(), Some("new"));
    }

    #[tokio::test]
    async fn silent_ssh_gives_up_when_the_same_process_asks_again() {
        let store = store_with(&[("/k/id", "old")]);
        let inner = inner_with_op(
            Scripted::new(|_| panic!("Silent never asks")),
            store.clone(),
            AuthMode::Silent,
        );
        assert_eq!(
            inner.handle(ask(PASSPHRASE, 7)).await.as_deref(),
            Some("old")
        );
        assert_eq!(
            inner.handle(ask(PASSPHRASE, 8)).await.as_deref(),
            Some("old")
        );
        assert_eq!(inner.handle(ask(PASSPHRASE, 8)).await, None);
        assert!(store.get("/k/id").unwrap().is_none());
    }

    #[tokio::test]
    async fn an_ssh_password_key_has_the_port_the_helper_reported() {
        let store = store_with(&[("ssh://alice@h:2222", "pw")]);
        let inner = inner_with_op(Scripted::new(|_| panic!("saved")), store, AuthMode::Silent);
        let mut req = ask("alice@h's password: ", 1);
        assert_eq!(
            inner.handle(req.clone()).await,
            None,
            "port 22 is another key"
        );
        req.ssh_port = Some(2222);
        assert_eq!(inner.handle(req).await.as_deref(), Some("pw"));
    }

    #[tokio::test]
    async fn an_email_user_name_in_the_password_prompt_matches_the_typed_one() {
        // git 2.43 prints `alice%40example.com`; the combined dialog answered `alice@example.com`
        let ui = Scripted::new(|r| match r.kind {
            PromptKind::Username => Some(PromptReply {
                answer: "alice@example.com".into(),
                secondary: Some("s3cret".into()),
                remember: false,
            }),
            _ => None,
        });
        let inner = inner_with_op(ui.clone(), store_with(&[]), AuthMode::Interactive);
        assert_eq!(
            inner.handle(ask(HTTP_USER, 1)).await.as_deref(),
            Some("alice@example.com")
        );
        let pass = "Password for 'https://alice%40example.com@h.example.com': ";
        assert_eq!(inner.handle(ask(pass, 1)).await.as_deref(), Some("s3cret"));
        assert_eq!(lock(&ui.asked).len(), 1, "no second dialog");
    }

    /// A key store whose `set` blocks for a while, like a locked Secret Service.
    struct Stuck {
        delay: Duration,
        data: Mutex<HashMap<String, String>>,
    }

    impl CredentialStore for Stuck {
        fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
            Ok(lock(&self.data).get(key).cloned())
        }
        fn set(&self, key: &str, secret: &str) -> Result<(), StoreError> {
            std::thread::sleep(self.delay);
            lock(&self.data).insert(key.into(), secret.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), StoreError> {
            lock(&self.data).remove(key);
            Ok(())
        }
        fn probe(&self) -> Result<(), StoreError> {
            Ok(())
        }
        fn clear_all(&self) -> Result<usize, StoreError> {
            Ok(0)
        }
    }

    #[test]
    fn a_slow_key_store_does_not_hold_the_end_of_the_command() {
        let store = Arc::new(Stuck {
            delay: Duration::from_millis(1500),
            data: Mutex::new(HashMap::new()),
        });
        let ui = Scripted::new(|_| None);
        let inner = inner_with_op(ui.clone(), store.clone(), AuthMode::Interactive);
        inner.save_wait_ms.store(100, Ordering::SeqCst);
        lock(&lock(&inner.ops)["t"].state)
            .saves
            .push(("k".into(), "secret".into()));
        let started = std::time::Instant::now();
        inner.finish(
            "t",
            &AuthOutcome {
                success: true,
                stderr: "",
            },
        );
        assert!(
            started.elapsed() < Duration::from_millis(1000),
            "{:?}",
            started.elapsed()
        );
        // the save goes on in the background, and slowness is not a failure
        assert!(!inner.store_unavailable());
        assert!(lock(&ui.notices).is_empty());
        std::thread::sleep(Duration::from_millis(2000));
        assert_eq!(store.get("k").unwrap().as_deref(), Some("secret"));
        assert!(!inner.store_unavailable());
    }

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|k| k.to_string()).collect()
    }

    const A: &str = "https://alice@a.example.com";
    const A_LOGIN: &str = "login:https://a.example.com";
    const B: &str = "https://bob@b.example.com";
    const B_LOGIN: &str = "login:https://b.example.com";

    #[test]
    fn a_rejection_names_its_host_and_only_its_entries_go() {
        let used = keys(&[A, A_LOGIN, B, B_LOGIN, "/home/a/.ssh/id_ed25519"]);
        // git names the URL: only that host
        assert_eq!(
            rejected_keys(
                "fatal: Authentication failed for 'https://b.example.com/x.git/'",
                &used
            ),
            keys(&[B, B_LOGIN])
        );
        assert_eq!(
            rejected_keys(
                "fatal: unable to access 'https://a.example.com/x.git/': The requested URL returned error: 403",
                &used
            ),
            keys(&[A, A_LOGIN])
        );
        // two hosts failed in one command
        assert_eq!(
            rejected_keys(
                "fatal: Authentication failed for 'https://a.example.com/'\nfatal: Authentication failed for 'https://b.example.com/'",
                &used
            ),
            keys(&[A, A_LOGIN, B, B_LOGIN])
        );
        // a host the command did not use: nothing
        assert!(rejected_keys(
            "fatal: Authentication failed for 'https://c.example.com/'",
            &used
        )
        .is_empty());
        // the URL may carry a user and different letter case
        assert_eq!(
            rejected_keys(
                "fatal: Authentication failed for 'https://BOB@B.example.com/r'",
                &used
            ),
            keys(&[B, B_LOGIN])
        );
    }

    #[test]
    fn a_sign_without_a_url_counts_only_when_one_https_host_was_used() {
        let one = keys(&[A, A_LOGIN]);
        assert_eq!(
            rejected_keys("remote: HTTP Basic: Access denied", &one),
            one
        );
        assert_eq!(
            rejected_keys("remote: Invalid username or password.", &one),
            one
        );
        let two = keys(&[A, A_LOGIN, B, B_LOGIN]);
        assert!(rejected_keys("remote: HTTP Basic: Access denied", &two).is_empty());
    }

    #[test]
    fn a_bare_permission_denied_is_never_an_authentication_failure() {
        let used = keys(&[
            A,
            A_LOGIN,
            "/home/a/.ssh/id_ed25519",
            "ssh://alice@host.example.com",
        ]);
        for line in [
            "remote: Permission denied to update branch main",
            "error: unable to unlink old 'x': Permission denied",
            "fatal: could not create work tree dir 'r': Permission denied",
            "error: cannot open .git/FETCH_HEAD: Permission denied",
            "fatal: Could not resolve host: example.com",
            "! [rejected] main -> main (fetch first)",
        ] {
            assert!(rejected_keys(line, &used).is_empty(), "{line}");
        }
    }

    #[test]
    fn ssh_denials_delete_the_password_of_that_user_and_host_only() {
        let used = keys(&[
            "ssh://alice@host.example.com",
            "ssh://alice@other.example.com:2222",
            "/home/a/.ssh/id_ed25519",
            "pin:PIV",
        ]);
        assert_eq!(
            rejected_keys(
                "alice@host.example.com: Permission denied (publickey,password).",
                &used
            ),
            keys(&["ssh://alice@host.example.com"])
        );
        // the port of the saved key does not matter
        assert_eq!(
            rejected_keys(
                "alice@other.example.com: Permission denied (password).",
                &used
            ),
            keys(&["ssh://alice@other.example.com:2222"])
        );
        // only a key was refused: the passphrase and the passwords stay
        assert!(rejected_keys(
            "git@host.example.com: Permission denied (publickey).",
            &used
        )
        .is_empty());
        // another user or host
        assert!(
            rejected_keys("bob@host.example.com: Permission denied (password).", &used).is_empty()
        );
    }

    #[test]
    fn the_prompt_event_is_camel_case_and_skips_empty_fields() {
        let req = PromptRequest {
            id: 7,
            kind: PromptKind::Passphrase,
            prompt: "Enter passphrase for key '/k': ".into(),
            host: None,
            user: None,
            key_path: Some("/k".into()),
            repo_id: Some("abc".into()),
            command: "git push".into(),
            with_password: false,
            can_remember: true,
            retry: false,
        };
        let json: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(json["kind"], "passphrase");
        assert_eq!(json["keyPath"], "/k");
        assert_eq!(json["repoId"], "abc");
        assert_eq!(json["withPassword"], false);
        assert_eq!(json["canRemember"], true);
        assert!(json.get("host").is_none());
    }

    #[test]
    fn tokens_are_64_hex_characters_and_differ() {
        let a = random_token().unwrap();
        let b = random_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
