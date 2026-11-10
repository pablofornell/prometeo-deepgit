//! `git clone` (PLAN.md section 5.7): the rules for the URL and the target folder, the folder name
//! git would pick, the parsing of git's progress output and the run itself.
//!
//! `plan_clone` validates and touches nothing; `run_clone` clones and, when the clone fails or is
//! cancelled, removes what the clone made (the folder only if the clone created it).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::error::{check_name, GitError};
use crate::model::{CloneOpts, CloneProgress};
use crate::runner::{CancelToken, Git, StderrSink};

/// Receives the progress of a clone: each (phase, percent) once.
pub type ProgressSink = Arc<dyn Fn(CloneProgress) + Send + Sync>;

/// A validated clone: nothing has been created yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClonePlan {
    /// The URL or path, trimmed.
    pub url: String,
    /// The existing parent folder, canonical.
    pub parent: PathBuf,
    /// `parent/dir_name`.
    pub target: PathBuf,
    /// The target folder exists (and is empty): it stays after a failed clone.
    pub target_existed: bool,
}

/// The folder name git picks for `url` (`git clone` without a directory): the last path segment
/// without a trailing `/`, `/.git` or `.git`. Handles `https://host/org/repo.git/`,
/// `git@host:org/repo.git`, `host:repo`, `file:///srv/repo.git` and plain paths, also with `\`.
/// `None` when no name can be found.
pub fn default_dir_name(url: &str) -> Option<String> {
    let is_sep = |c: char| c == '/' || c == '\\';
    let mut s = url
        .trim()
        .trim_end_matches(|c: char| is_sep(c) || c.is_whitespace());
    // "work/repo/.git" is the repo "repo"
    if let Some(head) = s.strip_suffix(".git") {
        if head.ends_with(is_sep) {
            s = head.trim_end_matches(is_sep);
        }
    }
    let s = s.strip_suffix(".git").unwrap_or(s);
    let s = s.trim_end_matches(|c: char| is_sep(c) || c == ':');
    // the last segment: after the last separator, or after the ':' of `host:path`
    let name = s
        .rsplit(|c: char| is_sep(c) || c == ':')
        .next()
        .unwrap_or("");
    match name {
        "" | "." | ".." => None,
        n if n.chars().any(char::is_control) => None,
        n => Some(n.to_string()),
    }
}

/// Reads one progress segment (the text between two `\r` / `\n` of git's stderr), e.g.
/// `Receiving objects:  45% (45/100), 1.2 MiB | 2.1 MiB/s`, `remote: Compressing objects: 100% (9/9), done.`
/// or `remote: Enumerating objects: 11, done.` (no percentage: `percent` is `None`). Anything else
/// (`Cloning into...`, warnings, submodule lines) is `None`.
pub fn parse_progress(segment: &str) -> Option<CloneProgress> {
    let s = segment.trim();
    let s = s.strip_prefix("remote:").map_or(s, str::trim_start);
    let (phase, rest) = s.split_once(':')?;
    let phase = phase.trim();
    if phase.is_empty() || !phase.chars().all(|c| c.is_ascii_alphabetic() || c == ' ') {
        return None;
    }
    let rest = rest.trim_start();
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let percent = rest[digits..]
        .starts_with('%')
        .then(|| rest[..digits].parse::<u32>().unwrap_or(100).min(100) as u8);
    Some(CloneProgress {
        phase: phase.to_string(),
        percent,
    })
}

/// Cuts git's stderr into segments at `\r` and `\n`; the part after the last separator waits for
/// the next chunk.
#[derive(Default)]
struct SegmentSplitter {
    pending: Vec<u8>,
}

/// A segment longer than this is not progress: it is dropped.
const MAX_SEGMENT: usize = 8 * 1024;

impl SegmentSplitter {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            if b == b'\r' || b == b'\n' {
                if !self.pending.is_empty() {
                    out.push(String::from_utf8_lossy(&self.pending).into_owned());
                    self.pending.clear();
                }
            } else if self.pending.len() < MAX_SEGMENT {
                self.pending.push(b);
            }
        }
        out
    }
}

/// `~` and `~/x` mean the home folder (`HOME`, or `USERPROFILE` on Windows).
fn expand_home(path: &str) -> PathBuf {
    let rest = if path == "~" {
        Some("")
    } else {
        path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"))
    };
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match (rest, home) {
        (Some(rest), Some(home)) => Path::new(&home).join(rest),
        _ => PathBuf::from(path),
    }
}

fn invalid(msg: impl Into<String>) -> GitError {
    GitError::Invalid(msg.into())
}

/// Checks the URL, the folder name and the options, and finds the target folder. Rules: the URL is
/// not empty, does not start with `-`, has no control character and no `ext::` / `fd::` transport
/// (they run commands); the name is one path segment (no separators, not `.` or `..`); the parent
/// is an existing absolute folder; the target does not exist or is an empty folder (not a link);
/// the branch passes `check_name`; the depth is at least 1.
pub fn plan_clone(
    url: &str,
    parent_dir: &str,
    dir_name: &str,
    opts: &CloneOpts,
) -> Result<ClonePlan, GitError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(invalid("Enter the URL of the repository."));
    }
    check_name("repository URL", url)?;
    if url.chars().any(char::is_control) {
        return Err(invalid(
            "Invalid repository URL: it contains a control character.",
        ));
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("ext::") || lower.starts_with("fd::") {
        return Err(invalid(
            "This kind of URL (ext:: or fd::) runs commands and is not allowed.",
        ));
    }

    let name = dir_name.trim();
    if name.is_empty() {
        return Err(invalid("Enter a name for the folder."));
    }
    if name.contains(['/', '\\']) || name == "." || name == ".." || name.contains("..") {
        return Err(invalid(
            "The folder name cannot contain '/', '\\' or '..'. Use the parent folder field for the path.",
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(invalid(
            "Invalid folder name: it contains a control character.",
        ));
    }

    if let Some(b) = &opts.branch {
        if b.trim().is_empty() {
            return Err(invalid("The branch name is empty."));
        }
        check_name("branch", b)?;
    }
    if opts.depth == Some(0) {
        return Err(invalid("The depth must be at least 1."));
    }

    let parent_in = parent_dir.trim();
    if parent_in.is_empty() {
        return Err(invalid("Choose the parent folder."));
    }
    let parent_path = expand_home(parent_in);
    if !parent_path.is_absolute() {
        return Err(invalid("The parent folder must be an absolute path."));
    }
    let parent = std::fs::canonicalize(&parent_path)
        .ok()
        .filter(|p| p.is_dir())
        .ok_or_else(|| invalid(format!("The parent folder {parent_in} does not exist.")))?;

    let target = parent.join(name);
    let target_existed = match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(invalid(format!(
                "{} is a link. Choose another folder name.",
                target.display()
            )));
        }
        Ok(meta) if meta.is_dir() => {
            let empty = std::fs::read_dir(&target)?.next().is_none();
            if !empty {
                return Err(invalid(format!(
                    "The folder {} already exists and is not empty.",
                    target.display()
                )));
            }
            true
        }
        Ok(_) => {
            return Err(invalid(format!(
                "{} already exists and is not a folder.",
                target.display()
            )));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    Ok(ClonePlan {
        url: url.to_string(),
        parent,
        target,
        target_existed,
    })
}

/// The arguments after `git`: `clone --progress [--branch b] [--depth n] [--recurse-submodules]
/// -- <url> <path>`.
fn clone_args(plan: &ClonePlan, opts: &CloneOpts) -> Vec<String> {
    let mut args = vec!["clone".to_string(), "--progress".to_string()];
    if let Some(b) = &opts.branch {
        args.push("--branch".into());
        args.push(b.clone());
    }
    if let Some(d) = opts.depth {
        args.push("--depth".into());
        args.push(d.to_string());
    }
    if opts.recurse_submodules {
        args.push("--recurse-submodules".into());
    }
    args.push("--".into());
    args.push(plan.url.clone());
    args.push(plan.target.to_string_lossy().into_owned());
    args
}

/// Removes what a failed clone left. A folder the clone created goes away; one that existed (it
/// was empty) is emptied and stays. Errors are ignored: this is best effort after a failure.
fn clean_up(plan: &ClonePlan) {
    let is_link = std::fs::symlink_metadata(&plan.target)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if is_link {
        return;
    }
    if !plan.target_existed {
        let _ = std::fs::remove_dir_all(&plan.target);
        return;
    }
    let Ok(entries) = std::fs::read_dir(&plan.target) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let _ = if is_dir {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}

/// Clones into `plan.target`, reporting progress. On a failure or a cancel (`GitError::Cancelled`)
/// the partial folder is cleaned up as `clean_up` says. Returns the target folder.
pub fn run_clone(
    git: &Git,
    plan: &ClonePlan,
    opts: &CloneOpts,
    cancel: &CancelToken,
    on_progress: ProgressSink,
) -> Result<PathBuf, GitError> {
    let args = clone_args(plan, opts);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let state = Mutex::new((SegmentSplitter::default(), None::<CloneProgress>));
    let on_stderr: StderrSink = Arc::new(move |bytes: &[u8]| {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        let (splitter, last) = &mut *guard;
        for segment in splitter.push(bytes) {
            if let Some(p) = parse_progress(&segment) {
                if last.as_ref() != Some(&p) {
                    *last = Some(p.clone());
                    on_progress(p);
                }
            }
        }
    });

    match git.run_streaming(&plan.parent, None, &arg_refs, cancel, on_stderr) {
        Ok(_) => Ok(plan.target.clone()),
        Err(e) => {
            clean_up(plan);
            Err(e)
        }
    }
}

/// `plan_clone` then `run_clone`.
pub fn clone(
    git: &Git,
    url: &str,
    parent_dir: &str,
    dir_name: &str,
    opts: &CloneOpts,
    cancel: &CancelToken,
    on_progress: ProgressSink,
) -> Result<PathBuf, GitError> {
    let plan = plan_clone(url, parent_dir, dir_name, opts)?;
    run_clone(git, &plan, opts, cancel, on_progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(url: &str) -> Option<String> {
        default_dir_name(url)
    }

    #[test]
    fn default_name_follows_git() {
        assert_eq!(name("https://github.com/org/repo.git"), Some("repo".into()));
        assert_eq!(
            name("https://github.com/org/repo.git/"),
            Some("repo".into())
        );
        assert_eq!(name("https://github.com/org/repo"), Some("repo".into()));
        assert_eq!(name("https://github.com/org/repo///"), Some("repo".into()));
        assert_eq!(name("git@github.com:org/repo.git"), Some("repo".into()));
        assert_eq!(name("git@github.com:repo.git"), Some("repo".into()));
        assert_eq!(name("host:repo"), Some("repo".into()));
        assert_eq!(
            name("ssh://git@host:2222/org/repo.git"),
            Some("repo".into())
        );
        assert_eq!(name("file:///srv/git/proj.git"), Some("proj".into()));
        assert_eq!(name("file:///srv/git/proj"), Some("proj".into()));
        assert_eq!(name("/srv/git/proj.git"), Some("proj".into()));
        assert_eq!(name("/srv/git/proj/"), Some("proj".into()));
        assert_eq!(name("/srv/work/proj/.git"), Some("proj".into()));
        assert_eq!(name("../relative/proj.git"), Some("proj".into()));
        assert_eq!(name("proj.git"), Some("proj".into()));
        assert_eq!(name("C:\\Users\\me\\proj.git"), Some("proj".into()));
        assert_eq!(name("  https://x.org/a/b.git \n"), Some("b".into()));
        assert_eq!(name("https://example.com"), Some("example.com".into()));
        assert_eq!(name("my.repo.name"), Some("my.repo.name".into()));
        assert_eq!(name("foo.git.git"), Some("foo.git".into()));
    }

    #[test]
    fn default_name_gives_none_when_nothing_is_left() {
        assert_eq!(name(""), None);
        assert_eq!(name("   "), None);
        assert_eq!(name("/"), None);
        assert_eq!(name(".git"), None);
        assert_eq!(name("https://host/.."), None);
    }

    #[test]
    fn progress_lines_are_parsed() {
        let p = |s: &str| parse_progress(s).map(|p| (p.phase, p.percent));
        assert_eq!(
            p("Receiving objects:  45% (45/100), 1.2 MiB | 2.1 MiB/s"),
            Some(("Receiving objects".into(), Some(45)))
        );
        assert_eq!(
            p("Receiving objects: 100% (100/100), 3.4 MiB | 2.1 MiB/s, done."),
            Some(("Receiving objects".into(), Some(100)))
        );
        assert_eq!(
            p("Resolving deltas:   7% (1/14)"),
            Some(("Resolving deltas".into(), Some(7)))
        );
        assert_eq!(
            p("remote: Counting objects:  18% (2/11)"),
            Some(("Counting objects".into(), Some(18)))
        );
        assert_eq!(
            p("remote: Compressing objects: 100% (9/9), done."),
            Some(("Compressing objects".into(), Some(100)))
        );
        assert_eq!(
            p("remote: Enumerating objects: 11, done."),
            Some(("Enumerating objects".into(), None))
        );
        assert_eq!(
            p("Updating files: 100% (50/50), done."),
            Some(("Updating files".into(), Some(100)))
        );
        assert_eq!(p("Cloning into '/tmp/x'..."), None);
        assert_eq!(
            p("warning: --depth is ignored in local clones; use file:// instead."),
            None
        );
        assert_eq!(p("fatal: repository 'x' does not exist"), None);
        assert_eq!(p("Submodule 'a' (u) registered for path 'a'"), None);
        assert_eq!(p("Submodule path 'a': checked out 'abc123'"), None);
        assert_eq!(p(""), None);
    }

    #[test]
    fn splitter_cuts_at_cr_and_lf_and_keeps_the_rest() {
        let mut s = SegmentSplitter::default();
        assert_eq!(
            s.push(b"Cloning into 'x'...\nReceiving objects:  1% (1/9"),
            vec!["Cloning into 'x'..."]
        );
        assert_eq!(
            s.push(b"00)\rReceiving objects:  2% (2/100)\r"),
            vec![
                "Receiving objects:  1% (1/900)",
                "Receiving objects:  2% (2/100)"
            ]
        );
        assert_eq!(s.push(b"\r\n\n"), Vec::<String>::new());
        assert_eq!(s.push(b"tail"), Vec::<String>::new());
        assert_eq!(s.push(b"\n"), vec!["tail"]);
    }

    #[test]
    fn json_matches_the_frontend() {
        use crate::model::CloneTarget;
        let t: CloneTarget =
            serde_json::from_str(r#"{"kind":"project","projectId":"p-1"}"#).unwrap();
        assert_eq!(
            t,
            CloneTarget::Project {
                project_id: "p-1".into()
            }
        );
        let t: CloneTarget = serde_json::from_str(r#"{"kind":"newProject"}"#).unwrap();
        assert_eq!(t, CloneTarget::NewProject);
        let o: CloneOpts =
            serde_json::from_str(r#"{"branch":"dev","depth":null,"recurseSubmodules":true}"#)
                .unwrap();
        assert_eq!(
            o,
            CloneOpts {
                branch: Some("dev".into()),
                depth: None,
                recurse_submodules: true
            }
        );
        let o: CloneOpts = serde_json::from_str("{}").unwrap();
        assert_eq!(o, CloneOpts::default());
        let p = serde_json::to_value(CloneProgress {
            phase: "Receiving objects".into(),
            percent: None,
        })
        .unwrap();
        assert_eq!(
            p,
            serde_json::json!({"phase": "Receiving objects", "percent": null})
        );
    }

    #[test]
    fn clone_args_have_the_flags_and_the_double_dash() {
        let plan = ClonePlan {
            url: "https://h/r.git".into(),
            parent: PathBuf::from("/p"),
            target: PathBuf::from("/p/r"),
            target_existed: false,
        };
        let opts = CloneOpts {
            branch: Some("dev".into()),
            depth: Some(1),
            recurse_submodules: true,
        };
        assert_eq!(
            clone_args(&plan, &opts),
            [
                "clone",
                "--progress",
                "--branch",
                "dev",
                "--depth",
                "1",
                "--recurse-submodules",
                "--",
                "https://h/r.git",
                "/p/r"
            ]
        );
        assert_eq!(
            clone_args(&plan, &CloneOpts::default()),
            ["clone", "--progress", "--", "https://h/r.git", "/p/r"]
        );
    }

    #[test]
    fn plan_rejects_bad_input() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().to_str().unwrap();
        let o = CloneOpts::default();
        let msg = |r: Result<ClonePlan, GitError>| r.unwrap_err().to_string();
        assert!(msg(plan_clone("", parent, "x", &o)).contains("Enter the URL"));
        assert!(msg(plan_clone("  ", parent, "x", &o)).contains("Enter the URL"));
        assert!(
            msg(plan_clone("--upload-pack=touch /tmp/pwn", parent, "x", &o))
                .contains("cannot start with '-'")
        );
        assert!(msg(plan_clone("https://h/r\nx", parent, "x", &o)).contains("control character"));
        assert!(msg(plan_clone("https://h/r\u{7}", parent, "x", &o)).contains("control character"));
        assert!(
            msg(plan_clone("ext::sh -c touch% /tmp/pwn", parent, "x", &o))
                .contains("runs commands")
        );
        assert!(msg(plan_clone("FD::3", parent, "x", &o)).contains("runs commands"));
        for bad in ["", " ", "a/b", "a\\b", ".", "..", "a..b", "../x", "a\nb"] {
            assert!(
                plan_clone("https://h/r", parent, bad, &o).is_err(),
                "{bad:?}"
            );
        }
        assert!(msg(plan_clone("https://h/r", "", "x", &o)).contains("Choose the parent"));
        assert!(msg(plan_clone("https://h/r", "relative/dir", "x", &o)).contains("absolute"));
        assert!(msg(plan_clone(
            "https://h/r",
            &format!("{parent}/nope"),
            "x",
            &o
        ))
        .contains("does not exist"));
        let bad_branch = CloneOpts {
            branch: Some("-x".into()),
            ..CloneOpts::default()
        };
        assert!(plan_clone("https://h/r", parent, "x", &bad_branch).is_err());
        let empty_branch = CloneOpts {
            branch: Some(" ".into()),
            ..CloneOpts::default()
        };
        assert!(plan_clone("https://h/r", parent, "x", &empty_branch).is_err());
        let zero = CloneOpts {
            depth: Some(0),
            ..CloneOpts::default()
        };
        assert!(msg(plan_clone("https://h/r", parent, "x", &zero)).contains("at least 1"));
    }

    #[test]
    fn plan_accepts_a_new_or_an_empty_target_and_refuses_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().to_str().unwrap();
        let o = CloneOpts::default();

        let fresh = plan_clone("  https://h/r.git ", parent, " r ", &o).unwrap();
        assert_eq!(fresh.url, "https://h/r.git");
        assert_eq!(fresh.target, fresh.parent.join("r"));
        assert!(!fresh.target_existed);

        std::fs::create_dir(dir.path().join("empty")).unwrap();
        assert!(plan_clone("u", parent, "empty", &o).unwrap().target_existed);

        std::fs::create_dir(dir.path().join("full")).unwrap();
        std::fs::write(dir.path().join("full/f"), "x").unwrap();
        let e = plan_clone("u", parent, "full", &o).unwrap_err().to_string();
        assert!(e.contains("not empty"), "{e}");

        std::fs::write(dir.path().join("file"), "x").unwrap();
        let e = plan_clone("u", parent, "file", &o).unwrap_err().to_string();
        assert!(e.contains("not a folder"), "{e}");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("empty"), dir.path().join("link")).unwrap();
            let e = plan_clone("u", parent, "link", &o).unwrap_err().to_string();
            assert!(e.contains("is a link"), "{e}");
        }
    }
}
