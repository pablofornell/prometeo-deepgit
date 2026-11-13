//! `git init` for a folder without a repository (`gitcore::init`).

mod common;

use common::*;
use gitcore::{
    init, ApiError, GitError, ERR_BARE_REPOSITORY, ERR_DEEP_REPOSITORY, ERR_INSIDE_GIT_DIR,
    ERR_NO_REPOSITORY,
};

fn head_branch(dir: &std::path::Path) -> String {
    sh(dir, &["symbolic-ref", "--short", "HEAD"], None)
}

#[test]
fn init_creates_a_repository_on_the_chosen_branch() {
    let dir = tempfile::tempdir().unwrap();
    init::init_repository(&git(), dir.path(), "  trunk ").unwrap();
    assert!(dir.path().join(".git").is_dir());
    assert_eq!(head_branch(dir.path()), "trunk");
    // an empty repository: no commits yet
    let out = git()
        .run_unchecked(
            dir.path(),
            None,
            &["rev-parse", "--verify", "HEAD"],
            false,
            None,
        )
        .unwrap();
    assert_ne!(out.code, 0);
}

#[test]
fn init_refuses_bad_branch_names_without_creating_anything() {
    let dir = tempfile::tempdir().unwrap();
    for bad in [
        "",
        "   ",
        "-x",
        "--help",
        "a b",
        "a..b",
        "x\ny",
        "bad~name",
        "ends.lock",
        "@",
        "HEAD",
        "@{-1}",
    ] {
        let err = init::init_repository(&git(), dir.path(), bad)
            .expect_err(&format!("{bad:?} was accepted"));
        assert!(matches!(err, GitError::Invalid(_)), "{bad:?}: {err:?}");
        assert!(!dir.path().join(".git").exists(), "{bad:?} created .git");
    }
    let err: ApiError = init::init_repository(&git(), dir.path(), "a b")
        .unwrap_err()
        .into();
    assert_eq!(err.message, "This is not a valid branch name.");
}

#[test]
fn init_refuses_a_repository_and_a_missing_folder() {
    let dir = tempfile::tempdir().unwrap();
    init_at(dir.path());
    let err = init::init_repository(&git(), dir.path(), "main").unwrap_err();
    assert!(err.to_string().contains("already"), "{err}");
    let err = init::init_repository(&git(), &dir.path().join("nope"), "main").unwrap_err();
    assert!(err.to_string().contains("not a folder"), "{err}");
}

#[test]
fn init_info_says_when_the_folder_is_inside_a_repository() {
    let root = tempfile::tempdir().unwrap();
    let plain = tempfile::tempdir().unwrap();
    init_at(root.path());
    let inner = root.path().join("docs");
    std::fs::create_dir_all(&inner).unwrap();
    let inner = gitcore::paths::canonicalize(&inner).unwrap();
    let root_canon = gitcore::paths::canonicalize(root.path()).unwrap();

    let info = init::init_info(&git(), &inner).unwrap();
    assert_eq!(info.name, "docs");
    assert_eq!(info.path, inner.to_string_lossy());
    let parent = info.parent_repo.expect("the folder is inside a repository");
    assert_eq!(
        gitcore::paths::canonicalize(std::path::Path::new(&parent)).unwrap(),
        root_canon
    );

    // a folder in a temp dir has no parent repository
    let plain_canon = gitcore::paths::canonicalize(plain.path()).unwrap();
    assert_eq!(
        init::init_info(&git(), &plain_canon).unwrap().parent_repo,
        None
    );
}

#[test]
fn the_default_branch_follows_the_global_config_and_falls_back_to_main() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("gitconfig");
    // `git config --global` reads this file. This is the only test of the binary that changes the
    // environment, and the other tests do not read the global config.
    std::env::set_var("GIT_CONFIG_GLOBAL", &config);

    std::fs::write(&config, "").unwrap();
    assert_eq!(init::default_branch(&git(), dir.path()), "main");

    std::fs::write(&config, "[init]\n\tdefaultBranch = trunk\n").unwrap();
    assert_eq!(init::default_branch(&git(), dir.path()), "trunk");
    assert_eq!(
        init::init_info(&git(), dir.path()).unwrap().default_branch,
        "trunk"
    );

    std::fs::write(&config, "[init]\n\tdefaultBranch =\n").unwrap();
    assert_eq!(init::default_branch(&git(), dir.path()), "main");

    std::env::remove_var("GIT_CONFIG_GLOBAL");
}

#[test]
fn the_no_repository_error_carries_a_code_that_serializes_as_camel_case() {
    let err = ApiError {
        message: "No Git repository found in /x".into(),
        detail: None,
        code: Some(ERR_NO_REPOSITORY.into()),
    };
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["code"], "noRepository");
    // other errors have no `code` key at all
    let plain: ApiError = GitError::Invalid("x".into()).into();
    let json = serde_json::to_value(&plain).unwrap();
    assert!(json.get("code").is_none(), "{json}");
}

/// The code and message of the `ApiError` that a refused init gives.
fn refused(err: GitError) -> (String, String) {
    let api: ApiError = err.into();
    (api.code.expect("a code"), api.message)
}

#[test]
fn a_bare_repository_and_a_git_folder_are_not_initialized() {
    let root = tempfile::tempdir().unwrap();
    let bare = root.path().join("foo.git");
    std::fs::create_dir_all(&bare).unwrap();
    sh(&bare, &["init", "-q", "--bare"], None);

    let err = init::init_repository(&git(), &bare, "main").unwrap_err();
    assert_eq!(
        refused(err),
        (
            ERR_BARE_REPOSITORY.to_string(),
            "This folder is a bare Git repository. DeepGit needs a working folder.".to_string()
        )
    );
    assert!(!bare.join(".git").exists());
    // the dialog is not offered either
    let err = init::init_info(&git(), &bare).unwrap_err();
    assert_eq!(refused(err).0, ERR_BARE_REPOSITORY);

    // the data folder of a working repository, and a folder inside it
    let work = root.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    init_at(&work);
    for dir in [work.join(".git"), work.join(".git/refs")] {
        let err = init::init_repository(&git(), &dir, "main").unwrap_err();
        assert_eq!(refused(err).0, ERR_INSIDE_GIT_DIR, "{}", dir.display());
        assert!(!dir.join(".git").exists());
    }
}

#[test]
fn a_branch_with_an_at_brace_is_refused_and_leaves_no_git_folder() {
    // inside a repository, where `@{-1}` could pass `git check-ref-format --branch`
    let parent = tempfile::tempdir().unwrap();
    init_at(parent.path());
    let dir = parent.path().join("sub");
    std::fs::create_dir_all(&dir).unwrap();
    for bad in ["@{-1}", "@{u}", "a@{b}", "x@{1}"] {
        let err = init::init_repository(&git(), &dir, bad).unwrap_err();
        assert_eq!(err.to_string(), "This is not a valid branch name.", "{bad}");
        assert!(!dir.join(".git").exists(), "{bad:?} created .git");
    }
}

#[test]
fn a_repository_deeper_than_the_scan_looks_is_not_wrapped() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("deep");
    // 5 levels: one more than `MAX_DEPTH`
    let repo = dir.join("a/b/c/d/e");
    std::fs::create_dir_all(&repo).unwrap();
    init_at(&repo);
    assert!(gitcore::discover::find_repos(&dir, gitcore::discover::MAX_DEPTH).is_empty());

    let err = init::init_repository(&git(), &dir, "main").unwrap_err();
    let (code, message) = refused(err);
    assert_eq!(code, ERR_DEEP_REPOSITORY);
    assert_eq!(
        message,
        "This folder has Git repositories deeper than DeepGit looks (5 levels). Add the folder that holds them."
    );
    assert!(!dir.join(".git").exists());
    assert_eq!(
        refused(init::init_info(&git(), &dir).unwrap_err()).0,
        ERR_DEEP_REPOSITORY
    );

    // a repository below a folder the scan skips counts too
    let hidden = root.path().join("hidden");
    std::fs::create_dir_all(hidden.join(".cache/x")).unwrap();
    init_at(&hidden.join(".cache/x"));
    assert_eq!(
        refused(init::init_repository(&git(), &hidden, "main").unwrap_err()).0,
        ERR_DEEP_REPOSITORY
    );

    // `node_modules` is not searched, so this folder is initialized
    let clean = root.path().join("clean");
    std::fs::create_dir_all(clean.join("node_modules/pkg")).unwrap();
    init_at(&clean.join("node_modules/pkg"));
    init::init_repository(&git(), &clean, "main").unwrap();
    assert!(clean.join(".git").is_dir());
}

#[test]
fn the_deep_probe_is_bounded() {
    use gitcore::discover::{find_deep_repo, PROBE_DEPTH};
    let root = tempfile::tempdir().unwrap();
    // the repository folder is `PROBE_DEPTH + 1` levels down: not found
    let mut too_deep = root.path().join("a");
    for i in 0..=PROBE_DEPTH {
        too_deep.push(format!("d{i}"));
    }
    std::fs::create_dir_all(&too_deep).unwrap();
    init_at(&too_deep);
    assert_eq!(find_deep_repo(&root.path().join("a")), None);
    // `PROBE_DEPTH` levels down: found, with its depth
    let top = root.path().join("b");
    let mut at_limit = top.clone();
    for i in 0..PROBE_DEPTH {
        at_limit.push(format!("d{i}"));
    }
    std::fs::create_dir_all(&at_limit).unwrap();
    init_at(&at_limit);
    assert_eq!(find_deep_repo(&top), Some(PROBE_DEPTH));
}
