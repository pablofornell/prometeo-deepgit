//! The git runner: spawns `git`, applies the environment rules of PLAN.md section 3 and
//! reports every call to an optional console sink.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::GitError;
use crate::model::ConsoleEntry;

/// Receives one entry per git call.
pub type Sink = Arc<dyn Fn(ConsoleEntry) + Send + Sync>;

/// Receives the raw bytes git writes to stderr, as they arrive (several lines or half a line).
pub type StderrSink = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// Asks a running `run_streaming` call to stop: the process group is killed and the call fails
/// with `GitError::Cancelled`. Clones share the flag.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// What `run_streaming` adds to a call: live stderr and cancellation.
struct Stream<'a> {
    cancel: &'a CancelToken,
    on_stderr: StderrSink,
}

static NEXT_ENTRY_ID: AtomicU64 = AtomicU64::new(1);
const CONSOLE_CAP: usize = 8 * 1024;
/// Fetch, pull, push and clone are killed after this long without a single byte on stdout or stderr
/// (a dead connection); `--progress` keeps a healthy transfer talking.
const NETWORK_INACTIVITY: Duration = Duration::from_secs(120);
/// Absolute limit of fetch, pull and push, however much they print.
const NETWORK_CAP: Duration = Duration::from_secs(60 * 60);
/// How long the reader threads get to finish after a killed process before they are left behind
/// (on Windows a grandchild such as ssh can keep the pipes open).
const KILLED_JOIN_GRACE: Duration = Duration::from_secs(1);

/// Captured result of a git call. `code` is -1 when the process was killed by a signal.
#[derive(Clone, Debug)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

impl Output {
    /// stdout and stderr joined and trimmed, for user-facing messages.
    pub fn summary(&self) -> String {
        let out = self.stdout.trim();
        let err = self.stderr.trim();
        match (out.is_empty(), err.is_empty()) {
            (true, true) => String::new(),
            (false, true) => out.to_string(),
            (true, false) => err.to_string(),
            (false, false) => format!("{out}\n{err}"),
        }
    }
}

/// Like `Output` but with the bytes untouched, for content that must round-trip (patches).
#[derive(Clone, Debug)]
pub struct RawOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
}

impl RawOutput {
    fn into_output(self) -> Output {
        Output {
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
            code: self.code,
        }
    }
}

#[derive(Clone)]
pub struct Git {
    bin: PathBuf,
    sink: Option<Sink>,
    /// git understands `--end-of-options` (2.24 and later).
    end_of_options: bool,
    /// Inactivity limit of fetch, pull and push.
    network_timeout: Duration,
    /// Absolute limit of fetch, pull and push.
    network_cap: Duration,
}

/// Parses "git version 2.43.0" (or "... 2.39.3 (Apple Git-145)") into (major, minor).
fn parse_version(text: &str) -> Option<(u32, u32)> {
    let v = text.trim().strip_prefix("git version ")?;
    let mut parts = v.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

impl Git {
    /// `git_bin = None` uses `git` from `PATH`. Runs `git --version` once to learn which options
    /// the installed git supports.
    pub fn new(git_bin: Option<PathBuf>) -> Self {
        let bin = git_bin.unwrap_or_else(|| PathBuf::from("git"));
        let end_of_options = Command::new(&bin)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .ok()
            .and_then(|o| parse_version(&String::from_utf8_lossy(&o.stdout)))
            .is_some_and(|v| v >= (2, 24));
        Git {
            bin,
            sink: None,
            end_of_options,
            network_timeout: NETWORK_INACTIVITY,
            network_cap: NETWORK_CAP,
        }
    }

    /// Overrides the inactivity limit of fetch, pull and push: they are killed after this long
    /// without output (120 s by default).
    pub fn with_network_timeout(mut self, d: Duration) -> Self {
        self.network_timeout = d;
        self
    }

    /// Overrides the absolute limit of fetch, pull and push (60 min by default).
    pub fn with_network_cap(mut self, d: Duration) -> Self {
        self.network_cap = d;
        self
    }

    /// `["--end-of-options"]` when git supports it, to put right before user-supplied revisions
    /// of revision-parsing commands (`log`, `show`, `diff`, `rev-parse`); empty on older git,
    /// where `check_name` is the only guard.
    pub fn end_of_options(&self) -> &'static [&'static str] {
        if self.end_of_options {
            &["--end-of-options"]
        } else {
            &[]
        }
    }

    pub fn with_sink(mut self, sink: Sink) -> Self {
        self.sink = Some(sink);
        self
    }

    /// Runs git and fails on a non-zero exit.
    pub fn run(
        &self,
        repo: &Path,
        repo_id: Option<&str>,
        args: &[&str],
        write: bool,
    ) -> Result<Output, GitError> {
        self.run_ok(repo, repo_id, args, write, None, &[])
    }

    /// Like `run`, feeding `stdin` to the process (for `git apply`, `git commit -F -`).
    pub fn run_stdin(
        &self,
        repo: &Path,
        repo_id: Option<&str>,
        args: &[&str],
        write: bool,
        stdin: &[u8],
    ) -> Result<Output, GitError> {
        self.run_ok(repo, repo_id, args, write, Some(stdin), &[])
    }

    /// Like `run`, but the exit codes in `ok_codes` are also accepted (e.g. `diff --no-index` exits 1).
    pub fn run_ok(
        &self,
        repo: &Path,
        repo_id: Option<&str>,
        args: &[&str],
        write: bool,
        stdin: Option<&[u8]>,
        ok_codes: &[i32],
    ) -> Result<Output, GitError> {
        let out = self.run_unchecked(repo, repo_id, args, write, stdin)?;
        if out.code == 0 || ok_codes.contains(&out.code) {
            Ok(out)
        } else {
            Err(command_error(repo, args, &out))
        }
    }

    /// Like `run_ok` but keeps stdout and stderr as raw bytes (no UTF-8 conversion).
    pub fn run_raw(
        &self,
        repo: &Path,
        repo_id: Option<&str>,
        args: &[&str],
        write: bool,
        ok_codes: &[i32],
    ) -> Result<RawOutput, GitError> {
        let out = self.run_unchecked_raw(repo, repo_id, args, write, None)?;
        if out.code == 0 || ok_codes.contains(&out.code) {
            Ok(out)
        } else {
            Err(command_error(repo, args, &out.into_output()))
        }
    }

    /// Runs git and returns the output whatever the exit code (only a spawn failure is an error).
    pub fn run_unchecked(
        &self,
        repo: &Path,
        repo_id: Option<&str>,
        args: &[&str],
        write: bool,
        stdin: Option<&[u8]>,
    ) -> Result<Output, GitError> {
        self.run_unchecked_raw(repo, repo_id, args, write, stdin)
            .map(RawOutput::into_output)
    }

    /// `run_unchecked` with raw output bytes.
    pub fn run_unchecked_raw(
        &self,
        repo: &Path,
        repo_id: Option<&str>,
        args: &[&str],
        write: bool,
        stdin: Option<&[u8]>,
    ) -> Result<RawOutput, GitError> {
        self.run_reported(repo, repo_id, args, write, stdin, None)
    }

    /// Runs a network command (`clone`) and hands its stderr to `on_stderr` while it runs, for
    /// progress. `cancel` kills the process group and gives `GitError::Cancelled`; the usual
    /// network limits apply. A non-zero exit is an error, like `run`. `dir` is where git starts
    /// (`-C`): it must exist.
    pub fn run_streaming(
        &self,
        dir: &Path,
        repo_id: Option<&str>,
        args: &[&str],
        cancel: &CancelToken,
        on_stderr: StderrSink,
    ) -> Result<Output, GitError> {
        let stream = Stream { cancel, on_stderr };
        let out = self
            .run_reported(dir, repo_id, args, true, None, Some(&stream))?
            .into_output();
        if out.code == 0 {
            Ok(out)
        } else {
            Err(command_error(dir, args, &out))
        }
    }

    fn run_reported(
        &self,
        repo: &Path,
        repo_id: Option<&str>,
        args: &[&str],
        write: bool,
        stdin: Option<&[u8]>,
        stream: Option<&Stream>,
    ) -> Result<RawOutput, GitError> {
        let started_at = unix_ms();
        let timer = Instant::now();
        let limits = is_network(args).then_some(Limits {
            inactivity: self.network_timeout,
            cap: self.network_cap,
        });
        let result = self
            .spawn(repo, args, write, stdin, limits, stream)
            .map_err(|e| match e {
                SpawnError::Io(e) => GitError::Io(e),
                SpawnError::Cancelled => GitError::Cancelled,
                SpawnError::Killed(limit) => {
                    let command = subcommand(args).to_string();
                    GitError::Timeout {
                        lock_may_remain: command == "pull" && self.index_lock_exists(repo),
                        command,
                        secs: limit.as_secs(),
                    }
                }
            });
        let duration_ms = timer.elapsed().as_millis() as u64;
        if let Some(sink) = &self.sink {
            let (exit_code, stdout, stderr) = match &result {
                Ok(o) => (
                    Some(o.code),
                    truncate(&String::from_utf8_lossy(&o.stdout)),
                    truncate(&String::from_utf8_lossy(&o.stderr)),
                ),
                Err(e) => (None, String::new(), e.to_string()),
            };
            sink(ConsoleEntry {
                id: NEXT_ENTRY_ID.fetch_add(1, Ordering::Relaxed),
                repo_id: repo_id.map(str::to_string),
                args: args.iter().map(|a| a.to_string()).collect(),
                started_at,
                duration_ms,
                exit_code,
                stdout,
                stderr,
            });
        }
        result
    }

    /// True when the repo's `index.lock` exists (a killed `git pull` can leave it behind). The
    /// file is never removed: another git process of the user may own it.
    fn index_lock_exists(&self, repo: &Path) -> bool {
        Command::new(&self.bin)
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "--git-path", "index.lock"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .is_some_and(|p| repo.join(p).exists())
    }

    /// True when `core.sshCommand` is configured for the repo (it would lose against the env var).
    fn ssh_command_configured(&self, repo: &Path) -> bool {
        Command::new(&self.bin)
            .arg("-C")
            .arg(repo)
            .args(["config", "--get", "core.sshCommand"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map(|o| o.status.success() && !o.stdout.iter().all(u8::is_ascii_whitespace))
            .unwrap_or(false)
    }

    fn spawn(
        &self,
        repo: &Path,
        args: &[&str],
        write: bool,
        stdin: Option<&[u8]>,
        limits: Option<Limits>,
        stream: Option<&Stream>,
    ) -> Result<RawOutput, SpawnError> {
        let mut cmd = Command::new(&self.bin);
        cmd.arg("-C")
            .arg(repo)
            .args([
                "-c",
                "core.quotepath=false",
                "-c",
                "color.ui=never",
                "-c",
                "log.showSignature=false",
                // Keep the user's diff settings from changing the text of patches.
                "-c",
                "diff.noprefix=false",
                "-c",
                "diff.mnemonicPrefix=false",
                "-c",
                "diff.relative=false",
                "-c",
                "diff.suppressBlankEmpty=false",
                "-c",
                "diff.interHunkContext=0",
                "--no-pager",
            ])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("SSH_ASKPASS_REQUIRE", "never")
            .env("LC_ALL", "C")
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            });
        if !write {
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        }
        // ssh must never wait for a password or a host-key question nobody can answer.
        if limits.is_some()
            && std::env::var_os("GIT_SSH_COMMAND").is_none()
            && std::env::var_os("GIT_SSH").is_none()
            && !self.ssh_command_configured(repo)
        {
            cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        #[cfg(unix)]
        if limits.is_some() {
            // Own process group, so a timeout can kill git together with ssh / the helpers.
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn()?;
        let start = Instant::now();
        let activity = Arc::new(AtomicU64::new(0));
        if let (Some(mut pipe), Some(data)) = (child.stdin.take(), stdin) {
            // Written from another thread so a large input cannot deadlock against stdout.
            let data = data.to_vec();
            std::thread::spawn(move || {
                let _ = pipe.write_all(&data);
            });
        }
        let out = child
            .stdout
            .take()
            .map(|p| Reader::start(p, start, activity.clone(), None));
        let err = child.stderr.take().map(|p| {
            Reader::start(
                p,
                start,
                activity.clone(),
                stream.map(|s| s.on_stderr.clone()),
            )
        });
        let waited = wait(
            &mut child,
            limits,
            stream.map(|s| s.cancel),
            start,
            &activity,
        );
        // After a kill the readers are not waited for forever: a grandchild that survived (no
        // process group on Windows) would hold the pipes open and block this call.
        let grace = waited.is_err().then_some(KILLED_JOIN_GRACE);
        let stdout = out.map(|r| r.finish(grace)).unwrap_or_default();
        let mut stderr = err.map(|r| r.finish(grace)).unwrap_or_default();
        let status = waited?;
        if limits.is_some() {
            stderr = collapse_progress(&stderr);
        }
        Ok(RawOutput {
            stdout,
            stderr,
            code: status.code().unwrap_or(-1),
        })
    }
}

/// Limits of a network call.
#[derive(Clone, Copy)]
struct Limits {
    /// Killed after this long without output.
    inactivity: Duration,
    /// Killed after this long whatever happens.
    cap: Duration,
}

enum SpawnError {
    Io(std::io::Error),
    /// Stopped on request (`CancelToken`).
    Cancelled,
    /// Killed for running past this limit.
    Killed(Duration),
}

impl From<std::io::Error> for SpawnError {
    fn from(e: std::io::Error) -> Self {
        SpawnError::Io(e)
    }
}

/// Collects one pipe on its own thread and stamps `activity` (ms since `start`) on every read.
struct Reader {
    buf: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
}

impl Reader {
    fn start<R: Read + Send + 'static>(
        mut pipe: R,
        start: Instant,
        activity: Arc<AtomicU64>,
        on_chunk: Option<StderrSink>,
    ) -> Self {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let (tx, done) = mpsc::channel();
        let shared = buf.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                activity.store(start.elapsed().as_millis() as u64, Ordering::Relaxed);
                if let Some(f) = &on_chunk {
                    f(&chunk[..n]);
                }
                if let Ok(mut b) = shared.lock() {
                    b.extend_from_slice(&chunk[..n]);
                }
            }
            let _ = tx.send(());
        });
        Reader { buf, done }
    }

    /// The bytes read so far once the pipe is closed, or after `grace` when it is set (the
    /// thread is then left to end on its own).
    fn finish(self, grace: Option<Duration>) -> Vec<u8> {
        match grace {
            None => {
                let _ = self.done.recv();
            }
            Some(g) => {
                if let Err(RecvTimeoutError::Timeout) = self.done.recv_timeout(g) {
                    // Detached.
                }
            }
        }
        self.buf
            .lock()
            .map(|mut b| std::mem::take(&mut *b))
            .unwrap_or_default()
    }
}

/// Waits for the child. With `limits` it is killed (with its process group) after `inactivity`
/// without output or after `cap` in total, and the result is `SpawnError::Killed`. A set `cancel`
/// token kills it too, with `SpawnError::Cancelled`.
fn wait(
    child: &mut std::process::Child,
    limits: Option<Limits>,
    cancel: Option<&CancelToken>,
    start: Instant,
    activity: &AtomicU64,
) -> Result<std::process::ExitStatus, SpawnError> {
    if limits.is_none() && cancel.is_none() {
        return Ok(child.wait()?);
    }
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if cancel.is_some_and(CancelToken::is_cancelled) {
            kill_tree(child);
            let _ = child.wait();
            return Err(SpawnError::Cancelled);
        }
        if let Some(limits) = limits {
            let now = start.elapsed();
            let last = Duration::from_millis(activity.load(Ordering::Relaxed));
            let exceeded = if now >= limits.cap {
                Some(limits.cap)
            } else if now.saturating_sub(last) >= limits.inactivity {
                Some(limits.inactivity)
            } else {
                None
            };
            if let Some(limit) = exceeded {
                kill_tree(child);
                let _ = child.wait();
                return Err(SpawnError::Killed(limit));
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// What a terminal would show of git's progress output: of every line only the text after its
/// last carriage return (the final state of the `\r`-overwritten progress counter).
fn collapse_progress(bytes: &[u8]) -> Vec<u8> {
    if !bytes.contains(&b'\r') {
        return bytes.to_vec();
    }
    let mut out = Vec::with_capacity(bytes.len());
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        let body = line.strip_suffix(b"\n").unwrap_or(line);
        let body = body.strip_suffix(b"\r").unwrap_or(body);
        let shown = body.rsplit(|b| *b == b'\r').next().unwrap_or(body);
        out.extend_from_slice(shown);
        if line.ends_with(b"\n") {
            out.push(b'\n');
        }
    }
    out
}

#[cfg(unix)]
fn kill_tree(child: &mut std::process::Child) {
    // SAFETY: plain kill(2) on the process group created for this child.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

/// `taskkill /T` takes the children (ssh, credential helpers) down with git. Untested on Windows.
#[cfg(not(unix))]
fn kill_tree(child: &mut std::process::Child) {
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

/// First argument that is not an option (the git subcommand).
fn subcommand<'a>(args: &[&'a str]) -> &'a str {
    args.iter()
        .copied()
        .find(|a| !a.starts_with('-'))
        .unwrap_or("")
}

/// fetch, pull, push and clone talk to the network and get a time limit.
fn is_network(args: &[&str]) -> bool {
    matches!(subcommand(args), "fetch" | "pull" | "push" | "clone")
}

/// Builds the error for a failed call. `stderr` falls back to stdout (git prints
/// "nothing to commit" on stdout).
pub(crate) fn command_error(repo: &Path, args: &[&str], out: &Output) -> GitError {
    if out.stderr.contains("not a git repository") {
        return GitError::NotARepo(repo.display().to_string());
    }
    let text = if out.stderr.trim().is_empty() {
        out.stdout.trim()
    } else {
        out.stderr.trim()
    };
    GitError::Command {
        args: args.iter().map(|a| a.to_string()).collect(),
        code: out.code,
        stderr: text.to_string(),
    }
}

fn truncate(s: &str) -> String {
    if s.len() <= CONSOLE_CAP {
        return s.to_string();
    }
    let mut end = CONSOLE_CAP;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &s[..end])
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{collapse_progress, parse_version};

    #[test]
    fn progress_lines_collapse_to_their_final_state() {
        let raw = b"remote: counting\rReceiving objects:  50% (1/2)\rReceiving objects: 100% (2/2), done.\r\nFrom x\n * [new branch] a -> b\n";
        assert_eq!(
            String::from_utf8(collapse_progress(raw)).unwrap(),
            "Receiving objects: 100% (2/2), done.\nFrom x\n * [new branch] a -> b\n"
        );
        assert_eq!(collapse_progress(b"plain\n"), b"plain\n");
    }

    #[test]
    fn parses_git_versions() {
        assert_eq!(parse_version("git version 2.43.0\n"), Some((2, 43)));
        assert_eq!(
            parse_version("git version 2.39.3 (Apple Git-145)"),
            Some((2, 39))
        );
        assert_eq!(parse_version("git version 2.17.1"), Some((2, 17)));
        assert_eq!(parse_version("git version 2.44.0.windows.1"), Some((2, 44)));
        assert_eq!(parse_version("not git"), None);
    }
}
