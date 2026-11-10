//! askpass: lets git and ssh ask the user for credentials through a DeepGit dialog.
//!
//! The pieces:
//!
//! - `helper`: the app binary in helper mode (`GIT_ASKPASS` / `SSH_ASKPASS`). Sync, std only.
//! - `protocol`, `endpoint`: the length-prefixed JSON frames and where they travel (Unix domain
//!   socket in a private directory; loopback TCP on Windows).
//! - `server`: the tokio listener that moves frames to a handler.
//! - `prompt`: classifies what git and ssh ask.
//! - `broker`: tokens, answers from the key store or the dialog, save after success, forget
//!   after an authentication failure. Implements `gitcore::AuthBroker`.
//! - `store`: the key store trait, the index of saved keys and an in-memory backend.
//!
//! No Tauri code lives here: the app provides a `Prompter` (dialog) and a `SecretBackend`
//! (system key store).

pub mod broker;
pub mod endpoint;
pub mod helper;
pub mod prompt;
pub mod protocol;
pub mod server;
pub mod store;

pub use broker::{
    is_auth_failure, Broker, Notice, PromptFuture, PromptReply, PromptRequest, Prompter,
    PROMPT_TIMEOUT,
};
pub use helper::run_from_env;
pub use prompt::PromptKind;
pub use store::{CredentialStore, IndexedStore, MemoryBackend, SecretBackend, StoreError};
