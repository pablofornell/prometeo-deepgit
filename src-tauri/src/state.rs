//! Shared application state and the operations on projects that need it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use gitcore::discover::make_project;
use gitcore::{ApiError, Git, Project, RepoInfo, Workspace};

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

    pub fn set_active_project(&self, id: &str) -> Result<(), ApiError> {
        let mut ws = lock(&self.workspace);
        if !workspace::set_active(&mut ws, id) {
            return Err(api_error("unknown project"));
        }
        self.persist(&ws)
    }
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
}
