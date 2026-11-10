//! File watcher: turns file system activity inside a repository into debounced `repo-changed`
//! notifications. The module has no Tauri dependency; the app passes an `emit` callback.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use gitcore::RepoInfo;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

const DEBOUNCE: Duration = Duration::from_millis(400);

/// Most directory watches a single repository may hold. Past this, no more are added (inotify
/// has a per-user limit); git-dir events keep the app refreshing.
const MAX_DIR_WATCHES: usize = 20_000;

/// Files directly inside `.git` that mean "the repository changed".
const GIT_FILES: [&str; 7] = [
    "HEAD",
    "index",
    "packed-refs",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "FETCH_HEAD",
];
/// Directories inside `.git` whose whole subtree is relevant.
const GIT_DIRS: [&str; 3] = ["refs", "rebase-merge", "rebase-apply"];
/// Directories inside `.git` that only exist while a rebase runs; watched once they appear.
const REBASE_DIRS: [&str; 2] = ["rebase-merge", "rebase-apply"];

/// Build output, dependency and tooling directories: huge, noisy and never interesting.
const IGNORED_DIRS: [&str; 12] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    ".gradle",
    ".idea",
    "__pycache__",
    ".next",
    ".cache",
];

/// Called with a repo id once per repo per debounce batch.
pub type Emit = Arc<dyn Fn(&str) + Send + Sync>;

/// For the tests: every path that made the watcher emit, so a failed assertion can say which
/// file system event was behind a notification.
#[cfg(test)]
static EMIT_CAUSES: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Whether `name` is a directory name that is never watched.
pub fn is_ignored_dir(name: &OsStr) -> bool {
    IGNORED_DIRS.contains(&name.to_string_lossy().as_ref())
}

/// Whether a change at `path` should refresh the repository rooted at `repo_root`.
/// Everything in the worktree counts, except inside ignored directories (see [`IGNORED_DIRS`]);
/// inside `.git` only the state files listed above do, and lock files never do.
pub fn relevant(path: &Path, repo_root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(repo_root) else {
        return false;
    };
    let comps: Vec<&OsStr> = rel.components().map(|c| c.as_os_str()).collect();
    let Some(first) = comps.first() else {
        return false; // the root itself
    };
    if *first != ".git" {
        return !comps.iter().any(|c| is_ignored_dir(c));
    }
    git_internal_relevant(&comps[1..])
}

/// Like the `.git` branch of [`relevant`], for a git dir that lives outside the worktree
/// (linked worktrees and submodules point at one through a `.git` file).
pub fn git_dir_relevant(path: &Path, git_dir: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(git_dir) else {
        return false;
    };
    let comps: Vec<&OsStr> = rel.components().map(|c| c.as_os_str()).collect();
    git_internal_relevant(&comps)
}

/// `rest` is the path inside the git dir.
fn git_internal_relevant(rest: &[&OsStr]) -> bool {
    let Some(last) = rest.last() else {
        return false; // the git dir itself
    };
    if last.to_string_lossy().ends_with(".lock") {
        return false;
    }
    let top = rest[0].to_string_lossy();
    if rest.len() == 1 {
        GIT_FILES.contains(&top.as_ref()) || GIT_DIRS.contains(&top.as_ref())
    } else {
        GIT_DIRS.contains(&top.as_ref())
    }
}

/// The deepest repo root that contains `path`, as `(root, repo_id)`.
pub fn owner<'a>(path: &Path, roots: &'a [(PathBuf, String)]) -> Option<&'a (PathBuf, String)> {
    roots
        .iter()
        .filter(|(root, _)| path.starts_with(root))
        .max_by_key(|(root, _)| root.components().count())
}

/// The real git dir of the repo at `root`: `.git` itself, or the target of a `gitdir:` pointer
/// file (linked worktrees, submodules).
pub fn resolve_git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    let meta = std::fs::metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))?
        .trim();
    let target = root.join(target); // an absolute `target` replaces `root`
    target.is_dir().then_some(target)
}

/// Directories to watch (non-recursively) in a worktree, breadth first, starting at `start`
/// itself. Ignored directories, `.git` and nested repositories (a subdirectory with its own
/// `.git`) are skipped, and symlinks are not followed. At most `limit` directories are returned;
/// the flag says whether more were left out.
fn walk_dirs(start: &Path, limit: usize) -> (Vec<PathBuf>, bool) {
    let mut out = Vec::new();
    let mut queue = VecDeque::from([start.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        if out.len() >= limit {
            return (out, true);
        }
        out.push(dir.clone());
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // `DirEntry::file_type` does not follow symlinks.
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name();
            if name == ".git" || is_ignored_dir(&name) {
                continue;
            }
            let path = entry.path();
            if path.join(".git").exists() {
                continue;
            }
            queue.push_back(path);
        }
    }
    (out, false)
}

/// Whether `path` is a directory inside the worktree of `root` that deserves a watch.
fn is_watchable_dir(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    if rel.as_os_str().is_empty()
        || rel
            .components()
            .any(|c| c.as_os_str() == ".git" || is_ignored_dir(c.as_os_str()))
    {
        return false;
    }
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) && !path.join(".git").exists()
}

/// What is watched for one repository.
struct RepoWatch {
    /// The real git dir, when it could be found.
    git_dir: Option<PathBuf>,
    /// Every path with an OS watch (recursive ones count as one).
    dirs: HashSet<PathBuf>,
    /// The watch cap was reached (or the OS ran out of watches); warned about already.
    capped: bool,
}

impl RepoWatch {
    /// Watches each of `dirs`; stops (and warns once) if `truncated` or the OS runs out.
    fn add(&mut self, w: &mut dyn Watcher, root: &Path, dirs: Vec<PathBuf>, mut truncated: bool) {
        for dir in dirs {
            if self.dirs.contains(&dir) {
                continue;
            }
            match w.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    self.dirs.insert(dir);
                }
                Err(e) if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) => {
                    truncated = true;
                    break;
                }
                // Vanished or unreadable directory: not worth a log line.
                Err(_) => {}
            }
        }
        if truncated && !self.capped {
            self.capped = true;
            tracing::warn!(
                "watch limit reached for {}: not watching more directories there",
                root.display()
            );
        }
    }

    fn add_recursive(&mut self, w: &mut dyn Watcher, dir: PathBuf) {
        if !self.dirs.contains(&dir) && w.watch(&dir, RecursiveMode::Recursive).is_ok() {
            self.dirs.insert(dir);
        }
    }
}

/// State shared between [`WatcherHandle`] and the debouncer's event callback.
struct Inner {
    debouncer: Option<Debouncer<RecommendedWatcher>>,
    /// Active watches, by repo root.
    repos: HashMap<PathBuf, RepoWatch>,
}

impl Inner {
    /// Sets up the watches of a repo that was just added.
    fn setup(&mut self, root: &Path) {
        let Some(debouncer) = self.debouncer.as_mut() else {
            return;
        };
        let w = debouncer.watcher();
        let mut rw = RepoWatch {
            git_dir: resolve_git_dir(root),
            dirs: HashSet::new(),
            capped: false,
        };
        if let Some(git_dir) = rw.git_dir.clone() {
            // The git dir itself catches HEAD/index/... and the creation of the rebase dirs.
            if w.watch(&git_dir, RecursiveMode::NonRecursive).is_ok() {
                rw.dirs.insert(git_dir.clone());
            }
            for sub in GIT_DIRS {
                let dir = git_dir.join(sub);
                if dir.is_dir() {
                    rw.add_recursive(w, dir);
                }
            }
        }
        let (dirs, truncated) = walk_dirs(root, MAX_DIR_WATCHES.saturating_sub(rw.dirs.len()));
        rw.add(w, root, dirs, truncated);
        self.repos.insert(root.to_path_buf(), rw);
    }

    fn teardown(&mut self, root: &Path) {
        let (Some(rw), Some(debouncer)) = (self.repos.remove(root), self.debouncer.as_mut()) else {
            return;
        };
        for dir in rw.dirs {
            // The folder may be gone already; nothing useful to do on failure.
            let _ = debouncer.watcher().unwatch(&dir);
        }
    }

    /// The repo whose out-of-worktree git dir contains `path`, as `(root, git_dir)`.
    fn external_git_owner(&self, path: &Path) -> Option<(&Path, &Path)> {
        self.repos.iter().find_map(|(root, rw)| {
            let git_dir = rw.git_dir.as_deref()?;
            (!git_dir.starts_with(root) && path.starts_with(git_dir))
                .then_some((root.as_path(), git_dir))
        })
    }

    /// Keeps the watches of `root` in line with a change at `path`: new directories (and
    /// rebase state dirs) get watched, vanished ones are forgotten.
    fn maintain(&mut self, root: &Path, path: &Path) {
        let (Some(rw), Some(debouncer)) = (self.repos.get_mut(root), self.debouncer.as_mut())
        else {
            return;
        };
        let w = debouncer.watcher();
        if rw.dirs.contains(path) {
            if !path.exists() {
                // notify drops the OS watch itself; forget it and everything below it.
                rw.dirs.retain(|d| !d.starts_with(path));
                let _ = w.unwatch(path);
            }
            return;
        }
        if !std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
            return;
        }
        if let Some(git_dir) = rw.git_dir.clone() {
            if let Ok(rel) = path.strip_prefix(&git_dir) {
                let mut comps = rel.components();
                if let (Some(top), None) = (comps.next(), comps.next()) {
                    if REBASE_DIRS.contains(&top.as_os_str().to_string_lossy().as_ref()) {
                        rw.add_recursive(w, path.to_path_buf());
                    }
                }
                return;
            }
        }
        if is_watchable_dir(path, root) {
            let (dirs, truncated) = walk_dirs(path, MAX_DIR_WATCHES.saturating_sub(rw.dirs.len()));
            rw.add(w, root, dirs, truncated);
        }
    }
}

/// Owns the debouncer and the set of watched roots.
pub struct WatcherHandle {
    emit: Emit,
    inner: Arc<Mutex<Inner>>,
    /// Every repo root, shared with the event callback.
    roots: Arc<RwLock<Vec<(PathBuf, String)>>>,
    /// Creating the debouncer failed once; do not retry on every sync.
    failed: bool,
}

fn lock(inner: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|e| e.into_inner())
}

impl WatcherHandle {
    pub fn new(emit: Emit) -> Self {
        WatcherHandle {
            emit,
            inner: Arc::new(Mutex::new(Inner {
                debouncer: None,
                repos: HashMap::new(),
            })),
            roots: Arc::new(RwLock::new(Vec::new())),
            failed: false,
        }
    }

    /// Makes the watch set match `repos`. Failures are logged and never propagated.
    pub fn sync(&mut self, repos: &[RepoInfo]) {
        let roots: Vec<(PathBuf, String)> = repos
            .iter()
            .map(|r| (PathBuf::from(&r.path), r.id.clone()))
            .collect();
        // Nested repos are watched on their own; the walk of their parent skips them.
        let wanted: HashSet<PathBuf> = roots.iter().map(|(p, _)| p.clone()).collect();
        *self.roots.write().unwrap_or_else(|e| e.into_inner()) = roots;

        if !self.failed && lock(&self.inner).debouncer.is_none() {
            let debouncer = self.start();
            self.failed = debouncer.is_none();
            lock(&self.inner).debouncer = debouncer;
        }
        let mut inner = lock(&self.inner);
        if inner.debouncer.is_none() {
            return;
        }
        let gone: Vec<PathBuf> = inner
            .repos
            .keys()
            .filter(|r| !wanted.contains(*r))
            .cloned()
            .collect();
        for root in gone {
            inner.teardown(&root);
        }
        for root in wanted {
            if !inner.repos.contains_key(&root) {
                inner.setup(&root);
            }
        }
    }

    /// Whether the OS file watcher could be started.
    #[cfg(test)]
    fn is_active(&self) -> bool {
        lock(&self.inner).debouncer.is_some()
    }

    fn start(&self) -> Option<Debouncer<RecommendedWatcher>> {
        let roots = self.roots.clone();
        let emit = self.emit.clone();
        // Weak: the debouncer (owned by `inner`) owns this callback.
        let shared = Arc::downgrade(&self.inner);
        let handler = move |res: DebounceEventResult| match res {
            Ok(events) => {
                let roots = roots.read().unwrap_or_else(|e| e.into_inner());
                let shared = shared.upgrade();
                let mut inner = shared.as_deref().map(lock);
                let mut ids: Vec<&str> = Vec::new();
                for ev in &events {
                    let path = ev.path.as_path();
                    // A linked worktree's git dir lives outside its root: check it first.
                    let external = inner
                        .as_ref()
                        .and_then(|i| i.external_git_owner(path))
                        .map(|(r, g)| (r.to_path_buf(), g.to_path_buf()));
                    let hit = match external {
                        Some((root, git_dir)) => roots
                            .iter()
                            .find(|(r, _)| *r == root)
                            .map(|(_, id)| (root, id, git_dir_relevant(path, &git_dir))),
                        None => owner(path, &roots)
                            .map(|(root, id)| (root.clone(), id, relevant(path, root))),
                    };
                    let Some((root, id, relevant)) = hit else {
                        continue;
                    };
                    if let Some(inner) = inner.as_mut() {
                        inner.maintain(&root, path);
                    }
                    #[cfg(test)]
                    if relevant {
                        let mut causes = EMIT_CAUSES.lock().unwrap_or_else(|e| e.into_inner());
                        causes.push(path.to_path_buf());
                    }
                    if relevant && !ids.contains(&id.as_str()) {
                        ids.push(id);
                    }
                }
                drop(inner);
                for id in ids {
                    emit(id);
                }
            }
            Err(e) => tracing::warn!("file watcher error: {e}"),
        };
        match new_debouncer(DEBOUNCE, handler) {
            Ok(d) => Some(d),
            Err(e) => {
                tracing::warn!("file watcher disabled: {e}");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(p: &str) -> bool {
        relevant(&Path::new("/w/repo").join(p), Path::new("/w/repo"))
    }

    #[test]
    fn worktree_files_are_relevant() {
        assert!(rel("src/main.rs"));
        assert!(rel("Cargo.lock"));
        assert!(rel(".gitignore"));
        assert!(rel(".github/workflows/ci.yml"));
    }

    #[test]
    fn root_and_git_dir_are_not() {
        assert!(!relevant(Path::new("/w/repo"), Path::new("/w/repo")));
        assert!(!rel(".git"));
        assert!(!relevant(Path::new("/elsewhere/x"), Path::new("/w/repo")));
    }

    #[test]
    fn git_state_files_are_relevant() {
        for f in [
            ".git/HEAD",
            ".git/index",
            ".git/packed-refs",
            ".git/MERGE_HEAD",
            ".git/CHERRY_PICK_HEAD",
            ".git/REVERT_HEAD",
            ".git/FETCH_HEAD",
            ".git/refs",
            ".git/refs/heads/main",
            ".git/refs/remotes/origin/feature/x",
            ".git/refs/stash",
            ".git/rebase-merge",
            ".git/rebase-merge/git-rebase-todo",
            ".git/rebase-apply/patch",
        ] {
            assert!(rel(f), "{f} should be relevant");
        }
    }

    #[test]
    fn other_git_internals_are_ignored() {
        for f in [
            ".git/objects/ab/cdef",
            ".git/logs/HEAD",
            ".git/config",
            ".git/COMMIT_EDITMSG",
            ".git/ORIG_HEAD",
            ".git/hooks/pre-commit",
            ".git/modules/sub/HEAD",
            ".git/info/exclude",
        ] {
            assert!(!rel(f), "{f} should be ignored");
        }
    }

    #[test]
    fn lock_files_inside_git_are_ignored() {
        assert!(!rel(".git/index.lock"));
        assert!(!rel(".git/HEAD.lock"));
        assert!(!rel(".git/refs/heads/main.lock"));
        assert!(!rel(".git/packed-refs.lock"));
    }

    #[test]
    fn ignored_dirs_are_not_relevant() {
        for f in [
            "node_modules/x/index.js",
            "target/debug/app",
            "web/dist/bundle.js",
            "build",
            "a/b/.venv/lib/x.py",
            "src/__pycache__/m.pyc",
            ".next/cache/x",
            ".idea/workspace.xml",
        ] {
            assert!(!rel(f), "{f} should be ignored");
        }
        assert!(rel("src/builder/mod.rs"));
        assert!(rel("outline.md"));
    }

    #[test]
    fn branches_named_like_ignored_dirs_still_count_in_git() {
        assert!(rel(".git/refs/heads/build"));
        assert!(rel(".git/refs/heads/out/x"));
    }

    #[test]
    fn external_git_dir_filter() {
        let g = Path::new("/main/.git/worktrees/w");
        assert!(git_dir_relevant(&g.join("HEAD"), g));
        assert!(git_dir_relevant(&g.join("index"), g));
        assert!(!git_dir_relevant(&g.join("index.lock"), g));
        assert!(!git_dir_relevant(&g.join("gitdir"), g));
        assert!(!git_dir_relevant(g, g));
        assert!(!git_dir_relevant(Path::new("/elsewhere/HEAD"), g));
    }

    fn mkdirs(root: &Path, dirs: &[&str]) {
        for d in dirs {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
    }

    #[test]
    fn walker_skips_ignored_trees_git_and_nested_repos() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        mkdirs(
            root,
            &[
                "src/deep/er",
                "docs",
                "node_modules/pkg/lib",
                "target/debug/deps",
                "web/dist/assets",
                "web/src",
                ".venv/lib",
                ".git/refs/heads",
                "vendor/lib/.git",
                "vendor/lib/src",
            ],
        );
        let (dirs, truncated) = walk_dirs(root, 1000);
        assert!(!truncated);
        let rels: HashSet<String> = dirs
            .iter()
            .map(|d| {
                d.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        let want: HashSet<String> = [
            "",
            "src",
            "src/deep",
            "src/deep/er",
            "docs",
            "web",
            "web/src",
            "vendor",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(rels, want);
    }

    #[test]
    fn walker_respects_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        mkdirs(tmp.path(), &["a/x", "b", "c", "d"]);
        let (dirs, truncated) = walk_dirs(tmp.path(), 3);
        assert_eq!(dirs.len(), 3);
        assert!(truncated);
        assert_eq!(dirs[0], tmp.path());
        let (dirs, truncated) = walk_dirs(tmp.path(), 6);
        assert_eq!(dirs.len(), 6);
        assert!(!truncated);
    }

    #[test]
    fn git_dir_resolution() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(resolve_git_dir(root), None);
        mkdirs(root, &["plain/.git", "real/gitdir"]);
        assert_eq!(
            resolve_git_dir(&root.join("plain")),
            Some(root.join("plain/.git"))
        );
        let wt = root.join("wt");
        std::fs::create_dir(&wt).unwrap();
        let abs = root.join("real/gitdir");
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", abs.display())).unwrap();
        assert_eq!(resolve_git_dir(&wt), Some(abs));
        std::fs::write(wt.join(".git"), "gitdir: ../real/gitdir\n").unwrap();
        assert_eq!(resolve_git_dir(&wt), Some(wt.join("../real/gitdir")));
        std::fs::write(wt.join(".git"), "gitdir: ../nope\n").unwrap();
        assert_eq!(resolve_git_dir(&wt), None);
    }

    #[test]
    fn owner_is_the_deepest_root() {
        let roots = vec![
            (PathBuf::from("/w"), "outer".to_string()),
            (PathBuf::from("/w/libs/inner"), "inner".to_string()),
            (PathBuf::from("/w/libs/inner2"), "other".to_string()),
        ];
        let id = |p: &str| owner(Path::new(p), &roots).map(|(_, id)| id.as_str());
        assert_eq!(id("/w/src/a.rs"), Some("outer"));
        assert_eq!(id("/w/libs/inner/src/a.rs"), Some("inner"));
        assert_eq!(id("/w/libs/inner2/.git/HEAD"), Some("other"));
        assert_eq!(id("/x/y"), None);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn emits_once_per_repo_for_worktree_changes_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        let (tx, rx) = mpsc::channel::<String>();
        let tx = std::sync::Mutex::new(tx);
        let mut w = WatcherHandle::new(Arc::new(move |id: &str| {
            let _ = tx.lock().unwrap().send(id.to_string());
        }));
        w.sync(&[RepoInfo {
            id: "r1".into(),
            name: "r1".into(),
            path: root.to_string_lossy().into_owned(),
            color: 0,
            custom_color: None,
        }]);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        // Noise only: ignored.
        std::fs::write(root.join(".git/objects/blob"), "x").unwrap();
        std::fs::write(root.join(".git/index.lock"), "x").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
        // A burst of worktree changes: one event.
        std::fs::write(root.join("a.txt"), "1").unwrap();
        std::fs::write(root.join("b.txt"), "2").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        assert!(rx.recv_timeout(Duration::from_millis(1000)).is_err());
        // Dropping the repo from the set stops events.
        w.sync(&[]);
        std::fs::write(root.join("c.txt"), "3").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
    }

    fn repo(root: &Path) -> RepoInfo {
        RepoInfo {
            id: "r1".into(),
            name: "r1".into(),
            path: root.to_string_lossy().into_owned(),
            color: 0,
            custom_color: None,
        }
    }

    /// The paths below `root` that made the watcher emit so far, for assertion messages.
    fn causes(root: &Path) -> Vec<PathBuf> {
        EMIT_CAUSES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|p| p.starts_with(root))
            .cloned()
            .collect()
    }

    /// Waits until the watcher has been quiet for a second (at most 10 s) and returns how many
    /// notifications came. Windows reports that a folder changed (a file was made inside it) to
    /// the watch of the folder above, and it can do so late: after the notification for the file
    /// itself, and for a change made right before the watch was set up. Such a notification is
    /// one refresh too many, not a missed one, so the steps below wait for quiet first.
    fn settle(rx: &mpsc::Receiver<String>) -> usize {
        let start = std::time::Instant::now();
        let mut seen = 0;
        while start.elapsed() < Duration::from_secs(10)
            && rx.recv_timeout(Duration::from_millis(1000)).is_ok()
        {
            seen += 1;
        }
        seen
    }

    #[test]
    fn watches_new_directories_but_not_ignored_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = gitcore::paths::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".git/refs/heads")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        let (tx, rx) = mpsc::channel::<String>();
        let tx = std::sync::Mutex::new(tx);
        let mut w = WatcherHandle::new(Arc::new(move |id: &str| {
            let _ = tx.lock().unwrap().send(id.to_string());
        }));
        w.sync(&[repo(&root)]);
        if !w.is_active() {
            eprintln!("skipping: no file watcher available here");
            return;
        }
        {
            let inner = lock(&w.inner);
            let dirs = &inner.repos[&root].dirs;
            assert!(dirs.contains(&root));
            assert!(dirs.contains(&root.join(".git")));
            assert!(dirs.contains(&root.join(".git/refs")));
            assert!(!dirs
                .iter()
                .any(|d| d.starts_with(root.join("node_modules"))));
        }
        let early = settle(&rx);
        {
            // Not through `eprintln!`: the test harness hides that when the test passes, and this
            // line is the only way to see what a system without a developer machine reports.
            use std::io::Write;
            let _ = writeln!(
                std::io::stderr(),
                "watcher test: {early} notification(s) right after the watches were set up, for {:?}",
                causes(&root)
            );
        }
        // Activity in an ignored tree is invisible.
        std::fs::write(root.join("node_modules/pkg/x.js"), "x").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(1500)).is_err(),
            "a change below node_modules was reported; causes so far: {:?}",
            causes(&root)
        );
        // A new directory gets watched, and so do files created later inside it.
        std::fs::create_dir_all(root.join("src/inner")).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        settle(&rx);
        assert!(lock(&w.inner).repos[&root]
            .dirs
            .contains(&root.join("src/inner")));
        std::fs::write(root.join("src/inner/f.rs"), "1").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "r1");
        // A new ignored directory is not watched.
        settle(&rx);
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(1500)).is_err(),
            "a new ignored folder was reported; causes so far: {:?}",
            causes(&root)
        );
        assert!(!lock(&w.inner).repos[&root]
            .dirs
            .iter()
            .any(|d| d.starts_with(root.join("target"))));
    }
}
