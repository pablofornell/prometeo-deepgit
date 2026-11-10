#![allow(dead_code)]
//! Helpers shared by the integration tests: temp repos built with plain `git` (so commit dates can
//! be controlled), while the code under test uses the gitcore runner.

use std::path::{Path, PathBuf};
use std::process::Command;

use gitcore::{Git, RepoInfo};
use tempfile::TempDir;

pub struct TestRepo {
    pub dir: TempDir,
    pub info: RepoInfo,
}

pub fn git() -> Git {
    Git::new(None)
}

/// Runs git in `dir` with a fixed identity and optional commit time; panics on failure.
pub fn sh(dir: &Path, args: &[&str], time: Option<i64>) -> String {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("LC_ALL", "C");
    if let Some(t) = time {
        let d = format!("@{t} +0000");
        cmd.env("GIT_AUTHOR_DATE", &d).env("GIT_COMMITTER_DATE", &d);
    }
    let out = cmd.output().expect("spawn git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

pub fn init_at(dir: &Path) {
    sh(dir, &["init", "-q", "-b", "main"], None);
    for (k, v) in [
        ("user.name", "Test"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
        ("core.hooksPath", "/dev/null"),
        ("merge.ff", "true"),
        ("pull.rebase", "false"),
        // Git for Windows turns `core.autocrlf` on for the whole system: the worktree files of
        // these repos would then have CRLF line ends. The tests check exact bytes, so the repos
        // are LF on every system; `tests/autocrlf.rs` covers the CRLF case on purpose.
        ("core.autocrlf", "false"),
    ] {
        sh(dir, &["config", k, v], None);
    }
}

pub fn info_for(id: &str, path: &Path) -> RepoInfo {
    RepoInfo {
        id: id.to_string(),
        name: id.to_string(),
        path: path.to_string_lossy().into_owned(),
    }
}

impl TestRepo {
    pub fn new() -> Self {
        Self::named("r1")
    }

    pub fn named(id: &str) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        init_at(dir.path());
        let info = info_for(id, dir.path());
        TestRepo { dir, info }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn sh(&self, args: &[&str]) -> String {
        sh(self.path(), args, None)
    }

    pub fn write(&self, rel: &str, content: &str) {
        let p = self.path().join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(p, content).expect("write");
    }

    pub fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path().join(rel)).expect("read")
    }

    pub fn commit_file(&self, rel: &str, content: &str, msg: &str) -> String {
        self.commit_file_at(rel, content, msg, None)
    }

    /// Writes a file, commits everything with the given time (unix seconds), returns the oid.
    pub fn commit_file_at(&self, rel: &str, content: &str, msg: &str, time: Option<i64>) -> String {
        self.write(rel, content);
        sh(self.path(), &["add", "-A"], None);
        sh(self.path(), &["commit", "-q", "-m", msg], time);
        self.head()
    }

    pub fn head(&self) -> String {
        self.sh(&["rev-parse", "HEAD"])
    }
}

/// A `file://` URL of a local path that git accepts on every system: `file:///srv/x` on Unix,
/// `file://C:/Users/x` on Windows (the form git's own tests use there).
pub fn file_url(path: &Path) -> String {
    format!("file://{}", path.to_string_lossy().replace('\\', "/"))
}

/// `path` with `/` separators, to compare a path with what git prints on Windows.
pub fn slashed(path: &str) -> String {
    path.replace('\\', "/")
}

pub fn pb(p: &Path) -> PathBuf {
    p.to_path_buf()
}
