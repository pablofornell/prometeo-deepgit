//! gitcore: a blocking Rust library that runs the `git` CLI and parses its output.
//! No Tauri dependency; the app layer wraps these functions in `spawn_blocking`.

pub mod clone;
pub mod diff;
pub mod discover;
pub mod error;
pub mod graph;
pub mod log;
pub mod model;
pub mod ops;
pub mod palette;
pub mod refs;
pub mod runner;
pub mod state;
pub mod status;

pub use error::GitError;
pub use model::*;
pub use runner::{CancelToken, Git, Output, RawOutput, Sink, StderrSink};
