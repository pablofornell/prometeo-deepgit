//! Shared application state and the operations on projects that need it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use gitcore::discover::make_project;
use gitcore::palette::ColorChoice;
use gitcore::{ApiError, CancelToken, CloneResult, CloneTarget, Git, Project, RepoInfo, Workspace};

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
    /// Running clones by operation id, to cancel them.
    pub clones: Mutex<HashMap<String, CancelToken>>,
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

    /// Registers a clone and returns its cancel token. An id that is running already is refused.
    pub fn begin_clone(&self, operation_id: &str) -> Result<CancelToken, ApiError> {
        let mut clones = lock(&self.clones);
        if clones.contains_key(operation_id) {
            return Err(api_error("This clone is already running."));
        }
        let token = CancelToken::new();
        clones.insert(operation_id.to_string(), token.clone());
        Ok(token)
    }

    /// Asks a running clone to stop. Unknown ids (already finished) are ignored.
    pub fn cancel_clone(&self, operation_id: &str) {
        if let Some(token) = lock(&self.clones).get(operation_id) {
            token.cancel();
        }
    }

    pub fn end_clone(&self, operation_id: &str) {
        lock(&self.clones).remove(operation_id);
    }

    /// Fails before the clone starts when `target` is a project whose folder will not contain the
    /// clone (a rescan could never find it).
    pub fn check_clone_target(&self, parent: &Path, target: &CloneTarget) -> Result<(), ApiError> {
        let CloneTarget::Project { project_id } = target else {
            return Ok(());
        };
        let ws = lock(&self.workspace);
        let project = ws
            .projects
            .iter()
            .find(|p| &p.id == project_id)
            .ok_or_else(|| api_error("unknown project"))?;
        if parent.starts_with(&project.path) {
            Ok(())
        } else {
            Err(api_error(format!(
                "The parent folder is outside the project folder {}. Choose a folder inside it, or add the clone to a new project.",
                project.path
            )))
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

        // a parent inside the project folder is fine, one outside is refused before the clone
        assert!(st.check_clone_target(&root.join("sub"), &join).is_ok());
        assert!(st.check_clone_target(&root, &join).is_ok());
        let outside = std::fs::canonicalize(dir.path()).unwrap();
        let err = st.check_clone_target(&outside, &join).unwrap_err();
        assert!(
            err.message.contains("outside the project folder"),
            "{}",
            err.message
        );
        let unknown = CloneTarget::Project {
            project_id: "nope".into(),
        };
        assert!(st.check_clone_target(&root, &unknown).is_err());
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
