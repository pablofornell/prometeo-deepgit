//! Workspace persistence (`workspace.json`) and the pure operations on projects.
//! Nothing here depends on Tauri, so it is testable with a temp dir.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use gitcore::{Project, RepoInfo, Workspace};

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Loads the workspace from `path`. A missing file gives an empty workspace; a file that does not
/// parse is renamed to `<path>.corrupt-<unix secs>` and an empty workspace is used.
pub fn load(path: &Path) -> Workspace {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Workspace::default(),
        Err(e) => {
            tracing::warn!("cannot read {}: {e}", path.display());
            return Workspace::default();
        }
    };
    match serde_json::from_str::<Workspace>(&text) {
        Ok(mut ws) => {
            normalize_active(&mut ws);
            ws
        }
        Err(e) => {
            let mut name = path.as_os_str().to_owned();
            name.push(format!(".corrupt-{}", unix_secs()));
            let backup = PathBuf::from(name);
            match std::fs::rename(path, &backup) {
                Ok(()) => tracing::warn!(
                    "workspace file is corrupt ({e}); moved to {}",
                    backup.display()
                ),
                Err(re) => tracing::warn!(
                    "workspace file is corrupt ({e}) and could not be moved aside: {re}"
                ),
            }
            Workspace::default()
        }
    }
}

/// Writes the workspace atomically: temp file in the same folder, then rename.
pub fn save(path: &Path, ws: &Workspace) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(ws).map_err(std::io::Error::other)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// The active project must exist; otherwise fall back to the first one (or none).
fn normalize_active(ws: &mut Workspace) {
    let valid = ws
        .active_project_id
        .as_ref()
        .is_some_and(|id| ws.projects.iter().any(|p| &p.id == id));
    if !valid {
        ws.active_project_id = ws.projects.first().map(|p| p.id.clone());
    }
}

/// Adds `project`, or returns the existing one with the same path. The first project becomes active.
pub fn add_project(ws: &mut Workspace, project: Project) -> Project {
    if let Some(existing) = ws.projects.iter().find(|p| p.path == project.path) {
        return existing.clone();
    }
    ws.projects.push(project.clone());
    if ws.active_project_id.is_none() {
        ws.active_project_id = Some(project.id.clone());
    }
    project
}

/// Removes a project. When it was the active one, the next project (or the previous when it was
/// the last) becomes active. Returns false for an unknown id.
pub fn remove_project(ws: &mut Workspace, id: &str) -> bool {
    let Some(pos) = ws.projects.iter().position(|p| p.id == id) else {
        return false;
    };
    ws.projects.remove(pos);
    if ws.active_project_id.as_deref() == Some(id) {
        let next = pos.min(ws.projects.len().saturating_sub(1));
        ws.active_project_id = ws.projects.get(next).map(|p| p.id.clone());
    }
    true
}

/// Returns false for an unknown id.
pub fn set_active(ws: &mut Workspace, id: &str) -> bool {
    if ws.projects.iter().any(|p| p.id == id) {
        ws.active_project_id = Some(id.to_string());
        true
    } else {
        false
    }
}

/// Replaces the repos of project `id` with those of `fresh` (a rescan). Id, name and path stay.
pub fn replace_repos(ws: &mut Workspace, id: &str, fresh: Project) -> Option<Project> {
    let p = ws.projects.iter_mut().find(|p| p.id == id)?;
    p.repos = fresh.repos;
    Some(p.clone())
}

/// Every repo of every project (a repo shared by two projects appears once).
pub fn all_repos(ws: &Workspace) -> Vec<RepoInfo> {
    let mut seen = std::collections::HashSet::new();
    ws.projects
        .iter()
        .flat_map(|p| p.repos.iter())
        .filter(|r| seen.insert(r.id.clone()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(id: &str) -> RepoInfo {
        RepoInfo {
            id: id.into(),
            name: id.into(),
            path: format!("/w/{id}"),
        }
    }

    fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            name: id.into(),
            path: format!("/w/{id}"),
            repos: vec![repo(id)],
        }
    }

    fn sample() -> Workspace {
        Workspace {
            projects: vec![project("a"), project("b")],
            active_project_id: Some("a".into()),
            ui: serde_json::json!({"sidebar": {"width": 300}}),
        }
    }

    #[test]
    fn missing_file_gives_empty_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let ws = load(&dir.path().join("workspace.json"));
        assert!(ws.projects.is_empty());
        assert!(ws.active_project_id.is_none());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("workspace.json");
        save(&path, &sample()).unwrap();
        let ws = load(&path);
        assert_eq!(ws.projects, sample().projects);
        assert_eq!(ws.active_project_id.as_deref(), Some("a"));
        assert_eq!(ws.ui["sidebar"]["width"], 300);
        // no temp file left behind
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["workspace.json"]);
    }

    #[test]
    fn save_overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        save(&path, &sample()).unwrap();
        save(&path, &Workspace::default()).unwrap();
        assert!(load(&path).projects.is_empty());
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, "{ not json").unwrap();
        let ws = load(&path);
        assert!(ws.projects.is_empty());
        assert!(!path.exists());
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("workspace.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
        let kept = std::fs::read_to_string(dir.path().join(&backups[0])).unwrap();
        assert_eq!(kept, "{ not json");
        // a fresh save works afterwards
        save(&path, &sample()).unwrap();
        assert_eq!(load(&path).projects.len(), 2);
    }

    #[test]
    fn dangling_active_project_falls_back_to_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let mut ws = sample();
        ws.active_project_id = Some("gone".into());
        save(&path, &ws).unwrap();
        assert_eq!(load(&path).active_project_id.as_deref(), Some("a"));
    }

    #[test]
    fn first_project_becomes_active_and_duplicates_return_existing() {
        let mut ws = Workspace::default();
        add_project(&mut ws, project("a"));
        assert_eq!(ws.active_project_id.as_deref(), Some("a"));
        add_project(&mut ws, project("b"));
        assert_eq!(ws.active_project_id.as_deref(), Some("a"));
        let mut dup = project("zzz");
        dup.path = "/w/b".into();
        let got = add_project(&mut ws, dup);
        assert_eq!(got.id, "b");
        assert_eq!(ws.projects.len(), 2);
    }

    #[test]
    fn removing_the_active_project_activates_the_next() {
        let mut ws = Workspace::default();
        for id in ["a", "b", "c"] {
            add_project(&mut ws, project(id));
        }
        assert!(remove_project(&mut ws, "a"));
        assert_eq!(ws.active_project_id.as_deref(), Some("b"));
        set_active(&mut ws, "c");
        assert!(remove_project(&mut ws, "c"));
        assert_eq!(ws.active_project_id.as_deref(), Some("b"));
        assert!(remove_project(&mut ws, "b"));
        assert_eq!(ws.active_project_id, None);
        assert!(!remove_project(&mut ws, "b"));
    }

    #[test]
    fn removing_an_inactive_project_keeps_the_active_one() {
        let mut ws = sample();
        remove_project(&mut ws, "b");
        assert_eq!(ws.active_project_id.as_deref(), Some("a"));
    }

    #[test]
    fn set_active_rejects_unknown_ids() {
        let mut ws = sample();
        assert!(!set_active(&mut ws, "nope"));
        assert!(set_active(&mut ws, "b"));
        assert_eq!(ws.active_project_id.as_deref(), Some("b"));
    }

    #[test]
    fn rescan_replaces_repos_only() {
        let mut ws = sample();
        let mut fresh = project("a");
        fresh.name = "renamed".into();
        fresh.repos = vec![repo("a"), repo("a2")];
        let got = replace_repos(&mut ws, "a", fresh).unwrap();
        assert_eq!(got.name, "a");
        assert_eq!(got.repos.len(), 2);
        assert!(replace_repos(&mut ws, "x", project("x")).is_none());
    }

    #[test]
    fn all_repos_deduplicates() {
        let mut ws = sample();
        ws.projects[1].repos.push(repo("a"));
        let ids: Vec<_> = all_repos(&ws).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    /// Files written while repos and projects had colours hold `color` and `customColor`. They
    /// still load; the fields are dropped and the next save does not write them.
    #[test]
    fn old_workspace_files_with_colors_load_and_the_colors_are_dropped() {
        let old = r##"{
            "projects": [
                {"id": "a", "name": "a", "path": "/w/a", "color": 3, "customColor": "#FF00FF", "repos": [
                    {"id": "r1", "name": "r1", "path": "/w/a/r1", "color": 5, "customColor": "#00FF99"},
                    {"id": "r2", "name": "r2", "path": "/w/a/r2", "color": 255, "customColor": null}]},
                {"id": "b", "name": "b", "path": "/w/b", "repos": [
                    {"id": "r3", "name": "r3", "path": "/w/b/r3", "color": 1}]}
            ],
            "activeProjectId": "b",
            "ui": {"sidebar": {"width": 300}}
        }"##;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, old).unwrap();
        let ws = load(&path);
        // the file was read, not moved aside as corrupt
        assert!(path.exists());
        assert_eq!(ws.active_project_id.as_deref(), Some("b"));
        assert_eq!(ws.ui["sidebar"]["width"], 300);
        let names: Vec<(&str, Vec<&str>)> = ws
            .projects
            .iter()
            .map(|p| {
                (
                    p.name.as_str(),
                    p.repos.iter().map(|r| r.path.as_str()).collect(),
                )
            })
            .collect();
        assert_eq!(
            names,
            vec![("a", vec!["/w/a/r1", "/w/a/r2"]), ("b", vec!["/w/b/r3"])]
        );

        save(&path, &ws).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.to_lowercase().contains("color"), "{text}");
        assert_eq!(load(&path).projects, ws.projects);
    }
}
