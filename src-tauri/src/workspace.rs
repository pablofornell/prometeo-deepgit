//! Workspace persistence (`workspace.json`) and the pure operations on projects.
//! Nothing here depends on Tauri, so it is testable with a temp dir.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use gitcore::discover::path_id;
use gitcore::paths::strip_verbatim;
use gitcore::{Project, RepoInfo, Workspace};
use unicode_normalization::UnicodeNormalization;

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
            normalize_paths(&mut ws);
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

/// Files written before `gitcore::paths::canonicalize` dropped the verbatim prefix on Windows
/// hold paths such as `\\?\C:\work`; the same folder added now is `C:\work`, so it would not
/// match. Such paths get the plain form (`strip_verbatim`, the rule `canonicalize` uses).
///
/// Ids are `path_id` of the canonical path. An entry whose path changes here and whose id is the
/// hash of its old path gets the id of the new path: the id a fresh add, a rescan and a clone
/// compute for that folder. Entries with a plain path keep their ids. The active project follows
/// its new id; a project or repo that is now the same as an earlier one is dropped.
fn normalize_paths(ws: &mut Workspace) {
    let mut moved: Vec<(String, String)> = Vec::new();
    let mut plain = |id: &mut String, path: &mut String| {
        let Some(p) = strip_verbatim(path) else {
            return;
        };
        if *id == path_id(path) {
            let new = path_id(&p);
            moved.push((std::mem::replace(id, new.clone()), new));
        }
        *path = p;
    };
    for project in &mut ws.projects {
        plain(&mut project.id, &mut project.path);
        for repo in &mut project.repos {
            plain(&mut repo.id, &mut repo.path);
        }
        let mut seen = std::collections::HashSet::new();
        project.repos.retain(|r| seen.insert(r.path.clone()));
    }
    if moved.is_empty() {
        return;
    }
    if let Some(active) = ws.active_project_id.as_mut() {
        if let Some((_, new)) = moved.iter().find(|(old, _)| old == active) {
            *active = new.clone();
        }
    }
    // the same folder twice (added again after the upgrade): the first entry stays
    let mut kept: Vec<Project> = Vec::new();
    for project in std::mem::take(&mut ws.projects) {
        match kept
            .iter()
            .find(|k| k.path == project.path || k.id == project.id)
        {
            Some(k) => {
                if ws.active_project_id.as_deref() == Some(project.id.as_str()) {
                    ws.active_project_id = Some(k.id.clone());
                }
            }
            None => kept.push(project),
        }
    }
    ws.projects = kept;
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
/// A name that another project has already (`name_key`) gets a number: "api (2)", "api (3)"...
pub fn add_project(ws: &mut Workspace, mut project: Project) -> Project {
    if let Some(existing) = ws.projects.iter().find(|p| p.path == project.path) {
        return existing.clone();
    }
    project.name = unique_name(ws, &project.name);
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

/// Longest project name, in characters.
pub const PROJECT_NAME_MAX: usize = 80;

/// What two project names are compared by: trimmed, NFC, then a simple case fold (each character
/// lowercased, and the few letters whose fold is not their lowercase, such as final sigma and
/// long s), then NFC again. "Café" (precomposed), "CAFE\u{301}" (combining accent) and " café "
/// are the same name. `src/api/projectName.ts` has the same rule.
pub fn name_key(name: &str) -> String {
    let folded: String = name
        .trim()
        .nfc()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            '\u{3c2}' => '\u{3c3}',   // final sigma
            '\u{17f}' => 's',         // long s
            '\u{3d0}' => '\u{3b2}',   // beta symbol
            '\u{3d1}' => '\u{3b8}',   // theta symbol
            '\u{3d5}' => '\u{3c6}',   // phi symbol
            '\u{3d6}' => '\u{3c0}',   // pi symbol
            '\u{3f0}' => '\u{3ba}',   // kappa symbol
            '\u{3f1}' => '\u{3c1}',   // rho symbol
            '\u{3f5}' => '\u{3b5}',   // lunate epsilon
            '\u{1e9b}' => '\u{1e61}', // long s with dot above
            '\u{1fbe}' => '\u{3b9}',  // prosgegrammeni
            c => c,
        })
        .collect();
    folded.nfc().collect()
}

/// `name`, or the first of "name (2)", "name (3)"... that no project has (`name_key`).
fn unique_name(ws: &Workspace, name: &str) -> String {
    let taken = |n: &str| {
        let key = name_key(n);
        ws.projects.iter().any(|p| name_key(&p.name) == key)
    };
    let base = name.trim();
    if !taken(base) {
        return base.to_string();
    }
    (2..)
        .map(|i| format!("{base} ({i})"))
        .find(|n| !taken(n))
        .expect("a free number")
}

/// Checks a new name for project `id` and returns it trimmed. Refused: empty, longer than
/// `PROJECT_NAME_MAX` characters, control characters, or the name of another project (the same
/// `name_key`: ignoring case, Unicode normal form and surrounding spaces). The browser mock (`src/api/projectName.ts`) has the same rules
/// and messages.
pub fn validate_project_name(ws: &Workspace, id: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("The project name cannot be empty.".into());
    }
    if name.chars().count() > PROJECT_NAME_MAX {
        return Err(format!(
            "The project name is too long: {PROJECT_NAME_MAX} characters at most."
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("The project name cannot contain control characters (tab, new line).".into());
    }
    let key = name_key(name);
    if let Some(other) = ws
        .projects
        .iter()
        .find(|p| p.id != id && name_key(&p.name) == key)
    {
        return Err(format!(
            "Another project is already called \"{}\".",
            other.name.trim()
        ));
    }
    Ok(name.to_string())
}

/// Renames project `id`. Only the name changes: the id (made from the path, never from the name),
/// path, repos and colours stay, so every reference to the project still works, and a rescan keeps
/// the name. Errors: `unknown project`, or the message of `validate_project_name`.
pub fn rename_project(ws: &mut Workspace, id: &str, name: &str) -> Result<Project, String> {
    if !ws.projects.iter().any(|p| p.id == id) {
        return Err("unknown project".into());
    }
    let name = validate_project_name(ws, id, name)?;
    let p = ws
        .projects
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or("unknown project")?;
    p.name = name;
    Ok(p.clone())
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

    #[test]
    fn project_names_are_validated() {
        let mut ws = sample();
        ws.projects[1].name = "  Payments ".into();
        let check = |name: &str| validate_project_name(&ws, "a", name);
        assert_eq!(check("  Work  ").unwrap(), "Work");
        assert_eq!(
            check(" \t ").unwrap_err(),
            "The project name cannot be empty."
        );
        assert_eq!(check(&"x".repeat(80)).unwrap(), "x".repeat(80));
        // 80 characters, not bytes
        assert_eq!(check(&"é".repeat(80)).unwrap(), "é".repeat(80));
        assert_eq!(
            check(&"x".repeat(81)).unwrap_err(),
            "The project name is too long: 80 characters at most."
        );
        assert_eq!(
            check("two\nlines").unwrap_err(),
            "The project name cannot contain control characters (tab, new line)."
        );
        assert_eq!(
            check("a\tb").unwrap_err(),
            "The project name cannot contain control characters (tab, new line)."
        );
        assert_eq!(
            check("payments").unwrap_err(),
            "Another project is already called \"Payments\"."
        );
        // its own name, in another case, is fine
        assert_eq!(check("A").unwrap(), "A");
    }

    #[test]
    fn names_are_compared_in_one_unicode_form_and_case() {
        // "é" precomposed (U+00E9) and as "e" + combining acute (U+0301)
        assert_eq!(name_key(" Caf\u{e9} "), name_key("CAFE\u{301}"));
        assert_eq!(name_key("\u{3a3}\u{3c3}\u{3c2}"), "\u{3c3}\u{3c3}\u{3c3}");
        assert_eq!(name_key("Stra\u{17f}e"), name_key("STRASE"));
        assert_ne!(name_key("api"), name_key("apl"));
        let mut ws = sample();
        ws.projects[1].name = "Caf\u{e9}".into();
        assert_eq!(
            validate_project_name(&ws, "a", "cafe\u{301}").unwrap_err(),
            "Another project is already called \"Caf\u{e9}\"."
        );
    }

    #[test]
    fn a_folder_with_a_taken_name_gets_a_number() {
        let mut ws = Workspace::default();
        let at = |path: &str, name: &str| Project {
            id: path_id(path),
            name: name.into(),
            path: path.into(),
            repos: vec![],
        };
        assert_eq!(add_project(&mut ws, at("/w/api", "api")).name, "api");
        assert_eq!(add_project(&mut ws, at("/x/api", "api")).name, "api (2)");
        assert_eq!(add_project(&mut ws, at("/y/API", "API")).name, "API (3)");
        // the folder that is there already comes back as it is
        assert_eq!(add_project(&mut ws, at("/x/api", "api")).name, "api (2)");
        assert_eq!(
            add_project(&mut ws, at("/z/caf\u{e9}", "caf\u{e9}")).name,
            "caf\u{e9}"
        );
        assert_eq!(
            add_project(&mut ws, at("/q/cafe\u{301}", "Cafe\u{301}")).name,
            "Cafe\u{301} (2)"
        );
        let names: Vec<_> = ws.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["api", "api (2)", "API (3)", "caf\u{e9}", "Cafe\u{301} (2)"]
        );
    }

    /// A file written on Windows before the verbatim prefix was dropped. Ids are hashes of the
    /// stored path, as the app made them then.
    #[test]
    fn old_verbatim_windows_paths_load_in_the_plain_form() {
        let (old_root, old_repo) = (r"\\?\C:\work", r"\\?\C:\work\api");
        let (root, repo) = (r"C:\work", r"C:\work\api");
        let plain = r"/w/plain";
        let custom = r"\\?\D:\custom";
        let device = r"\\?\C:\work\nul";
        let entry = |id: String, path: &str, repos: Vec<RepoInfo>| serde_json::json!({"id": id, "name": "n", "path": path, "repos": repos});
        let ri = |path: &str| RepoInfo {
            id: path_id(path),
            name: "r".into(),
            path: path.into(),
        };
        let file = serde_json::json!({
            "projects": [
                entry(path_id(old_root), old_root, vec![ri(old_root), ri(old_repo)]),
                entry(path_id(plain), plain, vec![ri(plain)]),
                // an id that is not the hash of the path stays
                entry("kept-id".into(), custom, vec![]),
                // a name that needs the prefix stays verbatim
                entry(path_id(device), device, vec![]),
                // the same folder added again after the upgrade
                entry(path_id(root), root, vec![ri(root)]),
            ],
            "activeProjectId": path_id(old_root),
            "ui": {}
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, file.to_string()).unwrap();
        let ws = load(&path);

        let got: Vec<(&str, &str)> = ws
            .projects
            .iter()
            .map(|p| (p.id.as_str(), p.path.as_str()))
            .collect();
        let (root_id, plain_id, device_id) = (path_id(root), path_id(plain), path_id(device));
        assert_eq!(
            got,
            vec![
                (root_id.as_str(), root),
                (plain_id.as_str(), plain),
                ("kept-id", r"D:\custom"),
                (device_id.as_str(), device),
            ]
        );
        let repos: Vec<(String, &str)> = ws.projects[0]
            .repos
            .iter()
            .map(|r| (r.id.clone(), r.path.as_str()))
            .collect();
        assert_eq!(
            repos,
            vec![(path_id(root), root), (path_id(repo), repo)],
            "the ids a rescan gives"
        );
        assert_eq!(ws.active_project_id, Some(path_id(root)));
        // a plain file is left exactly as it is
        save(&path, &sample()).unwrap();
        assert_eq!(load(&path).projects, sample().projects);
    }

    #[test]
    fn rename_keeps_the_id_and_survives_a_rescan_and_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let mut ws = sample();
        let before = ws.projects[0].clone();
        let renamed = rename_project(&mut ws, "a", " Client work ").unwrap();
        assert_eq!(renamed.name, "Client work");
        assert_eq!(
            (&renamed.id, &renamed.path, &renamed.repos),
            (&before.id, &before.path, &before.repos)
        );
        assert_eq!(ws.active_project_id.as_deref(), Some("a"));
        assert_eq!(
            rename_project(&mut ws, "zzz", "x").unwrap_err(),
            "unknown project"
        );
        assert_eq!(
            rename_project(&mut ws, "b", "client WORK").unwrap_err(),
            "Another project is already called \"Client work\"."
        );
        assert_eq!(ws.projects[1].name, "b");

        // a rescan finds the folder name again but keeps the user's name
        let fresh = project("a");
        assert_eq!(
            replace_repos(&mut ws, "a", fresh).unwrap().name,
            "Client work"
        );

        save(&path, &ws).unwrap();
        let back = load(&path);
        assert_eq!(back.projects[0].name, "Client work");
        assert_eq!(back.projects[0].id, "a");
    }
}
