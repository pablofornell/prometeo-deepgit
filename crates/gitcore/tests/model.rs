use gitcore::{ApiError, DiffSpec, GitError, LogQuery, RepoStateKind};

#[test]
fn json_shapes_are_camel_case_and_tagged() {
    let v = serde_json::to_value(DiffSpec::Commit {
        oid: "abc".into(),
        parent: None,
    })
    .unwrap();
    assert_eq!(
        v,
        serde_json::json!({"kind": "commit", "oid": "abc", "parent": null})
    );
    assert_eq!(
        serde_json::to_value(DiffSpec::Staged).unwrap(),
        serde_json::json!({"kind": "staged"})
    );
    let spec: DiffSpec = serde_json::from_str(r#"{"kind":"unstaged"}"#).unwrap();
    assert_eq!(spec, DiffSpec::Unstaged);
    assert_eq!(
        serde_json::to_value(RepoStateKind::CherryPicking).unwrap(),
        serde_json::json!("cherryPicking")
    );
}

#[test]
fn log_query_defaults_missing_fields() {
    let q: LogQuery = serde_json::from_str(r#"{"repoIds":["a"]}"#).unwrap();
    assert_eq!(q.repo_ids, vec!["a"]);
    assert_eq!(q.max_count, 50_000);
    assert!(q.refs.is_empty());
}

#[test]
fn git_error_converts_to_api_error() {
    let e = GitError::Command {
        args: vec!["merge".into(), "x".into()],
        code: 1,
        stderr: "fatal: bad thing\nmore".into(),
    };
    let api: ApiError = e.into();
    assert_eq!(api.message, "fatal: bad thing");
    assert_eq!(api.detail.as_deref(), Some("fatal: bad thing\nmore"));
    let api: ApiError = GitError::Parse("p".into()).into();
    assert!(api.message.contains('p') && api.detail.is_none());
}
