mod common;

use common::*;
use gitcore::discover;

#[test]
fn finds_nested_repos_and_skips_ignored_dirs() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    init_at(r);
    for sub in [
        "apps/web",
        "libs/core",
        "node_modules/pkg",
        "target/x",
        ".hidden/y",
    ] {
        std::fs::create_dir_all(r.join(sub)).unwrap();
        init_at(&r.join(sub));
    }
    // A `.git` file (worktree/submodule style) also marks a repo.
    std::fs::create_dir_all(r.join("sub/mod")).unwrap();
    std::fs::write(r.join("sub/mod/.git"), "gitdir: ../../.git/modules/mod\n").unwrap();
    // Too deep.
    std::fs::create_dir_all(r.join("a/b/c/d/e")).unwrap();
    init_at(&r.join("a/b/c/d/e"));

    let found = discover::find_repos(r, 4);
    let rels: Vec<String> = found
        .iter()
        .map(|p| slashed(&p.strip_prefix(r).unwrap().to_string_lossy()))
        .collect();
    assert_eq!(rels, vec!["", "apps/web", "libs/core", "sub/mod"]);
}

#[test]
fn make_project_assigns_names_ids_and_colors() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    init_at(r);
    for i in 0..9 {
        let sub = r.join(format!("pkg{i}"));
        std::fs::create_dir_all(&sub).unwrap();
        init_at(&sub);
    }
    let project = discover::make_project(r);
    assert_eq!(project.repos.len(), 10);
    let root_name = gitcore::paths::canonicalize(r)
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(project.repos[0].name, root_name);
    assert_eq!(project.repos[1].name, "pkg0");
    assert_eq!(project.repos[9].name, "pkg8");
    let colors: Vec<u8> = project.repos.iter().map(|r| r.color).collect();
    // all 12 palette colours are used before one repeats
    assert_eq!(colors, vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert_eq!(project.repos[0].id.len(), 12);
    assert!(project.repos[0].id.chars().all(|c| c.is_ascii_hexdigit()));
    // Ids are stable and unique.
    let again = discover::make_project(r);
    assert_eq!(project.repos[3].id, again.repos[3].id);
    let mut ids: Vec<&String> = project.repos.iter().map(|r| &r.id).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 10);
}

#[test]
fn non_repo_root_without_children_is_empty() {
    let root = tempfile::tempdir().unwrap();
    assert!(discover::find_repos(root.path(), 4).is_empty());
    assert!(discover::make_project(root.path()).repos.is_empty());
}

#[test]
fn not_found_reason_agrees_with_what_a_scan_finds() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let cases = [
        "apps/web",
        "a/b/c/d",
        "a/b/c/d/e",
        "node_modules/pkg",
        "target/x",
        "dist/x",
        "build/x",
        ".venv/x",
        ".hidden/y",
        "ok/.dotrepo",
        "ok/node_modules/deep",
        "deep/er/est/x",
    ];
    for sub in cases {
        std::fs::create_dir_all(r.join(sub)).unwrap();
        init_at(&r.join(sub));
    }
    let found = discover::find_repos(r, discover::MAX_DEPTH);
    for sub in cases {
        let path = r.join(sub);
        let reason = discover::not_found_reason(r, &path);
        assert_eq!(
            reason.is_none(),
            found.contains(&path),
            "{sub}: reason {reason:?}"
        );
    }
    let reason = |sub: &str| discover::not_found_reason(r, &r.join(sub)).unwrap();
    assert!(reason("a/b/c/d/e").contains("4 levels deep"));
    assert!(reason("a/b/c/d/e").contains("5 levels below"));
    assert!(reason("node_modules/pkg").contains("\"node_modules\""));
    assert!(reason("ok/.dotrepo").contains("\".dotrepo\""));
    // the project folder itself, and paths outside it, are not a problem of the scan
    assert_eq!(discover::not_found_reason(r, r), None);
    assert_eq!(
        discover::not_found_reason(r, std::path::Path::new("/elsewhere/x")),
        None
    );
}
