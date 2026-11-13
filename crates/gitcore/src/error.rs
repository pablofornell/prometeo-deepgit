//! Error type of the crate and its conversion to the error sent to the frontend.

use crate::model::ApiError;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// git exited with a non-zero status. `stderr` falls back to stdout when stderr is empty.
    #[error("git {} failed (exit {code}): {stderr}", .args.join(" "))]
    Command {
        args: Vec<String>,
        code: i32,
        stderr: String,
    },
    /// A network command ran past its time limit (`secs`: the inactivity or the absolute one) and
    /// was killed. `lock_may_remain`: a killed `git pull` left `.git/index.lock` behind.
    #[error("git {command} timed out after {secs} s{}", if *.lock_may_remain { ". A git lock file may remain: .git/index.lock" } else { "" })]
    Timeout {
        command: String,
        secs: u64,
        lock_may_remain: bool,
    },
    /// The caller stopped the operation (`CancelToken`).
    #[error("The operation was cancelled.")]
    Cancelled,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not parse git output: {0}")]
    Parse(String),
    #[error("not a git repository: {0}")]
    NotARepo(String),
    /// The requested operation does not apply in the current repository state.
    #[error("{0}")]
    Invalid(String),
}

/// Rejects a user-supplied ref, branch, tag, remote name or revision that git would read as an
/// option (leading `-`) or that cannot be a single argument.
pub(crate) fn check_name(what: &str, value: &str) -> Result<(), GitError> {
    if value.starts_with('-') {
        return Err(GitError::Invalid(format!(
            "Invalid {what} {value:?}: it cannot start with '-'."
        )));
    }
    if value.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(GitError::Invalid(format!(
            "Invalid {what} {value:?}: it contains a control character."
        )));
    }
    Ok(())
}

/// Like `check_name`, for a branch that ends up in a push refspec or a remote delete: refspec
/// syntax (`+` force prefix, `src:dst`, `^`, `~`) must not be smuggled in.
pub(crate) fn check_push_branch(what: &str, value: &str) -> Result<(), GitError> {
    check_name(what, value)?;
    if value.starts_with('+') || value.contains([':', '^', '~']) {
        return Err(GitError::Invalid(format!(
            "Invalid {what} {value:?}: it cannot start with '+' or contain ':', '^' or '~'."
        )));
    }
    Ok(())
}

/// A clear English message for the failures users hit most; `None` for anything else.
fn friendly_message(sub: &str, text: &str) -> Option<&'static str> {
    let t = text.to_lowercase();
    let has = |s: &str| t.contains(s);
    let push = sub == "push" || has("failed to push");
    if has("nothing to commit") || has("no changes added to commit") {
        Some("Nothing to commit. Stage changes first.")
    } else if push && (has("[rejected]") || has("non-fast-forward") || has("fetch first")) {
        Some("Push rejected: the remote has new commits. Pull first.")
    } else if push && has("[remote rejected]") {
        Some("The remote rejected the push. See the details for its reason.")
    } else if has("authentication failed") {
        Some("Authentication failed. Check your user name and password or token, then try again.")
    } else if has("could not read username")
        || has("could not read password")
        || has("terminal prompts disabled")
    {
        // The dialog was cancelled, or the command ran in the background (auto-fetch).
        Some("No credentials were given. Run the command again and enter them, or set up a credential helper or an SSH agent.")
    } else if has("permission denied (publickey") {
        Some("SSH authentication failed (permission denied). Check the passphrase of your key, or load the key in an SSH agent.")
    } else if has("not possible to fast-forward") {
        Some("Cannot fast-forward: the branches have diverged. Choose another merge mode.")
    } else if has("refusing to merge unrelated histories") {
        Some("The branches have no common history. Tick \"Allow unrelated histories\" to merge them anyway.")
    } else if has("could not resolve host") {
        Some("Could not resolve the host. Check your network connection and the remote URL.")
    } else {
        None
    }
}

/// The most meaningful line of a git error: the first `fatal:`, else the first `error:`, else the
/// first line that is not a `hint:` / `warning:`, else the first line.
fn pick_line(stderr: &str) -> Option<&str> {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let starting = |p: &str| lines.iter().find(|l| l.starts_with(p));
    starting("fatal:")
        .or_else(|| starting("error:"))
        .or_else(|| {
            lines
                .iter()
                .find(|l| !l.starts_with("hint:") && !l.starts_with("warning:"))
        })
        .or_else(|| lines.first())
        .copied()
}

impl From<GitError> for ApiError {
    fn from(e: GitError) -> Self {
        match e {
            GitError::Command { args, code, stderr } => {
                let sub = args
                    .iter()
                    .find(|a| !a.starts_with('-'))
                    .cloned()
                    .unwrap_or_default();
                let message = friendly_message(&sub, &stderr)
                    .map(str::to_string)
                    .or_else(|| pick_line(&stderr).map(str::to_string))
                    .unwrap_or_else(|| format!("git {sub} failed (exit {code})"));
                ApiError {
                    message,
                    detail: if stderr.trim().is_empty() {
                        None
                    } else {
                        Some(stderr)
                    },
                    code: None,
                }
            }
            other => ApiError {
                message: other.to_string(),
                detail: None,
                code: None,
            },
        }
    }
}
