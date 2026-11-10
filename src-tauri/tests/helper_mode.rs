//! The real app binary as an askpass helper: `main` must answer and exit before any window or
//! GTK code starts, so it works with no display and is fast.

use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use askpass::protocol::{ENV_ENDPOINT, ENV_MARKER, ENV_TOKEN};
use askpass::server::{Handler, Server};

fn handler() -> Handler {
    Arc::new(|req| {
        Box::pin(async move {
            (req.token == "live-token").then(|| format!("answer to: {}", req.prompt))
        })
    })
}

fn run_app(endpoint: &str, token: &str, prompt: &str) -> (std::process::Output, Duration) {
    let started = Instant::now();
    let out = Command::new(env!("CARGO_BIN_EXE_deepgit"))
        .arg(prompt)
        .env(ENV_MARKER, "1")
        .env(ENV_ENDPOINT, endpoint)
        .env(ENV_TOKEN, token)
        // no display: a GTK start would fail or hang here
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .stdin(Stdio::null())
        .output()
        .expect("the app binary starts");
    (out, started.elapsed())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_binary_answers_as_a_helper_without_a_display() {
    let server = Server::start_tcp(handler()).await.unwrap();
    let endpoint = server.endpoint().to_env();
    let (out, took) = tokio::task::spawn_blocking(move || {
        run_app(&endpoint, "live-token", "Username for 'https://x': ")
    })
    .await
    .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "answer to: Username for 'https://x': \n"
    );
    assert!(
        took < Duration::from_secs(3),
        "helper mode is slow: {took:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_token_exits_1_and_prints_nothing() {
    let server = Server::start_tcp(handler()).await.unwrap();
    let endpoint = server.endpoint().to_env();
    let (out, _) =
        tokio::task::spawn_blocking(move || run_app(&endpoint, "dead-token", "Password: "))
            .await
            .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
}
