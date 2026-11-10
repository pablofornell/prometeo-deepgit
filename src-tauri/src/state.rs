//! Shared application state and the operations on projects that need it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use gitcore::discover::{make_project, not_found_reason, repo_id};
use gitcore::palette::ColorChoice;
use gitcore::{
    ApiError, CancelToken, CloneResult, CloneTarget, Git, GitError, Project, RepoInfo, Workspace,
};

use crate::logsession::LogSessions;
use crate::watcher::WatcherHandle;
use crate::workspace;

/// Locks a std mutex, ignoring poisoning (the data is plain state, a panic elsewhere must not
/// take every later command down).
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn api_error(message: impl Into<String>) -> ApiError {
    ApiError {
        message: message.into(),
        detail: None,
    }
}

/// How long a cancel for a clone that has not started yet is remembered.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(60);
/// At most this many such cancels are remembered (the oldest go first).
const EARLY_CANCEL_MAX: usize = 64;

fn repo_map(ws: &Workspace) -> HashMap<String, RepoInfo> {
    workspace::all_repos(ws)
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect()
}

pub struct AppState {
    pub git: Arc<Git>,
    pub workspace: Mutex<Workspace>,
    pub workspace_path: PathBuf,
    /// Every repo of every project, by repo id. Rebuilt whenever the projects change.
    pub repos: RwLock<HashMap<String, RepoInfo>>,
    pub sessions: Mutex<LogSessions>,
    /// Serializes write commands per repo.
    pub repo_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub watcher: Mutex<WatcherHandle>,
    /// Running clones by operation id, to cancel them.
    pub clones: Mutex<HashMap<String, CancelToken>>,
    /// Operation ids cancelled before their clone started (the UI sends the cancel and the clone
    /// command through separate calls, so the cancel can win), with the time of the cancel.
    early_cancels: Mutex<HashMap<String, Instant>>,
}

impl AppState {
    /// Loads the workspace from `workspace_path` and fills the repo map. The file watcher starts
    /// with `sync_watcher`, which may be slow on big trees, so the caller decides where to run it.
    pub fn new(git: Git, workspace_path: PathBuf, watcher: WatcherHandle) -> Self {
        let ws = workspace::load(&workspace_path);
        let repos = repo_map(&ws);
        AppState {
            git: Arc::new(git),
            workspace: Mutex::new(ws),
            workspace_path,
            repos: RwLock::new(repos),
            sessions: Mutex::new(LogSessions::default()),
            repo_locks: Mutex::new(HashMap::new()),
            watcher: Mutex::new(watcher),
            clones: Mutex::new(HashMap::new()),
            early_cancels: Mutex::new(HashMap::new()),
        }
    }

    pub fn repo(&self, id: &str) -> Result<RepoInfo, ApiError> {
        self.repos
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| api_error("unknown repository"))
    }

    pub fn repo_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.repo_locks)
            .entry(id.to_string())
            .or_default()
            .clone()
    }

    /// Makes the file watcher follow the repos of the workspace. Touches the file system, so call
    /// it from a blocking context.
    pub fn sync_watcher(&self) {
        let repos = workspace::all_repos(&lock(&self.workspace));
        lock(&self.watcher).sync(&repos);
    }

    /// Rebuilds the repo map from the workspace and re-syncs the file watcher.
    pub fn refresh_repos(&self) {
        let map = repo_map(&lock(&self.workspace));
        *self.repos.write().unwrap_or_else(|e| e.into_inner()) = map;
        self.sync_watcher();
    }

    fn persist(&self, ws: &Workspace) -> Result<(), ApiError> {
        workspace::save(&self.workspace_path, ws)
            .map_err(|e| api_error(format!("Could not save the workspace: {e}")))
    }

    pub fn workspace_snapshot(&self) -> Workspace {
        lock(&self.workspace).clone()
    }

    pub fn save_ui(&self, ui: serde_json::Value) -> Result<(), ApiError> {
        let mut ws = lock(&self.workspace);
        ws.ui = ui;
        self.persist(&ws)
    }

    /// Adds the folder at `path` as a project (blocking: scans the folder).
    pub fn add_project(&self, path: &str) -> Result<Project, ApiError> {
        let canon = std::fs::canonicalize(Path::new(path))
            .map_err(|e| api_error(format!("Cannot open {path}: {e}")))?;
        if !canon.is_dir() {
            return Err(api_error(format!("{path} is not a folder")));
        }
        let canon_str = canon.to_string_lossy();
        if let Some(existing) = lock(&self.workspace)
            .projects
            .iter()
            .find(|p| p.path == canon_str)
        {
            return Ok(existing.clone());
        }
        let project = make_project(&canon);
        if project.repos.is_empty() {
            return Err(api_error(format!("No Git repository found in {path}")));
        }
        let (added, saved) = {
            let mut ws = lock(&self.workspace);
            let added = workspace::add_project(&mut ws, project);
            (added, self.persist(&ws))
        };
        self.refresh_repos();
        saved.map(|()| added)
    }

    pub fn remove_project(&self, id: &str) -> Result<(), ApiError> {
        let saved = {
            let mut ws = lock(&self.workspace);
            if !workspace::remove_project(&mut ws, id) {
                return Err(api_error("unknown project"));
            }
            self.persist(&ws)
        };
        self.refresh_repos();
        saved
    }

    pub fn rescan_project(&self, id: &str) -> Result<Project, ApiError> {
        let path = lock(&self.workspace)
            .projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| PathBuf::from(&p.path))
            .ok_or_else(|| api_error("unknown project"))?;
        let fresh = make_project(&path);
        let (updated, saved) = {
            let mut ws = lock(&self.workspace);
            let updated = workspace::replace_repos(&mut ws, id, fresh)
                .ok_or_else(|| api_error("unknown project"))?;
            (updated, self.persist(&ws))
        };
        self.refresh_repos();
        saved.map(|()| updated)
    }

    /// Sets the colour of a repo (palette index, custom `#RRGGBB`, or neither for Auto) in every
    /// project that holds it. The file watcher is not touched: no repo was added or removed.
    pub fn set_repo_color(
        &self,
        repo_id: &str,
        color: Option<u8>,
        custom: Option<&str>,
    ) -> Result<RepoInfo, ApiError> {
        let choice = ColorChoice::parse(color, custom).map_err(api_error)?;
        let (updated, saved) = {
            let mut ws = lock(&self.workspace);
            let updated = workspace::set_repo_color(&mut ws, repo_id, &choice)
                .ok_or_else(|| api_error("unknown repository"))?;
            *self.repos.write().unwrap_or_else(|e| e.into_inner()) = repo_map(&ws);
            (updated, self.persist(&ws))
        };
        saved.map(|()| updated)
    }

    /// Sets the colour of a project (same arguments as `set_repo_color`).
    pub fn set_project_color(
        &self,
        project_id: &str,
        color: Option<u8>,
        custom: Option<&str>,
    ) -> Result<Project, ApiError> {
        let choice = ColorChoice::parse(color, custom).map_err(api_error)?;
        let mut ws = lock(&self.workspace);
        let updated = workspace::set_project_color(&mut ws, project_id, &choice)
            .ok_or_else(|| api_error("unknown project"))?;
        self.persist(&ws).map(|()| updated)
    }

    /// Registers a clone and returns its cancel token. An id that is running already is refused. An
    /// id that was cancelled before it got here (see `cancel_clone`) ends at once with the
    /// "cancelled" error.
    pub fn begin_clone(&self, operation_id: &str) -> Result<CancelToken, ApiError> {
        self.begin_clone_at(operation_id, Instant::now())
    }

    fn begin_clone_at(&self, operation_id: &str, now: Instant) -> Result<CancelToken, ApiError> {
        if take_early_cancel(&mut lock(&self.early_cancels), operation_id, now) {
            return Err(GitError::Cancelled.into());
        }
        let mut clones = lock(&self.clones);
        if clones.contains_key(operation_id) {
            return Err(api_error("This clone is already running."));
        }
        let token = CancelToken::new();
        clones.insert(operation_id.to_string(), token.clone());
        Ok(token)
    }

    /// Asks a clone to stop. A running one is stopped; an id that is not running yet is
    /// remembered for a minute so `begin_clone` can refuse it. Ids of finished clones are
    /// remembered too, which is harmless: operation ids are never reused.
    pub fn cancel_clone(&self, operation_id: &str) {
        self.cancel_clone_at(operation_id, Instant::now());
    }

    fn cancel_clone_at(&self, operation_id: &str, now: Instant) {
        if let Some(token) = lock(&self.clones).get(operation_id) {
            token.cancel();
            return;
        }
        let mut early = lock(&self.early_cancels);
        early.retain(|_, at| now.saturating_duration_since(*at) < EARLY_CANCEL_TTL);
        if early.len() >= EARLY_CANCEL_MAX {
            if let Some(oldest) = early
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(k, _)| k.clone())
            {
                early.remove(&oldest);
            }
        }
        early.insert(operation_id.to_string(), now);
    }

    pub fn end_clone(&self, operation_id: &str) {
        lock(&self.clones).remove(operation_id);
    }

    /// Fails before the clone starts when `target` is a project that a rescan could not find the
    /// clone in: `clone_path` (the folder the clone will make) is outside the project folder, or a
    /// scan skips it (too deep, or below a folder such as `node_modules` or `.hidden`).
    pub fn check_clone_target(
        &self,
        clone_path: &Path,
        target: &CloneTarget,
    ) -> Result<(), ApiError> {
        let CloneTarget::Project { project_id } = target else {
            return Ok(());
        };
        let ws = lock(&self.workspace);
        let project = ws
            .projects
            .iter()
            .find(|p| &p.id == project_id)
            .ok_or_else(|| api_error("unknown project"))?;
        if !clone_path.starts_with(&project.path) {
            return Err(api_error(format!(
                "The parent folder is outside the project folder {}. Choose a folder inside it, or add the clone to a new project.",
                project.path
            )));
        }
        match not_found_reason(Path::new(&project.path), clone_path) {
            Some(reason) => Err(api_error(reason)),
            None => Ok(()),
        }
    }

    /// Adds the cloned repository at `path` to the project: a rescan of the chosen project, or a
    /// new project whose folder is the clone (blocking: scans the folder).
    pub fn add_cloned(&self, path: &Path, target: &CloneTarget) -> Result<CloneResult, ApiError> {
        let path_str = path.to_string_lossy().into_owned();
        let (project, created_project) = match target {
            CloneTarget::Project { project_id } => (self.rescan_project(project_id)?, false),
            CloneTarget::NewProject => {
                let known = lock(&self.workspace)
                    .projects
                    .iter()
                    .any(|p| Path::new(&p.path) == path);
                (self.add_project(&path_str)?, !known)
            }
        };
        // `check_clone_target` should have made this impossible; if the scan still misses the
        // clone, say where it is instead of claiming it was added.
        let id = repo_id(path);
        if !project.repos.iter().any(|r| r.id == id) {
            return Err(api_error(format!(
                "The repository was cloned to {path_str}, but DeepGit did not find it when it scanned the project {}, so it was not added. Add that folder as a project to open it.",
                project.name
            )));
        }
        Ok(CloneResult {
            path: path_str,
            project,
            created_project,
        })
    }

    pub fn set_active_project(&self, id: &str) -> Result<(), ApiError> {
        let mut ws = lock(&self.workspace);
        if !workspace::set_active(&mut ws, id) {
            return Err(api_error("unknown project"));
        }
        self.persist(&ws)
    }
}

/// Removes and reports a remembered early cancel of `id` (stale ones do not count).
fn take_early_cancel(early: &mut HashMap<String, Instant>, id: &str, now: Instant) -> bool {
    early
        .remove(id)
        .is_some_and(|at| now.saturating_duration_since(at) < EARLY_CANCEL_TTL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn state(dir: &Path) -> AppState {
        let watcher = WatcherHandle::new(Arc::new(|_| {}));
        AppState::new(
            Git::new(None),
            dir.join("cfg").join("workspace.json"),
            watcher,
        )
    }

    fn init_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        let ok = Command::new("git")
            .args(["init", "-q"])
            .arg(path)
            .status()
            .unwrap()
            .success();
        assert!(ok);
    }

    #[test]
    fn clones_register_cancel_and_end() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(dir.path());
        let token = st.begin_clone("op1").unwrap();
        assert!(st.begin_clone("op1").is_err(), "the same id twice");
        assert!(!token.is_cancelled());
        st.cancel_clone("op1");
        assert!(token.is_cancelled());
        st.cancel_clone("unknown"); // nothing happens
        st.end_clone("op1");
        assert!(st.begin_clone("op1").is_ok(), "the id is free again");
    }

    #[test]
    fn a_cloned_repo_joins_the_project_or_becomes_a_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(dir.path());
        let root = std::fs::canonicalize(dir.path()).unwrap().join("work");
        init_repo(&root.join("first"));
        let project = st.add_project(root.to_str().unwrap()).unwrap();
        let join = CloneTarget::Project {
            project_id: project.id.clone(),
        };

        // a clone folder inside the project folder is fine, one outside is refused before the clone
        assert!(st.check_clone_target(&root.join("sub/new"), &join).is_ok());
        assert!(st.check_clone_target(&root.join("new"), &join).is_ok());
        let outside = std::fs::canonicalize(dir.path()).unwrap().join("new");
        let err = st.check_clone_target(&outside, &join).unwrap_err();
        assert!(
            err.message.contains("outside the project folder"),
            "{}",
            err.message
        );
        let unknown = CloneTarget::Project {
            project_id: "nope".into(),
        };
        assert!(st.check_clone_target(&root.join("new"), &unknown).is_err());
        assert!(st
            .check_clone_target(&outside, &CloneTarget::NewProject)
            .is_ok());

        // the clone lands in the project folder: a rescan finds it
        init_repo(&root.join("cloned"));
        let r = st.add_cloned(&root.join("cloned"), &join).unwrap();
        assert!(!r.created_project);
        assert_eq!(r.project.id, project.id);
        assert_eq!(r.project.repos.len(), 2);
        assert!(r.project.repos.iter().any(|x| x.path.ends_with("cloned")));
        assert!(st.repo(&r.project.repos[1].id).is_ok());

        // or it becomes a project of its own
        let alone = std::fs::canonicalize(dir.path()).unwrap().join("alone");
        init_repo(&alone);
        let r = st.add_cloned(&alone, &CloneTarget::NewProject).unwrap();
        assert!(r.created_project);
        assert_eq!(r.project.path, alone.to_string_lossy());
        assert_eq!(st.workspace_snapshot().projects.len(), 2);
        // the same folder again is not a new project
        let again = st.add_cloned(&alone, &CloneTarget::NewProject).unwrap();
        assert!(!again.created_project);
        assert_eq!(st.workspace_snapshot().projects.len(), 2);
    }

    #[test]
    fn a_clone_the_scan_would_skip_is_refused_before_it_starts() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(dir.path());
        let root = std::fs::canonicalize(dir.path()).unwrap().join("work");
        init_repo(&root.join("first"));
        let project = st.add_project(root.to_str().unwrap()).unwrap();
        let join = CloneTarget::Project {
            project_id: project.id.clone(),
        };
        let refused = |rel: &str| {
            st.check_clone_target(&root.join(rel), &join)
                .unwrap_err()
                .message
        };

        // too deep: level 5 (the project folder is level 0)
        assert!(st.check_clone_target(&root.join("a/b/c/d"), &join).is_ok());
        let msg = refused("a/b/c/d/e");
        assert!(msg.contains("4 levels deep"), "{msg}");
        // below a folder a scan skips
        for skipped in [
            "node_modules",
            "target",
            "dist",
            "build",
            ".venv",
            ".hidden",
        ] {
            let msg = refused(&format!("{skipped}/repo"));
            assert!(msg.contains(&format!("\"{skipped}\"")), "{msg}");
        }
        // and a clone folder that itself starts with a dot
        assert!(refused(".dotrepo").contains("\".dotrepo\""));
        // the same paths are fine for a new project
        assert!(st
            .check_clone_target(&root.join("a/b/c/d/e"), &CloneTarget::NewProject)
            .is_ok());
    }

    #[test]
    fn a_clone_that_a_rescan_misses_is_an_error_that_says_where_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(dir.path());
        let root = std::fs::canonicalize(dir.path()).unwrap().join("work");
        init_repo(&root.join("first"));
        let project = st.add_project(root.to_str().unwrap()).unwrap();
        let join = CloneTarget::Project {
            project_id: project.id.clone(),
        };
        // the check before the clone was skipped on purpose: the repo is in a skipped folder
        let hidden = root.join("node_modules/cloned");
        init_repo(&hidden);
        let err = st.add_cloned(&hidden, &join).unwrap_err();
        assert!(
            err.message.contains(&hidden.to_string_lossy().to_string()),
            "{}",
            err.message
        );
        assert!(err.message.contains("was not added"), "{}", err.message);
    }

    #[test]
    fn a_cancel_before_the_clone_registers_is_remembered_for_a_short_time() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(dir.path());
        let t0 = Instant::now();
        st.cancel_clone_at("early", t0);
        let err = st.begin_clone_at("early", t0).unwrap_err();
        assert_eq!(err.message, "The operation was cancelled.");
        // the memory is used up: the id can run now
        assert!(st.begin_clone_at("early", t0).is_ok());
        st.end_clone("early");

        // a cancel that is older than the time limit does not count
        st.cancel_clone_at("stale", t0);
        let later = t0 + EARLY_CANCEL_TTL + Duration::from_secs(1);
        assert!(st.begin_clone_at("stale", later).is_ok());

        // other ids are not touched
        st.cancel_clone_at("a", t0);
        assert!(st.begin_clone_at("b", t0).is_ok());

        // a cancel of a running clone cancels it and is not remembered
        let token = st.begin_clone_at("run", t0).unwrap();
        st.cancel_clone_at("run", t0);
        assert!(token.is_cancelled());
        st.end_clone("run");
        assert!(st.begin_clone_at("run", t0).is_ok());
    }

    #[test]
    fn remembered_cancels_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(dir.path());
        let t0 = Instant::now();
        for i in 0..(EARLY_CANCEL_MAX + 10) {
            st.cancel_clone_at(&format!("id{i}"), t0 + Duration::from_millis(i as u64));
        }
        assert_eq!(lock(&st.early_cancels).len(), EARLY_CANCEL_MAX);
        // the oldest went first, the newest is still there
        assert!(lock(&st.early_cancels).contains_key(&format!("id{}", EARLY_CANCEL_MAX + 9)));
        assert!(!lock(&st.early_cancels).contains_key("id0"));
        // expired entries are dropped when the next cancel comes
        let later = t0 + EARLY_CANCEL_TTL + Duration::from_secs(5);
        st.cancel_clone_at("fresh", later);
        assert_eq!(lock(&st.early_cancels).len(), 1);
    }

    #[test]
    fn add_project_flow() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(dir.path());

        // folder without repos
        let empty = dir.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let err = st.add_project(empty.to_str().unwrap()).unwrap_err();
        assert!(
            err.message.starts_with("No Git repository found in "),
            "{}",
            err.message
        );

        // missing folder
        assert!(st
            .add_project(dir.path().join("nope").to_str().unwrap())
            .is_err());

        // a project with two repos; the first project becomes active
        let proj = dir.path().join("proj");
        init_repo(&proj);
        init_repo(&proj.join("sub"));
        let added = st.add_project(proj.to_str().unwrap()).unwrap();
        assert_eq!(added.repos.len(), 2);
        assert_eq!(
            st.workspace_snapshot().active_project_id.as_deref(),
            Some(added.id.as_str())
        );
        assert!(st.repo(&added.repos[0].id).is_ok());
        assert_eq!(st.repo("zzz").unwrap_err().message, "unknown repository");

        // same path again (even through a trailing slash) returns the existing project
        let again = st.add_project(&format!("{}/", proj.display())).unwrap();
        assert_eq!(again.id, added.id);
        assert_eq!(st.workspace_snapshot().projects.len(), 1);

        // persisted: a new state over the same file sees the project and its repos
        let st2 = state(dir.path());
        assert_eq!(st2.workspace_snapshot().projects.len(), 1);
        assert!(st2.repo(&added.repos[1].id).is_ok());

        // rescan picks up a new repo
        init_repo(&proj.join("other"));
        let rescanned = st.rescan_project(&added.id).unwrap();
        assert_eq!(rescanned.repos.len(), 3);
        assert!(st.repo(&rescanned.repos[2].id).is_ok());

        // removal clears the repo map
        st.remove_project(&added.id).unwrap();
        assert!(st.repo(&added.repos[0].id).is_err());
        assert!(st.remove_project(&added.id).is_err());
    }

    #[test]
    fn colors_are_set_validated_persisted_and_survive_a_rescan() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(dir.path());
        let proj = dir.path().join("proj");
        init_repo(&proj);
        init_repo(&proj.join("a"));
        init_repo(&proj.join("b"));
        let added = st.add_project(proj.to_str().unwrap()).unwrap();
        let ids: Vec<String> = added.repos.iter().map(|r| r.id.clone()).collect();
        // discovery gives the three repos the colours 0, 1, 2
        assert_eq!(
            added.repos.iter().map(|r| r.color).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );

        // bad input is rejected and changes nothing
        let err = |r: Result<RepoInfo, ApiError>| r.unwrap_err().message;
        assert_eq!(
            err(st.set_repo_color(&ids[0], Some(12), None)),
            "Unknown palette color"
        );
        assert_eq!(
            err(st.set_repo_color(&ids[0], None, Some("blue"))),
            "Invalid color, expected #RRGGBB"
        );
        assert_eq!(
            err(st.set_repo_color(&ids[0], Some(1), Some("#FFFFFF"))),
            "Give a palette color or a custom color, not both"
        );
        assert_eq!(
            err(st.set_repo_color("nope", Some(1), None)),
            "unknown repository"
        );
        assert_eq!(st.repo(&ids[0]).unwrap().color, 0);

        // a palette colour and a custom colour
        let r = st.set_repo_color(&ids[1], Some(9), None).unwrap();
        assert_eq!((r.color, r.custom_color), (9, None));
        let r = st.set_repo_color(&ids[2], None, Some("#abcdef")).unwrap();
        assert_eq!(r.custom_color.as_deref(), Some("#ABCDEF"));
        // the repo map sees the change at once
        assert_eq!(st.repo(&ids[1]).unwrap().color, 9);

        // project colour
        let p = st.set_project_color(&added.id, Some(5), None).unwrap();
        assert_eq!(p.color, 5);
        assert!(st.set_project_color("nope", None, None).is_err());
        assert!(st.set_project_color(&added.id, Some(40), None).is_err());

        // persisted: a new state over the same file sees the colours
        let st2 = state(dir.path());
        assert_eq!(st2.repo(&ids[1]).unwrap().color, 9);
        assert_eq!(
            st2.repo(&ids[2]).unwrap().custom_color.as_deref(),
            Some("#ABCDEF")
        );
        assert_eq!(st2.workspace_snapshot().projects[0].color, 5);

        // a rescan with a new repo keeps every colour and gives the new repo the least-used one
        init_repo(&proj.join("c"));
        let rescanned = st.rescan_project(&added.id).unwrap();
        for old in &ids {
            let was = st2.repo(old).unwrap();
            let now = rescanned.repos.iter().find(|r| &r.id == old).unwrap();
            assert_eq!(
                (now.color, &now.custom_color),
                (was.color, &was.custom_color)
            );
        }
        let new = rescanned
            .repos
            .iter()
            .find(|r| !ids.contains(&r.id))
            .unwrap();
        // shown colours: 0 (root), 9 (a); b is custom. Colour 1 is the lowest unused
        assert_eq!(new.color, 1);
        assert_eq!(rescanned.color, 5);
    }
}
