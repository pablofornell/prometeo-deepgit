mod common;

use common::*;
use gitcore::{refs, RepoStateKind};

#[test]
fn branches_tags_stashes_and_remotes() {
    // The "remote" is a second local repo that we clone.
    let origin = TestRepo::named("origin");
    let c1 = origin.commit_file("a.txt", "1\n", "one");
    origin.sh(&["branch", "side"]);

    let clone_dir = tempfile::tempdir().unwrap();
    let clone_path = clone_dir.path().join("clone");
    sh(
        clone_dir.path(),
        &[
            "clone",
            "-q",
            origin.path().to_str().unwrap(),
            clone_path.to_str().unwrap(),
        ],
        None,
    );
    for (k, v) in [
        ("user.name", "Test"),
        ("user.email", "t@e.com"),
        ("commit.gpgsign", "false"),
    ] {
        sh(&clone_path, &["config", k, v], None);
    }
    let info = info_for("clone", &clone_path);
    let g = git();

    // Fresh clone: in sync.
    let s = refs::repo_summary(&g, &info).unwrap();
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!(s.upstream.as_deref(), Some("origin/main"));
    assert_eq!((s.ahead, s.behind), (0, 0));
    assert_eq!(s.head_oid.as_deref(), Some(c1.as_str()));
    assert_eq!(s.state, RepoStateKind::Clean);

    // Two local commits ahead, one new commit upstream (behind after fetch).
    std::fs::write(clone_path.join("l.txt"), "l1\n").unwrap();
    sh(&clone_path, &["add", "-A"], None);
    sh(&clone_path, &["commit", "-q", "-m", "local 1"], None);
    std::fs::write(clone_path.join("l.txt"), "l2\n").unwrap();
    sh(&clone_path, &["commit", "-q", "-a", "-m", "local 2"], None);
    origin.commit_file("o.txt", "o\n", "upstream new");
    sh(&clone_path, &["fetch", "-q"], None);
    sh(&clone_path, &["tag", "light"], None);
    sh(
        &clone_path,
        &["tag", "-a", "annot", "-m", "annotated tag"],
        None,
    );
    std::fs::write(clone_path.join("l.txt"), "l3\n").unwrap();
    sh(
        &clone_path,
        &["stash", "push", "-q", "-m", "my stash"],
        None,
    );

    let r = refs::read_refs(&g, &info).unwrap();
    let main = r.local.iter().find(|b| b.name == "main").unwrap();
    assert!(main.is_head);
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert_eq!((main.ahead, main.behind), (2, 1));
    assert!(!main.gone);

    let names: Vec<&str> = r.remote.iter().map(|b| b.full_name.as_str()).collect();
    assert!(names.contains(&"origin/main") && names.contains(&"origin/side"));
    assert!(!names.iter().any(|n| n.ends_with("/HEAD")));
    let side = r.remote.iter().find(|b| b.name == "side").unwrap();
    assert_eq!(side.remote, "origin");
    assert_eq!(side.oid, c1);

    let head = sh(&clone_path, &["rev-parse", "HEAD"], None);
    let light = r.tags.iter().find(|t| t.name == "light").unwrap();
    assert!(!light.annotated);
    assert_eq!(light.oid, head);
    let annot = r.tags.iter().find(|t| t.name == "annot").unwrap();
    assert!(annot.annotated);
    assert_eq!(annot.oid, head, "annotated tags are peeled to the commit");

    assert_eq!(r.stashes.len(), 1);
    assert_eq!(r.stashes[0].index, 0);
    assert!(r.stashes[0].message.contains("my stash"));
    assert!(r.stashes[0].time > 0);

    assert_eq!(r.remotes.len(), 1);
    assert_eq!(r.remotes[0].name, "origin");
    assert_eq!(r.remotes[0].url, origin.path().to_str().unwrap());
    assert!(r.submodules.is_empty());

    let s = refs::repo_summary(&g, &info).unwrap();
    assert_eq!((s.ahead, s.behind), (2, 1));
    assert_eq!(s.stash_count, 1);

    // Upstream branch deleted on the remote -> gone.
    sh(
        &clone_path,
        &["checkout", "-q", "-b", "topic", "origin/side"],
        None,
    );
    origin.sh(&["branch", "-D", "side"]);
    sh(&clone_path, &["fetch", "-q", "--prune"], None);
    let r = refs::read_refs(&g, &info).unwrap();
    let topic = r.local.iter().find(|b| b.name == "topic").unwrap();
    assert!(topic.gone);
}

#[test]
fn summary_counts_and_empty_repo() {
    let r = TestRepo::new();
    let g = git();
    let s = refs::repo_summary(&g, &r.info).unwrap();
    assert_eq!(s.head_oid, None);
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!(s.upstream, None);
    assert!(refs::read_refs(&g, &r.info).unwrap().local.is_empty());

    r.commit_file("a.txt", "1\n", "one");
    r.commit_file("b.txt", "1\n", "two");
    r.write("a.txt", "2\n"); // unstaged
    r.write("b.txt", "2\n");
    r.sh(&["add", "b.txt"]); // staged
    r.write("b.txt", "3\n"); // and unstaged again
    r.write("new.txt", "n\n"); // untracked
    let s = refs::repo_summary(&g, &r.info).unwrap();
    assert_eq!(
        (s.staged, s.unstaged, s.untracked, s.conflicted),
        (1, 2, 1, 0)
    );

    r.sh(&["checkout", "-q", "--detach"]);
    let s = refs::repo_summary(&g, &r.info).unwrap();
    assert_eq!(s.branch, None);
    assert!(s.head_oid.is_some());
}

#[test]
fn branches_containing_lists_local_and_remote() {
    let origin = TestRepo::named("origin");
    let c1 = origin.commit_file("a", "1", "one");
    let dir = tempfile::tempdir().unwrap();
    let clone = dir.path().join("c");
    sh(
        dir.path(),
        &[
            "clone",
            "-q",
            origin.path().to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
        None,
    );
    sh(&clone, &["branch", "feature", &c1], None);
    let info = info_for("c", &clone);
    let mut names = refs::branches_containing(&git(), &info, &c1).unwrap();
    names.sort();
    assert_eq!(names, vec!["feature", "main", "origin/main"]);
}
