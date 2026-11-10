mod common;

use common::*;
use gitcore::{log, LogQuery, RefKind};

/// git only parses `--since=@N` for realistic timestamps.
const T0: i64 = 1_700_000_000;

fn query(ids: &[&str]) -> LogQuery {
    LogQuery {
        repo_ids: ids.iter().map(|s| s.to_string()).collect(),
        ..LogQuery::default()
    }
}

#[test]
fn empty_repo_has_zero_rows() {
    let r = TestRepo::new();
    let (rows, lanes, truncated, _) =
        log::load(&git(), std::slice::from_ref(&r.info), &query(&["r1"])).unwrap();
    assert!(rows.is_empty());
    assert_eq!(lanes, 0);
    assert!(!truncated);
}

#[test]
fn merge_produces_two_lanes_and_a_merge_segment() {
    let r = TestRepo::new();
    let a = r.commit_file_at("a.txt", "a\n", "A", Some(1_000));
    r.sh(&["checkout", "-q", "-b", "feature"]);
    let c = sh(
        r.path(),
        &["commit", "-q", "--allow-empty", "-m", "C"],
        Some(1_100),
    );
    let _ = c;
    let c = r.head();
    r.sh(&["checkout", "-q", "main"]);
    let b = r.commit_file_at("b.txt", "b\n", "B", Some(1_200));
    sh(
        r.path(),
        &["merge", "--no-ff", "-q", "-m", "M", "feature"],
        Some(1_300),
    );
    let m = r.head();

    let (rows, lanes, truncated, _) =
        log::load(&git(), std::slice::from_ref(&r.info), &query(&["r1"])).unwrap();
    assert!(!truncated);
    assert_eq!(lanes, 2);
    let oids: Vec<&str> = rows.iter().map(|r| r.oid.as_str()).collect();
    assert_eq!(oids[0], m);
    assert_eq!(oids.len(), 4);
    assert_eq!(rows[0].parents, vec![b.clone(), c.clone()]);
    assert_eq!(rows[0].subject, "M");
    assert_eq!(rows[0].graph.node, 0);
    // Merge row: lane 0 continues, a second segment goes to lane 1.
    let bottoms: Vec<u16> = rows[0]
        .graph
        .segments
        .iter()
        .filter(|s| s.y1 == 1 && s.y2 == 2)
        .map(|s| s.x2)
        .collect();
    assert_eq!(bottoms, vec![0, 1]);
    assert_eq!(rows[0].graph.width, 2);
    // The feature commit lives in lane 1; the root A closes both lanes.
    let c_row = rows.iter().find(|r| r.oid == c).unwrap();
    assert_eq!(c_row.graph.node, 1);
    let a_row = rows.iter().find(|r| r.oid == a).unwrap();
    assert_eq!(a_row.graph.node, 0);

    // Ref labels: main is current and sits on M together with nothing else; feature on C.
    let main = rows[0].refs.iter().find(|l| l.name == "main").unwrap();
    assert_eq!(main.kind, RefKind::Local);
    assert!(main.is_current);
    assert!(c_row
        .refs
        .iter()
        .any(|l| l.name == "feature" && !l.is_current));
}

#[test]
fn branch_colors_are_stable_across_reloads() {
    let r = TestRepo::new();
    r.commit_file_at("a.txt", "a\n", "A", Some(1_000));
    r.sh(&["checkout", "-q", "-b", "feature"]);
    sh(
        r.path(),
        &["commit", "-q", "--allow-empty", "-m", "C"],
        Some(1_100),
    );
    r.sh(&["checkout", "-q", "main"]);
    r.commit_file_at("b.txt", "b\n", "B", Some(1_200));
    let g = git();
    let first = log::load(&g, std::slice::from_ref(&r.info), &query(&[]))
        .unwrap()
        .0;
    let second = log::load(&g, std::slice::from_ref(&r.info), &query(&[]))
        .unwrap()
        .0;
    let colors =
        |rows: &[gitcore::CommitRow]| rows.iter().map(|r| r.graph.color).collect::<Vec<_>>();
    assert_eq!(colors(&first), colors(&second));
    // Tips carry hashed colours, below 1024.
    assert_eq!(first[0].graph.color, gitcore::graph::stable_color("main"));
}

#[test]
fn multi_repo_merge_orders_by_committer_time_and_keeps_repo_order() {
    let r1 = TestRepo::named("r1");
    let r2 = TestRepo::named("r2");
    r1.commit_file_at("a", "1", "r1-a", Some(100));
    r2.commit_file_at("a", "1", "r2-a", Some(150));
    r1.commit_file_at("b", "2", "r1-b", Some(200));
    r2.commit_file_at("b", "2", "r2-b", Some(250));
    r2.commit_file_at("c", "3", "r2-c", Some(260));
    r1.commit_file_at("c", "3", "r1-c", Some(300));
    let repos = vec![r1.info.clone(), r2.info.clone()];
    let (rows, lanes, _, _) = log::load(&git(), &repos, &query(&["r1", "r2"])).unwrap();
    let subjects: Vec<&str> = rows.iter().map(|r| r.subject.as_str()).collect();
    assert_eq!(
        subjects,
        vec!["r1-c", "r2-c", "r2-b", "r1-b", "r2-a", "r1-a"]
    );
    assert_eq!(rows[0].repo_id, "r1");
    assert_eq!(rows[1].repo_id, "r2");
    // Repos never share lanes.
    assert_eq!(lanes, 2);
    assert_ne!(rows[0].graph.node, rows[1].graph.node);

    // repo_ids restricts the set.
    let (rows, lanes, _, _) = log::load(&git(), &repos, &query(&["r2"])).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(lanes, 1);
}

#[test]
fn a_broken_repo_is_skipped_and_reported() {
    let r1 = TestRepo::named("r1");
    let r2 = TestRepo::named("r2");
    r1.commit_file_at("a", "1", "r1-a", Some(100));
    r2.commit_file_at("a", "1", "r2-a", Some(150));
    let repos = vec![r1.info.clone(), r2.info.clone()];
    std::fs::remove_dir_all(r2.path()).unwrap();

    let (rows, _, _, skipped) = log::load(&git(), &repos, &query(&["r1", "r2"])).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].repo_id, "r1");
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0].repo_id, "r2");
    assert!(!skipped[0].message.is_empty());

    // Every repo failing is an error.
    std::fs::remove_dir_all(r1.path()).unwrap();
    assert!(log::load(&git(), &repos, &query(&["r1", "r2"])).is_err());
}

#[test]
fn filters_text_author_path_and_max_count() {
    let r = TestRepo::new();
    let a = r.commit_file_at("a.txt", "a\n", "alpha thing", Some(T0 + 1_000));
    r.commit_file_at("dir/b.txt", "b\n", "beta (stuff)", Some(T0 + 2_000));
    r.commit_file_at("a.txt", "a2\n", "gamma", Some(T0 + 3_000));
    let g = git();
    let repos = [r.info.clone()];

    let mut q = query(&["r1"]);
    q.text = Some("ALPHA".into());
    let (rows, _, _, _) = log::load(&g, &repos, &q).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].subject, "alpha thing");
    // Filtered rows must not leave dangling lanes.
    assert_eq!(rows[0].graph.width, 1);

    // Regex characters are literal.
    q.text = Some("(stuff)".into());
    assert_eq!(log::load(&g, &repos, &q).unwrap().0.len(), 1);

    q.text = None;
    q.path = Some("dir".into());
    let (rows, _, _, _) = log::load(&g, &repos, &q).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].subject, "beta (stuff)");

    q.path = None;
    q.author = Some("nobody".into());
    assert!(log::load(&g, &repos, &q).unwrap().0.is_empty());
    q.author = Some("test@example".into());
    assert_eq!(log::load(&g, &repos, &q).unwrap().0.len(), 3);

    q.author = None;
    q.since = Some(T0 + 1_500);
    q.until = Some(T0 + 2_500);
    let (rows, _, _, _) = log::load(&g, &repos, &q).unwrap();
    assert_eq!(rows.len(), 1);

    q.since = None;
    q.until = None;
    q.max_count = 2;
    let (rows, _, truncated, _) = log::load(&g, &repos, &q).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(truncated);
    // The cut parent does not leave a dangling lane.
    assert_eq!(
        rows[1].graph.segments.iter().filter(|s| s.y1 == 1).count(),
        0
    );

    // A hash typed in the search box finds the commit by oid prefix.
    q.max_count = 0;
    q.text = Some(a[..8].to_string());
    let (rows, _, _, _) = log::load(&g, &repos, &q).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].oid, a);
}

#[test]
fn explicit_refs_and_missing_refs() {
    let r = TestRepo::new();
    r.commit_file_at("a", "1", "on main", Some(100));
    r.sh(&["checkout", "-q", "-b", "side"]);
    r.commit_file_at("b", "2", "on side", Some(200));
    r.sh(&["checkout", "-q", "main"]);
    let g = git();
    let repos = [r.info.clone()];
    let mut q = query(&["r1"]);
    q.refs = vec!["main".into()];
    assert_eq!(log::load(&g, &repos, &q).unwrap().0.len(), 1);
    q.refs = vec!["side".into()];
    assert_eq!(log::load(&g, &repos, &q).unwrap().0.len(), 2);
    q.refs = vec!["does-not-exist".into()];
    assert!(log::load(&g, &repos, &q).unwrap().0.is_empty());
}

#[test]
fn detached_head_gets_a_head_label_and_stash_is_labelled() {
    let r = TestRepo::new();
    let a = r.commit_file_at("a", "1", "one", Some(100));
    r.commit_file_at("a", "2", "two", Some(200));
    r.write("a", "dirty");
    r.sh(&["stash", "push", "-q"]);
    r.sh(&["checkout", "-q", "--detach", &a]);
    let (rows, _, _, _) =
        log::load(&git(), std::slice::from_ref(&r.info), &query(&["r1"])).unwrap();
    let a_row = rows.iter().find(|r| r.oid == a).unwrap();
    assert!(a_row
        .refs
        .iter()
        .any(|l| l.kind == RefKind::Head && l.name == "HEAD"));
    // The stash commit is not listed by default, but its ref label exists on the index.
    assert_eq!(rows.len(), 2);

    let mut q = query(&["r1"]);
    q.refs = vec!["refs/stash".into()];
    let (rows, _, _, _) = log::load(&git(), std::slice::from_ref(&r.info), &q).unwrap();
    assert!(rows
        .iter()
        .any(|r| r.refs.iter().any(|l| l.kind == RefKind::Stash)));
}
