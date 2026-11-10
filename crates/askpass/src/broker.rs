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
//!   remember are saved. After an authentication failure the saved credentials the command
//!   used are deleted, so the next run asks again.
//! - A prompt nobody answers within `PROMPT_TIMEOUT` is cancelled; so is one still open when git
//!   is killed. While a prompt is open the runner does not count inactivity.
//! - A secret is never logged and never put in an error.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use gitcore::{AuthBroker, AuthContext, AuthMode, AuthOp, AuthOutcome, AuthTicket};
use serde::Serialize;
use tokio::sync::watch;

use crate::prompt::{parse, store_key, Prompt, PromptKind};
use crate::protocol::{ENV_ENDPOINT, ENV_MARKER, ENV_TOKEN};
use crate::server::{Handler, Server};
use crate::store::{CredentialStore, StoreError};

/// A prompt nobody answers is cancelled after this long.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// One key store call (a locked keyring can wait for the user) may take this long.
const STORE_TIMEOUT: Duration = Duration::from_secs(30);

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

#[derive(Default)]
struct OpState {
    /// To save after the command exits 0: (key, secret).
    saves: Vec<(String, String)>,
    /// Saved entries this command used: deleted when git rejects them.
    used: Vec<String>,
    /// Every key answered so far: a second question for it means the answer was wrong.
    answered: HashSet<String>,
    pending_password: Option<PendingPassword>,
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

fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// git's and the servers' wording of a rejected credential.
pub fn is_auth_failure(stderr: &str) -> bool {
    let t = stderr.to_lowercase();
    [
        "authentication failed",
        "permission denied",
        "http basic: access denied",
        "invalid username or password",
        "returned error: 401",
        "returned error: 403",
        "error: 401",
        "error: 403",
    ]
    .iter()
    .any(|p| t.contains(p))
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
        })
    }

    fn handler(self: &Arc<Self>) -> Handler {
        let inner = self.clone();
        Arc::new(move |req| {
            let inner = inner.clone();
            Box::pin(async move { inner.handle(req.token, req.prompt, req.hint).await })
        })
    }

    /// The command ended: revoke the token, withdraw open prompts, then save or forget.
    fn finish(&self, token: &str, outcome: &AuthOutcome<'_>) {
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
            for (key, secret) in saves {
                if let Err(e) = self.store.set(&key, &secret) {
                    self.store_failed(&e);
                    break;
                }
            }
        } else if is_auth_failure(outcome.stderr) {
            for key in used {
                let _ = self.store.delete(&key);
            }
        }
    }

    async fn handle(&self, token: String, text: String, hint: Option<String>) -> Option<String> {
        let op = lock(&self.ops).get(&token).cloned()?;
        let _busy = Busy::new(&op.prompting);
        let prompt = parse(&text, hint.as_deref());
        match op.mode {
            AuthMode::Interactive => self.interactive(&op, prompt).await,
            AuthMode::Silent => self.silent(&op, &prompt).await,
            AuthMode::None => None,
        }
    }

    async fn silent(&self, op: &Op, prompt: &Prompt) -> Option<String> {
        let key = store_key(prompt)?;
        self.saved(op, &key).await
    }

    async fn interactive(&self, op: &Op, prompt: Prompt) -> Option<String> {
        let key = store_key(&prompt);
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
                if let Some(user) = self.saved(op, &key).await {
                    return Some(user);
                }
                let retry = lock(&op.state).answered.contains(&key);
                let reply = self.ask_ui(op, &prompt, true, true, retry).await?;
                let mut st = lock(&op.state);
                st.answered.insert(key.clone());
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
                if let Some(pw) = self.take_pending_password(op, &prompt, key.as_deref()) {
                    return Some(pw);
                }
                if let Some(key) = &key {
                    if let Some(secret) = self.saved(op, key).await {
                        return Some(secret);
                    }
                }
                let retry = key
                    .as_ref()
                    .is_some_and(|k| lock(&op.state).answered.contains(k));
                let reply = self
                    .ask_ui(op, &prompt, false, key.is_some(), retry)
                    .await?;
                if let Some(key) = key {
                    let mut st = lock(&op.state);
                    st.answered.insert(key.clone());
                    if reply.remember && !reply.answer.is_empty() {
                        st.saves.push((key, reply.answer.clone()));
                    }
                }
                Some(reply.answer)
            }
        }
    }

    /// The password typed next to the user name, when this prompt is the one it was typed for.
    fn take_pending_password(&self, op: &Op, prompt: &Prompt, key: Option<&str>) -> Option<String> {
        if prompt.kind != PromptKind::Password {
            return None;
        }
        let mut st = lock(&op.state);
        let pending = st.pending_password.as_ref()?;
        let same_host = prompt.host.as_deref() == Some(pending.origin.as_str());
        let same_user = prompt.user.as_deref().is_none_or(|u| u == pending.user);
        if !same_host || !same_user {
            return None;
        }
        let pending = st.pending_password.take()?;
        if let Some(key) = key {
            st.answered.insert(key.to_string());
            if pending.remember && !pending.password.is_empty() {
                st.saves.push((key.to_string(), pending.password.clone()));
            }
        }
        Some(pending.password)
    }

    /// A saved credential for `key`, unless this command already got an answer for it (then that
    /// answer was wrong: the entry is deleted).
    async fn saved(&self, op: &Op, key: &str) -> Option<String> {
        if !self.use_store.load(Ordering::SeqCst) || self.store_unavailable() {
            return None;
        }
        if lock(&op.state).answered.contains(key) {
            self.forget(key).await;
            return None;
        }
        let secret = self.store_call(|s, k| s.get(k), key).await.flatten()?;
        let mut st = lock(&op.state);
        st.answered.insert(key.to_string());
        st.used.push(key.to_string());
        Some(secret)
    }

    async fn forget(&self, key: &str) {
        let _ = self.store_call(|s, k| s.delete(k), key).await;
    }

    /// One key store call off the async threads, with a time limit. Any error marks the store
    /// as unavailable (the user hears of it once) and gives `None`.
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
            _ => {
                self.store_failed(&StoreError::Unavailable("timed out".into()));
                None
            }
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

    #[test]
    fn auth_failures_are_recognised() {
        assert!(is_auth_failure(
            "fatal: Authentication failed for 'https://x/'"
        ));
        assert!(is_auth_failure("git@host: Permission denied (publickey)."));
        assert!(is_auth_failure(
            "fatal: unable to access 'https://x/': The requested URL returned error: 403"
        ));
        assert!(is_auth_failure("remote: HTTP Basic: Access denied"));
        assert!(!is_auth_failure(
            "fatal: Could not resolve host: example.com"
        ));
        assert!(!is_auth_failure("! [rejected] main -> main (fetch first)"));
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
