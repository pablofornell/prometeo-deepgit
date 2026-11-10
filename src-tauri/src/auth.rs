//! Authentication of network commands (docs/PLAN.md section 5.6): the app side of the `askpass`
//! crate. It shows git's and ssh's questions as dialogs and keeps saved credentials in the
//! system key store.
//!
//! Events (backend -> frontend):
//! - `auth-prompt`: `PromptRequest` (see `askpass::PromptRequest`), one per question.
//! - `auth-prompt-close`: `{ id }`, the question is gone (timeout, command ended).
//! - `auth-notice`: `{ kind: "storeUnavailable", message }`, once per run.
//!
//! Commands: `auth_reply`, `set_auth_prefs`, `credentials_clear`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use askpass::{
    Broker, CredentialStore, IndexedStore, Notice, PromptFuture, PromptReply, PromptRequest,
    Prompter, SecretBackend, StoreError,
};
use gitcore::ApiError;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::state::{api_error, lock};

/// Name of the entries in the system key store.
const KEY_SERVICE: &str = "DeepGit";

// ------------------------------------------------------------------ prompter

type EmitFn = dyn Fn(&str, serde_json::Value) + Send + Sync;

/// Sends the dialogs to the window and waits for `auth_reply`.
pub struct EventPrompter {
    emit: Arc<EmitFn>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Option<PromptReply>>>>,
}

impl EventPrompter {
    pub fn new(emit: Arc<EmitFn>) -> Self {
        EventPrompter {
            emit,
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn for_app(app: AppHandle) -> Self {
        Self::new(Arc::new(move |event, payload| {
            let _ = app.emit(event, payload);
        }))
    }

    /// Resolves a dialog. `None` is a cancel. False when nobody waits for `id` any more.
    pub fn reply(&self, id: u64, reply: Option<PromptReply>) -> bool {
        match lock(&self.pending).remove(&id) {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    #[cfg(test)]
    fn pending_count(&self) -> usize {
        lock(&self.pending).len()
    }
}

#[derive(Serialize)]
struct Closed {
    id: u64,
}

impl Prompter for EventPrompter {
    fn ask(&self, request: PromptRequest) -> PromptFuture {
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(request.id, tx);
        if let Ok(payload) = serde_json::to_value(&request) {
            (self.emit)("auth-prompt", payload);
        }
        Box::pin(async move { rx.await.ok().flatten() })
    }

    fn withdraw(&self, id: u64) {
        lock(&self.pending).remove(&id);
        if let Ok(payload) = serde_json::to_value(Closed { id }) {
            (self.emit)("auth-prompt-close", payload);
        }
    }

    fn notice(&self, notice: Notice) {
        let Notice::StoreUnavailable(message) = notice;
        tracing::warn!("credential store unavailable: {message}");
        (self.emit)(
            "auth-notice",
            serde_json::json!({ "kind": "storeUnavailable", "message": message }),
        );
    }
}

// ------------------------------------------------------------------ key store

/// The system key store through the `keyring` crate: Secret Service (Linux), Keychain (macOS),
/// Credential Manager (Windows). Elsewhere every call reports "unavailable".
pub struct KeyringBackend {
    service: String,
}

impl KeyringBackend {
    pub fn new(service: impl Into<String>) -> Self {
        KeyringBackend {
            service: service.into(),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod native {
    use super::*;

    /// Never `Display` the whole error of a stored value: `BadEncoding` holds the secret's bytes.
    fn map_err(e: keyring::Error) -> StoreError {
        match e {
            keyring::Error::PlatformFailure(inner) => StoreError::Unavailable(inner.to_string()),
            keyring::Error::NoStorageAccess(inner) => StoreError::Unavailable(inner.to_string()),
            keyring::Error::BadEncoding(_) => {
                StoreError::Failed("the saved value is not text".into())
            }
            keyring::Error::Ambiguous(_) => StoreError::Failed("several entries match".into()),
            keyring::Error::TooLong(what, _) => StoreError::Failed(format!("{what} is too long")),
            keyring::Error::Invalid(what, _) => StoreError::Failed(format!("{what} is invalid")),
            _ => StoreError::Failed("unknown key store error".into()),
        }
    }

    impl SecretBackend for KeyringBackend {
        fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
            let entry = keyring::Entry::new(&self.service, key).map_err(map_err)?;
            match entry.get_password() {
                Ok(p) => Ok(Some(p)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(map_err(e)),
            }
        }

        fn set(&self, key: &str, secret: &str) -> Result<(), StoreError> {
            keyring::Entry::new(&self.service, key)
                .and_then(|e| e.set_password(secret))
                .map_err(map_err)
        }

        fn delete(&self, key: &str) -> Result<(), StoreError> {
            let entry = keyring::Entry::new(&self.service, key).map_err(map_err)?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(map_err(e)),
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod native {
    use super::*;

    impl SecretBackend for KeyringBackend {
        fn get(&self, _: &str) -> Result<Option<String>, StoreError> {
            Err(StoreError::Unavailable("no system key store".into()))
        }
        fn set(&self, _: &str, _: &str) -> Result<(), StoreError> {
            Err(StoreError::Unavailable("no system key store".into()))
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Err(StoreError::Unavailable("no system key store".into()))
        }
    }
}

// ------------------------------------------------------------------ state and setup

/// Managed by Tauri. `broker` is `None` when the local IPC could not start: network commands then
/// run without prompts.
pub struct AuthState {
    pub broker: Option<Arc<Broker>>,
    pub prompter: Arc<EventPrompter>,
    pub store: Arc<dyn CredentialStore>,
}

/// Starts the IPC server and builds the state. `config_dir` holds `credentials.json`, the list of
/// saved key names (never a secret).
pub fn init(app: &AppHandle, config_dir: PathBuf) -> AuthState {
    let prompter = Arc::new(EventPrompter::for_app(app.clone()));
    let store: Arc<dyn CredentialStore> = Arc::new(IndexedStore::new(
        KeyringBackend::new(KEY_SERVICE),
        Some(config_dir.join("credentials.json")),
    ));
    // The helper is this very executable: git runs it as GIT_ASKPASS.
    let broker = match std::env::current_exe() {
        Ok(exe) => {
            tauri::async_runtime::block_on(Broker::start(prompter.clone(), store.clone(), exe))
                .map(Arc::new)
                .map_err(|e| {
                    tracing::warn!("password prompts are off: cannot start the askpass server: {e}")
                })
                .ok()
        }
        Err(e) => {
            tracing::warn!("password prompts are off: cannot find the executable: {e}");
            None
        }
    };
    AuthState {
        broker,
        prompter,
        store,
    }
}

// ------------------------------------------------------------------ commands

/// The user's answer to an `auth-prompt`. `answer = None` is Cancel (or Reject for a host key).
/// `secondary` is the password of a `withPassword` dialog. Returns false when the prompt is gone
/// (timed out, or its command ended).
#[tauri::command]
pub async fn auth_reply(
    state: State<'_, AuthState>,
    id: u64,
    answer: Option<String>,
    remember: bool,
    secondary: Option<String>,
) -> Result<bool, ApiError> {
    let reply = answer.map(|answer| PromptReply {
        answer,
        secondary,
        remember,
    });
    Ok(state.prompter.reply(id, reply))
}

/// The setting `useCredentialStore`: read saved credentials and offer "Remember". Default true.
#[tauri::command]
pub async fn set_auth_prefs(
    state: State<'_, AuthState>,
    use_credential_store: bool,
) -> Result<(), ApiError> {
    if let Some(broker) = &state.broker {
        broker.set_use_store(use_credential_store);
    }
    Ok(())
}

/// Forgets every credential DeepGit saved in the key store. Returns how many were removed.
#[tauri::command]
pub async fn credentials_clear(state: State<'_, AuthState>) -> Result<u32, ApiError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || store.clear_all())
        .await
        .map_err(|e| api_error(format!("background task failed: {e}")))?
        .map(|n| n as u32)
        .map_err(|e| api_error(format!("Could not clear the saved credentials: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use askpass::PromptKind;

    fn request(id: u64) -> PromptRequest {
        PromptRequest {
            id,
            kind: PromptKind::Password,
            prompt: "Password for 'https://a@b': ".into(),
            host: Some("https://b".into()),
            user: Some("a".into()),
            key_path: None,
            repo_id: None,
            command: "git push".into(),
            with_password: false,
            can_remember: true,
            retry: false,
        }
    }

    type EventLog = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    fn recording() -> (EventPrompter, EventLog) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        let p = EventPrompter::new(Arc::new(move |event, payload| {
            sink.lock().unwrap().push((event.to_string(), payload));
        }));
        (p, log)
    }

    #[tokio::test]
    async fn a_prompt_is_emitted_and_resolved_by_the_reply() {
        let (p, log) = recording();
        let fut = p.ask(request(5));
        {
            let log = log.lock().unwrap();
            assert_eq!(log[0].0, "auth-prompt");
            assert_eq!(log[0].1["id"], 5);
            assert_eq!(log[0].1["kind"], "password");
        }
        assert!(p.reply(
            5,
            Some(PromptReply {
                answer: "pw".into(),
                secondary: None,
                remember: true
            })
        ));
        let got = fut.await.unwrap();
        assert_eq!(got.answer, "pw");
        assert!(got.remember);
        assert!(!p.reply(5, None), "a second reply finds nobody waiting");
    }

    #[tokio::test]
    async fn cancel_and_withdraw() {
        let (p, log) = recording();
        let fut = p.ask(request(1));
        assert!(p.reply(1, None));
        assert!(fut.await.is_none());

        let _fut = p.ask(request(2));
        assert_eq!(p.pending_count(), 1);
        p.withdraw(2);
        assert_eq!(p.pending_count(), 0);
        let log = log.lock().unwrap();
        let last = log.last().unwrap();
        assert_eq!(last.0, "auth-prompt-close");
        assert_eq!(last.1["id"], 2);
    }

    #[test]
    fn the_notice_is_an_event_without_any_secret() {
        let (p, log) = recording();
        p.notice(Notice::StoreUnavailable("no secret service".into()));
        let log = log.lock().unwrap();
        assert_eq!(log[0].0, "auth-notice");
        assert_eq!(log[0].1["kind"], "storeUnavailable");
    }

    /// Needs a running Secret Service / Keychain / Credential Manager, so it is not part of the
    /// normal run: `cargo test -p deepgit -- --ignored keyring`. It uses a service name of its own
    /// and deletes what it wrote.
    #[test]
    #[ignore = "uses the real system key store"]
    fn keyring_round_trip_with_a_private_service_name() {
        let service = format!("deepgit-test-{}", std::process::id());
        let b = KeyringBackend::new(service);
        let key = "https://tester@example.invalid";
        assert_eq!(b.get(key).unwrap(), None);
        b.set(key, "s3cret").unwrap();
        assert_eq!(b.get(key).unwrap().as_deref(), Some("s3cret"));
        b.delete(key).unwrap();
        assert_eq!(b.get(key).unwrap(), None);
        b.delete(key).unwrap(); // deleting a missing entry is fine
    }
}
