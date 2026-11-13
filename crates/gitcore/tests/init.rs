//! `git init` for a folder without a repository (`gitcore::init`).

mod common;

use common::*;
use gitcore::{init, ApiError, GitError, ERR_NO_REPOSITORY};

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

    let info = init::init_info(&git(), &inner);
    assert_eq!(info.name, "docs");
    assert_eq!(info.path, inner.to_string_lossy());
    let parent = info.parent_repo.expect("the folder is inside a repository");
    assert_eq!(
        gitcore::paths::canonicalize(std::path::Path::new(&parent)).unwrap(),
        root_canon
    );

    // a folder in a temp dir has no parent repository
    let plain_canon = gitcore::paths::canonicalize(plain.path()).unwrap();
    assert_eq!(init::init_info(&git(), &plain_canon).parent_repo, None);
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
    assert_eq!(init::init_info(&git(), dir.path()).default_branch, "trunk");

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
