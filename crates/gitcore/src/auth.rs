//! Authentication of network commands: the contract between the runner and a credential broker.
//!
//! The runner knows nothing about dialogs, sockets or key stores. A broker (the `askpass` crate in
//! the app) hands out one `AuthTicket` per network command: the environment that makes git and
//! ssh call the helper program, and a `finish` hook the runner calls with the outcome (the broker
//! saves the credentials of a successful command and forgets the ones git rejected).
//!
//! `apply_auth_env` is the one function that decides the environment of every remote command
//! (`fetch`, `pull`, `push` and `clone`; see `Git::apply_auth`).

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

/// How a command may ask for credentials.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    /// Never ask: `GIT_TERMINAL_PROMPT=0`, ssh in `BatchMode`. Only ssh-agent and credential
    /// helpers can authenticate.
    None,
    /// Background command (auto-fetch): the helper answers from saved credentials only and fails
    /// fast otherwise. ssh stays in `BatchMode`.
    Silent,
    /// The user started the command: the helper may open a dialog (password, token, passphrase,
    /// unknown host key).
    Interactive,
}

/// What the broker learns about the command that is about to run.
#[derive(Clone, Debug)]
pub struct AuthOp<'a> {
    pub repo_id: Option<&'a str>,
    /// Short label for the dialog: `"git push"`. Never holds arguments (a URL can carry a secret).
    pub command: &'a str,
}

/// Everything `apply_auth_env` needs from the broker for one command.
#[derive(Clone, Debug)]
pub struct AuthContext {
    /// The program git and ssh run to ask: the app binary itself.
    pub helper: PathBuf,
    /// Variables for the helper (endpoint, token). They reach it through the environment only,
    /// never through the command line.
    pub env: Vec<(String, String)>,
    /// Number of prompts open right now. While it is above zero the runner does not count
    /// inactivity: a user typing a password must not get git killed.
    pub prompting: Arc<AtomicUsize>,
}

/// What a finished command looked like, for the broker's save / forget decision.
#[derive(Clone, Copy, Debug)]
pub struct AuthOutcome<'a> {
    pub success: bool,
    pub stderr: &'a str,
}

type Finish = Box<dyn FnOnce(&AuthOutcome<'_>) + Send>;

/// One command's authentication session. Dropping it (also after `finish`) revokes the token.
pub struct AuthTicket {
    pub ctx: AuthContext,
    finish: Option<Finish>,
}

impl AuthTicket {
    pub fn new(ctx: AuthContext, finish: Finish) -> Self {
        AuthTicket {
            ctx,
            finish: Some(finish),
        }
    }

    /// Reports the outcome of the command (runs the broker's hook once).
    pub fn finish(mut self, outcome: &AuthOutcome<'_>) {
        if let Some(f) = self.finish.take() {
            f(outcome);
        }
    }
}

/// Implemented by the app. `begin` returns `None` when there is nothing to set up (mode `None`,
/// broker down): the command then runs as in `AuthMode::None`.
pub trait AuthBroker: Send + Sync {
    fn begin(&self, mode: AuthMode, op: &AuthOp<'_>) -> Option<AuthTicket>;
}

/// Sets the environment that decides how git and ssh authenticate.
///
/// | mode | git | ssh |
/// |---|---|---|
/// | `None` | `GIT_TERMINAL_PROMPT=0` | `SSH_ASKPASS_REQUIRE=never`, `BatchMode=yes` |
/// | `Silent` | + `GIT_ASKPASS=<helper>` | like `None` (`BatchMode` blocks passphrase questions) |
/// | `Interactive` | + `GIT_ASKPASS=<helper>` | `SSH_ASKPASS=<helper>`, `SSH_ASKPASS_REQUIRE=force`, `DISPLAY` set, no `BatchMode` |
///
/// `ctx` is the broker's ticket context; without it every mode behaves like `None`.
/// `user_ssh_command`: the user set `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand`; that is
/// never replaced (`BatchMode` is only added when there is none).
pub fn apply_auth_env(
    cmd: &mut Command,
    mode: AuthMode,
    ctx: Option<&AuthContext>,
    user_ssh_command: bool,
) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    let mode = if ctx.is_some() { mode } else { AuthMode::None };
    let ctx = ctx.filter(|_| mode != AuthMode::None);
    if let Some(ctx) = ctx {
        cmd.env("GIT_ASKPASS", &ctx.helper);
        for (k, v) in &ctx.env {
            cmd.env(k, v);
        }
    }
    if mode == AuthMode::Interactive {
        let helper = &ctx.expect("interactive mode has a context").helper;
        cmd.env("SSH_ASKPASS", helper);
        cmd.env("SSH_ASKPASS_REQUIRE", "force");
        // OpenSSH before 8.4 only runs the askpass program when DISPLAY is set.
        #[cfg(unix)]
        if std::env::var_os("DISPLAY").is_none() {
            cmd.env("DISPLAY", ":0.0");
        }
    } else {
        cmd.env("SSH_ASKPASS_REQUIRE", "never");
        // ssh must never wait for a password or a host-key question nobody can answer.
        if !user_ssh_command {
            cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::OsString;

    fn env_of(cmd: &Command) -> HashMap<String, Option<OsString>> {
        cmd.get_envs()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_owned())))
            .collect()
    }

    fn ctx() -> AuthContext {
        AuthContext {
            helper: PathBuf::from("/opt/deepgit"),
            env: vec![("DEEPGIT_ASKPASS_TOKEN".into(), "t".into())],
            prompting: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn get(env: &HashMap<String, Option<OsString>>, k: &str) -> Option<String> {
        env.get(k)
            .and_then(|v| v.as_ref())
            .map(|v| v.to_string_lossy().into_owned())
    }

    #[test]
    fn none_keeps_batch_mode_and_never_sets_the_helper() {
        let mut cmd = Command::new("git");
        apply_auth_env(&mut cmd, AuthMode::None, None, false);
        let env = env_of(&cmd);
        assert_eq!(get(&env, "GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert_eq!(get(&env, "SSH_ASKPASS_REQUIRE").as_deref(), Some("never"));
        assert_eq!(
            get(&env, "GIT_SSH_COMMAND").as_deref(),
            Some("ssh -o BatchMode=yes")
        );
        assert!(!env.contains_key("GIT_ASKPASS"));
        assert!(!env.contains_key("SSH_ASKPASS"));
    }

    #[test]
    fn a_user_ssh_command_is_left_alone() {
        let mut cmd = Command::new("git");
        apply_auth_env(&mut cmd, AuthMode::None, None, true);
        assert!(!env_of(&cmd).contains_key("GIT_SSH_COMMAND"));
    }

    #[test]
    fn silent_uses_the_helper_for_git_but_keeps_ssh_in_batch_mode() {
        let mut cmd = Command::new("git");
        apply_auth_env(&mut cmd, AuthMode::Silent, Some(&ctx()), false);
        let env = env_of(&cmd);
        assert_eq!(get(&env, "GIT_ASKPASS").as_deref(), Some("/opt/deepgit"));
        assert_eq!(get(&env, "DEEPGIT_ASKPASS_TOKEN").as_deref(), Some("t"));
        assert_eq!(get(&env, "SSH_ASKPASS_REQUIRE").as_deref(), Some("never"));
        assert_eq!(
            get(&env, "GIT_SSH_COMMAND").as_deref(),
            Some("ssh -o BatchMode=yes")
        );
        assert!(!env.contains_key("SSH_ASKPASS"));
    }

    #[test]
    fn interactive_forces_askpass_and_drops_batch_mode() {
        let mut cmd = Command::new("git");
        apply_auth_env(&mut cmd, AuthMode::Interactive, Some(&ctx()), false);
        let env = env_of(&cmd);
        assert_eq!(get(&env, "GIT_ASKPASS").as_deref(), Some("/opt/deepgit"));
        assert_eq!(get(&env, "SSH_ASKPASS").as_deref(), Some("/opt/deepgit"));
        assert_eq!(get(&env, "SSH_ASKPASS_REQUIRE").as_deref(), Some("force"));
        assert_eq!(get(&env, "GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert!(!env.contains_key("GIT_SSH_COMMAND"));
    }

    #[test]
    fn a_mode_without_a_context_falls_back_to_none() {
        let mut cmd = Command::new("git");
        apply_auth_env(&mut cmd, AuthMode::Interactive, None, false);
        let env = env_of(&cmd);
        assert!(!env.contains_key("GIT_ASKPASS"));
        assert_eq!(get(&env, "SSH_ASKPASS_REQUIRE").as_deref(), Some("never"));
    }
}
