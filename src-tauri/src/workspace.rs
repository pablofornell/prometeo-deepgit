//! Workspace persistence (`workspace.json`) and the pure operations on projects.
//! Nothing here depends on Tauri, so it is testable with a temp dir.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use gitcore::palette::{next_color, ColorChoice, PALETTE_SIZE};
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
            normalize_colors(&mut ws);
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

/// Old files have no project colours, and a hand-edited file may hold an index outside the
/// palette. Fold repo indexes into the palette and give each project without a valid colour the
/// least-used one.
fn normalize_colors(ws: &mut Workspace) {
    for r in ws.projects.iter_mut().flat_map(|p| p.repos.iter_mut()) {
        r.color %= PALETTE_SIZE;
    }
    for i in 0..ws.projects.len() {
        if ws.projects[i].color >= PALETTE_SIZE {
            let used = project_colors_used(ws, Some(i));
            ws.projects[i].color = next_color(used);
        }
    }
}

/// Palette indexes of the projects that show one (those without a custom colour), skipping `skip`
/// and the projects that have no valid colour yet.
fn project_colors_used(ws: &Workspace, skip: Option<usize>) -> Vec<u8> {
    ws.projects
        .iter()
        .enumerate()
        .filter(|(i, p)| Some(*i) != skip && p.custom_color.is_none() && p.color < PALETTE_SIZE)
        .map(|(_, p)| p.color)
        .collect()
}

/// Palette indexes shown by the repos of the workspace outside `skip_project` (each repo id once;
/// a repo with a custom colour shows none).
fn repo_colors_used(ws: &Workspace, skip_project: Option<&str>) -> Vec<u8> {
    let mut seen = std::collections::HashSet::new();
    ws.projects
        .iter()
        .filter(|p| Some(p.id.as_str()) != skip_project)
        .flat_map(|p| p.repos.iter())
        .filter(|r| seen.insert(r.id.clone()))
        .filter(|r| r.custom_color.is_none())
        .map(|r| r.color)
        .collect()
}

/// Colours the repos of `project` for the workspace `ws`: a repo the workspace already knows (in
/// any project, matched by id) keeps its colour and custom colour; a new repo gets the least-used
/// palette colour. `replacing` is the id of the project that `project` replaces (a rescan), whose
/// old repos do not count as used.
fn colorize_repos(ws: &Workspace, replacing: Option<&str>, project: &mut Project) {
    let known: std::collections::HashMap<&str, &RepoInfo> = ws
        .projects
        .iter()
        .flat_map(|p| p.repos.iter())
        .map(|r| (r.id.as_str(), r))
        .collect();
    let mut used = repo_colors_used(ws, replacing);
    // every repo id counts once: the repos of the other projects are in `used` already
    let mut counted: std::collections::HashSet<String> = ws
        .projects
        .iter()
        .filter(|p| Some(p.id.as_str()) != replacing)
        .flat_map(|p| p.repos.iter())
        .map(|r| r.id.clone())
        .collect();
    // known repos first, so a new repo never takes a colour a later known repo of this project keeps
    for r in &mut project.repos {
        if let Some(old) = known.get(r.id.as_str()) {
            r.color = old.color;
            r.custom_color = old.custom_color.clone();
            if r.custom_color.is_none() && counted.insert(r.id.clone()) {
                used.push(r.color);
            }
        }
    }
    for r in &mut project.repos {
        if !known.contains_key(r.id.as_str()) {
            r.color = next_color(used.iter().copied());
            used.push(r.color);
        }
    }
}

/// Adds `project`, or returns the existing one with the same path. The first project becomes active.
/// The project and its repos get colours (see `colorize_repos`).
pub fn add_project(ws: &mut Workspace, mut project: Project) -> Project {
    if let Some(existing) = ws.projects.iter().find(|p| p.path == project.path) {
        return existing.clone();
    }
    colorize_repos(ws, None, &mut project);
    project.color = next_color(project_colors_used(ws, None));
    project.custom_color = None;
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

/// Replaces the repos of project `id` with those of `fresh` (a rescan). Id, name, path and colour
/// of the project stay. A repo that is still there (same id) keeps its colour and custom colour;
/// a new repo gets the least-used palette colour.
pub fn replace_repos(ws: &mut Workspace, id: &str, mut fresh: Project) -> Option<Project> {
    ws.projects.iter().position(|p| p.id == id)?;
    colorize_repos(ws, Some(id), &mut fresh);
    let p = ws.projects.iter_mut().find(|p| p.id == id)?;
    p.repos = fresh.repos;
    Some(p.clone())
}

/// Applies a colour choice to a colour pair: Auto takes `auto`, a palette colour clears the custom
/// colour, a custom colour keeps the palette index.
fn apply_choice(color: &mut u8, custom: &mut Option<String>, choice: &ColorChoice, auto: u8) {
    match choice {
        ColorChoice::Auto => {
            *color = auto;
            *custom = None;
        }
        ColorChoice::Palette(i) => {
            *color = *i;
            *custom = None;
        }
        ColorChoice::Custom(hex) => *custom = Some(hex.clone()),
    }
}

/// Sets the colour of repo `repo_id` in every project that holds it (one repo, one colour). Auto
/// picks the least-used colour among the other repos. `None` for an unknown id.
pub fn set_repo_color(ws: &mut Workspace, repo_id: &str, choice: &ColorChoice) -> Option<RepoInfo> {
    ws.projects
        .iter()
        .flat_map(|p| p.repos.iter())
        .find(|r| r.id == repo_id)?;
    let mut others = std::collections::HashSet::new();
    let used: Vec<u8> = ws
        .projects
        .iter()
        .flat_map(|p| p.repos.iter())
        .filter(|r| r.id != repo_id && r.custom_color.is_none())
        .filter(|r| others.insert(r.id.clone()))
        .map(|r| r.color)
        .collect();
    let auto = next_color(used);
    let mut updated = None;
    for r in ws
        .projects
        .iter_mut()
        .flat_map(|p| p.repos.iter_mut())
        .filter(|r| r.id == repo_id)
    {
        apply_choice(&mut r.color, &mut r.custom_color, choice, auto);
        updated = Some(r.clone());
    }
    updated
}

/// Sets the colour of project `project_id`. Auto picks the least-used colour among the other
/// projects. `None` for an unknown id.
pub fn set_project_color(
    ws: &mut Workspace,
    project_id: &str,
    choice: &ColorChoice,
) -> Option<Project> {
    let pos = ws.projects.iter().position(|p| p.id == project_id)?;
    let auto = next_color(project_colors_used(ws, Some(pos)));
    let p = &mut ws.projects[pos];
    apply_choice(&mut p.color, &mut p.custom_color, choice, auto);
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
            color: 0,
            custom_color: None,
        }
    }

    fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            name: id.into(),
            path: format!("/w/{id}"),
            repos: vec![repo(id)],
            color: 0,
            custom_color: None,
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

    // ------------------------------------------------------------ colours

    fn project_with(id: &str, repo_ids: &[&str]) -> Project {
        Project {
            repos: repo_ids.iter().map(|r| repo(r)).collect(),
            ..project(id)
        }
    }

    fn colors_of(p: &Project) -> Vec<u8> {
        p.repos.iter().map(|r| r.color).collect()
    }

    fn find<'a>(ws: &'a Workspace, repo_id: &str) -> &'a RepoInfo {
        ws.projects
            .iter()
            .flat_map(|p| p.repos.iter())
            .find(|r| r.id == repo_id)
            .unwrap()
    }

    #[test]
    fn new_repos_use_all_twelve_colors_before_repeating() {
        let mut ws = Workspace::default();
        let ids: Vec<String> = (0..14).map(|i| format!("r{i}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let added = add_project(&mut ws, project_with("a", &refs));
        assert_eq!(
            colors_of(&added),
            vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1]
        );
    }

    #[test]
    fn a_second_project_continues_with_the_least_used_colors() {
        let mut ws = Workspace::default();
        let a = add_project(&mut ws, project_with("a", &["a1", "a2", "a3"]));
        assert_eq!(colors_of(&a), vec![0, 1, 2]);
        let b = add_project(&mut ws, project_with("b", &["b1", "b2"]));
        assert_eq!(colors_of(&b), vec![3, 4]);
        // the projects themselves are spread out too
        assert_eq!((a.color, b.color), (0, 1));
    }

    #[test]
    fn a_repo_shared_by_two_projects_keeps_one_color() {
        let mut ws = Workspace::default();
        add_project(&mut ws, project_with("a", &["x", "a1"]));
        set_repo_color(&mut ws, "x", &ColorChoice::Custom("#112233".into())).unwrap();
        let b = add_project(&mut ws, project_with("b", &["b1", "x"]));
        assert_eq!(b.repos[1].custom_color.as_deref(), Some("#112233"));
        assert_eq!(b.repos[1].color, find(&ws, "x").color);
        // x shows a custom colour, so only a1 (colour 1) counts: b1 takes colour 0
        assert_eq!(b.repos[0].color, 0);
    }

    /// The same scenario is in `src/api/mockColors.test.ts` ("counts a shared repo once"): both
    /// sides must give exactly these colours.
    #[test]
    fn a_shared_repo_counts_once_when_the_next_color_is_chosen() {
        let mut ws = Workspace::default();
        // a project with 12 repos uses every palette colour once; x has colour 0
        let ids: Vec<String> = std::iter::once("x".to_string())
            .chain((1..12).map(|i| format!("a{i}")))
            .collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let a = add_project(&mut ws, project_with("a", &refs));
        assert_eq!(colors_of(&a), (0..12).collect::<Vec<u8>>());
        // b holds x too: the 12 colours are each used once, so b1 takes 0, then b2 takes 1
        // (counting x twice would give 1 and 2)
        let b = add_project(&mut ws, project_with("b", &["x", "b1", "b2"]));
        assert_eq!(colors_of(&b), vec![0, 0, 1]);

        // a rescan of b that keeps only x and adds b3: x is counted once, so b3 takes 0
        let rescanned = replace_repos(&mut ws, "b", project_with("b", &["x", "b3"])).unwrap();
        assert_eq!(colors_of(&rescanned), vec![0, 0]);
    }

    #[test]
    fn rescan_keeps_colors_and_overrides_by_repo_id() {
        let mut ws = Workspace::default();
        add_project(&mut ws, project_with("p", &["r1", "r2", "r3"]));
        set_repo_color(&mut ws, "r2", &ColorChoice::Palette(9)).unwrap();
        set_repo_color(&mut ws, "r3", &ColorChoice::Custom("#AABBCC".into())).unwrap();
        let before: Vec<RepoInfo> = ws.projects[0].repos.clone();
        let project_color = ws.projects[0].color;

        // the rescan finds the repos in another order, with a new one in front
        let fresh = project_with("p", &["new", "r3", "r1", "r2"]);
        let got = replace_repos(&mut ws, "p", fresh).unwrap();
        let by_id = |id: &str| got.repos.iter().find(|r| r.id == id).unwrap().clone();
        for old in &before {
            assert_eq!(by_id(&old.id).color, old.color, "{}", old.id);
            assert_eq!(by_id(&old.id).custom_color, old.custom_color, "{}", old.id);
        }
        assert_eq!(by_id("r2").color, 9);
        assert_eq!(by_id("r3").custom_color.as_deref(), Some("#AABBCC"));
        // r1 shows 0 and r2 shows 9 (r3 shows its custom colour): the new repo takes 1
        assert_eq!(by_id("new").color, 1);
        // the project keeps its colour
        assert_eq!(got.color, project_color);
    }

    #[test]
    fn rescanning_again_changes_nothing() {
        let mut ws = Workspace::default();
        add_project(&mut ws, project_with("p", &["r1", "r2", "r3", "r4"]));
        let once =
            replace_repos(&mut ws, "p", project_with("p", &["r4", "r2", "r1", "r3"])).unwrap();
        let twice =
            replace_repos(&mut ws, "p", project_with("p", &["r1", "r2", "r3", "r4"])).unwrap();
        let sorted = |p: &Project| {
            let mut v: Vec<(String, u8)> =
                p.repos.iter().map(|r| (r.id.clone(), r.color)).collect();
            v.sort();
            v
        };
        assert_eq!(sorted(&once), sorted(&twice));
        assert_eq!(
            sorted(&once),
            vec![
                ("r1".into(), 0),
                ("r2".into(), 1),
                ("r3".into(), 2),
                ("r4".into(), 3)
            ]
        );
    }

    #[test]
    fn a_removed_repo_frees_its_color() {
        let mut ws = Workspace::default();
        add_project(&mut ws, project_with("p", &["r1", "r2", "r3"]));
        // r2 (colour 1) is gone after the rescan; the new repo takes the free colour 1
        let got = replace_repos(&mut ws, "p", project_with("p", &["r1", "r3", "n"])).unwrap();
        assert_eq!(got.repos.iter().find(|r| r.id == "n").unwrap().color, 1);
    }

    #[test]
    fn set_repo_color_palette_custom_and_auto() {
        let mut ws = Workspace::default();
        add_project(&mut ws, project_with("p", &["r1", "r2", "r3"]));

        let r = set_repo_color(&mut ws, "r1", &ColorChoice::Palette(7)).unwrap();
        assert_eq!((r.color, r.custom_color.clone()), (7, None));

        // a custom colour keeps the palette index
        let r = set_repo_color(&mut ws, "r1", &ColorChoice::Custom("#0A0B0C".into())).unwrap();
        assert_eq!((r.color, r.custom_color.as_deref()), (7, Some("#0A0B0C")));
        // a palette choice clears the custom colour
        let r = set_repo_color(&mut ws, "r1", &ColorChoice::Palette(4)).unwrap();
        assert_eq!((r.color, r.custom_color), (4, None));

        // Auto: r2 shows 1 and r3 shows 2, so the least used index for r1 is 0
        let r = set_repo_color(&mut ws, "r1", &ColorChoice::Auto).unwrap();
        assert_eq!((r.color, r.custom_color), (0, None));
        assert_eq!(find(&ws, "r1").color, 0);

        assert!(set_repo_color(&mut ws, "nope", &ColorChoice::Auto).is_none());
    }

    #[test]
    fn set_repo_color_updates_every_project_that_holds_the_repo() {
        let mut ws = Workspace::default();
        add_project(&mut ws, project_with("a", &["x"]));
        add_project(&mut ws, project_with("b", &["x"]));
        set_repo_color(&mut ws, "x", &ColorChoice::Palette(6)).unwrap();
        assert!(ws.projects.iter().all(|p| p.repos[0].color == 6));
    }

    #[test]
    fn project_colors_are_assigned_and_can_be_changed() {
        let mut ws = Workspace::default();
        for id in ["a", "b", "c"] {
            add_project(&mut ws, project(id));
        }
        let colors = |ws: &Workspace| ws.projects.iter().map(|p| p.color).collect::<Vec<_>>();
        assert_eq!(colors(&ws), vec![0, 1, 2]);
        let p = set_project_color(&mut ws, "b", &ColorChoice::Custom("#FF00FF".into())).unwrap();
        assert_eq!(p.custom_color.as_deref(), Some("#FF00FF"));
        // b no longer shows palette colour 1, so the next project takes it
        add_project(&mut ws, project("d"));
        assert_eq!(ws.projects[3].color, 1);
        let p = set_project_color(&mut ws, "a", &ColorChoice::Palette(10)).unwrap();
        assert_eq!(p.color, 10);
        assert!(set_project_color(&mut ws, "zzz", &ColorChoice::Auto).is_none());
    }

    #[test]
    fn old_workspace_files_load_and_get_colors() {
        // written before custom colours and project colours existed
        let old = r#"{
            "projects": [
                {"id": "a", "name": "a", "path": "/w/a", "repos": [
                    {"id": "r1", "name": "r1", "path": "/w/a/r1", "color": 5}]},
                {"id": "b", "name": "b", "path": "/w/b", "repos": []}
            ],
            "activeProjectId": "a",
            "ui": {}
        }"#;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, old).unwrap();
        let ws = load(&path);
        assert_eq!(ws.projects.len(), 2);
        // the repo keeps its colour, and no custom colour appears
        assert_eq!(ws.projects[0].repos[0].color, 5);
        assert_eq!(ws.projects[0].repos[0].custom_color, None);
        // projects without a colour get distinct ones
        assert_eq!((ws.projects[0].color, ws.projects[1].color), (0, 1));
        assert!(ws.projects.iter().all(|p| p.custom_color.is_none()));
    }

    #[test]
    fn colors_survive_a_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let mut ws = Workspace::default();
        add_project(&mut ws, project_with("a", &["r1", "r2"]));
        set_repo_color(&mut ws, "r1", &ColorChoice::Custom("#00FF99".into())).unwrap();
        set_repo_color(&mut ws, "r2", &ColorChoice::Palette(8)).unwrap();
        set_project_color(&mut ws, "a", &ColorChoice::Palette(3)).unwrap();
        save(&path, &ws).unwrap();
        let back = load(&path);
        assert_eq!(back.projects, ws.projects);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"customColor\": \"#00FF99\""), "{text}");
    }
}
