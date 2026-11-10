//! Helper mode: what the app binary does when git or ssh runs it as `GIT_ASKPASS` / `SSH_ASKPASS`.
//!
//! `main` calls `run_from_env()` before anything else. It sends the prompt (argv[1]) with the
//! token to the app, prints the answer and a newline on stdout and exits 0. On cancel, timeout or
//! any error it prints nothing and exits 1, which git reads as "no credentials" and ssh as a
//! refusal. No GUI toolkit is started, so it is fast and works without a display.

use std::io::Write;
use std::time::Duration;

use crate::endpoint::Endpoint;
use crate::protocol::{
    read_frame, write_frame, Reply, Request, ENV_ENDPOINT, ENV_MARKER, ENV_SSH_PROMPT, ENV_TOKEN,
    VERSION,
};

/// How long the helper waits for the app: a little above the 5 minutes the app gives the user.
pub const REPLY_WAIT: Duration = Duration::from_secs(6 * 60);
const CONNECT_WAIT: Duration = Duration::from_secs(5);
const WRITE_WAIT: Duration = Duration::from_secs(10);

/// The variables the helper reads.
#[derive(Debug, Clone, Default)]
pub struct HelperEnv {
    pub marker: Option<String>,
    pub endpoint: Option<String>,
    pub token: Option<String>,
    pub ssh_prompt: Option<String>,
}

impl HelperEnv {
    pub fn from_process() -> Self {
        let get = |k: &str| std::env::var(k).ok();
        HelperEnv {
            marker: get(ENV_MARKER),
            endpoint: get(ENV_ENDPOINT),
            token: get(ENV_TOKEN),
            ssh_prompt: get(ENV_SSH_PROMPT),
        }
    }

    /// True when this process was started as an askpass helper.
    pub fn is_helper(&self) -> bool {
        self.marker.as_deref() == Some("1") && self.endpoint.is_some() && self.token.is_some()
    }
}

/// The whole helper. `args` are the arguments after the program name. Returns the exit code.
pub fn run(env: &HelperEnv, args: &[String], out: &mut impl Write) -> i32 {
    let (Some(endpoint), Some(token)) = (&env.endpoint, &env.token) else {
        return 1;
    };
    let Some(prompt) = args.first() else {
        return 1;
    };
    // ssh only wants to tell the user something: nothing to ask, nothing to answer.
    if env.ssh_prompt.as_deref() == Some("none") {
        return 0;
    }
    let Some(answer) = ask(endpoint, token, prompt, env.ssh_prompt.as_deref()) else {
        return 1;
    };
    // The answer goes to git or ssh on stdout and nowhere else.
    match writeln!(out, "{answer}").and_then(|_| out.flush()) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

fn ask(endpoint: &str, token: &str, prompt: &str, hint: Option<&str>) -> Option<String> {
    let endpoint = Endpoint::parse(endpoint)?;
    let mut conn = endpoint.connect(CONNECT_WAIT).ok()?;
    conn.set_timeouts(REPLY_WAIT, WRITE_WAIT).ok()?;
    let request = Request {
        v: VERSION,
        token: token.to_string(),
        prompt: prompt.to_string(),
        hint: hint.map(str::to_string),
    };
    write_frame(&mut conn, &request).ok()?;
    let reply: Reply = read_frame(&mut conn).ok()?;
    reply.answer
}

/// Entry point for `main`: `Some(exit_code)` when this process is an askpass helper (the caller
/// exits with it), `None` when the app should start normally.
pub fn run_from_env() -> Option<i32> {
    let env = HelperEnv::from_process();
    if !env.is_helper() {
        return None;
    }
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    Some(run(&env, &args, &mut std::io::stdout().lock()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(endpoint: Option<&str>, token: Option<&str>) -> HelperEnv {
        HelperEnv {
            marker: Some("1".into()),
            endpoint: endpoint.map(str::to_string),
            token: token.map(str::to_string),
            ssh_prompt: None,
        }
    }

    #[test]
    fn is_helper_needs_the_marker_and_both_ipc_variables() {
        assert!(env(Some("tcp:127.0.0.1:1"), Some("t")).is_helper());
        assert!(!env(None, Some("t")).is_helper());
        assert!(!env(Some("tcp:127.0.0.1:1"), None).is_helper());
        let mut e = env(Some("tcp:127.0.0.1:1"), Some("t"));
        e.marker = Some("0".into());
        assert!(!e.is_helper());
        assert!(!HelperEnv::default().is_helper());
    }

    #[test]
    fn no_prompt_argument_fails_without_output() {
        let mut out = Vec::new();
        assert_eq!(
            run(&env(Some("tcp:127.0.0.1:1"), Some("t")), &[], &mut out),
            1
        );
        assert!(out.is_empty());
    }

    #[test]
    fn an_unreachable_app_fails_without_output() {
        // Port 9 (discard) is closed on a normal machine; a bad endpoint text fails the same way.
        let mut out = Vec::new();
        let args = vec!["Password: ".to_string()];
        assert_eq!(
            run(&env(Some("tcp:127.0.0.1:9"), Some("t")), &args, &mut out),
            1
        );
        assert_eq!(run(&env(Some("bogus"), Some("t")), &args, &mut out), 1);
        assert!(out.is_empty());
    }

    #[test]
    fn an_ssh_info_message_needs_no_answer() {
        let mut e = env(Some("tcp:127.0.0.1:9"), Some("t"));
        e.ssh_prompt = Some("none".into());
        let mut out = Vec::new();
        assert_eq!(run(&e, &["Authenticated to host".to_string()], &mut out), 0);
        assert!(out.is_empty());
    }
}
