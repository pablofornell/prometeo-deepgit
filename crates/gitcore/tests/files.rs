mod common;

use common::*;
use gitcore::files;
use gitcore::GitError;

/// The message of an `Invalid` error; panics on any other kind.
fn invalid(e: GitError) -> String {
    match e {
        GitError::Invalid(m) => m,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

const CHANGED: &str = "The file changed on disk. Reload it before you save.";

// ------------------------------------------------------------------ list

#[test]
fn list_has_tracked_and_untracked_files_and_leaves_out_ignored_and_deleted() {
    let repo = TestRepo::new();
    repo.commit_file(".gitignore", "*.log\ndist/\n", "ignore rules");
    repo.commit_file("src/main.rs", "fn main() {}\n", "main");
    repo.commit_file("README.md", "# Title\n", "readme");
    repo.commit_file("gone.txt", "bye\n", "to delete");
    std::fs::remove_file(repo.path().join("gone.txt")).expect("remove");
    repo.write("src/new.rs", "pub fn new() {}\n");
    repo.write("Zeta.txt", "upper case sorts first\n");
    repo.write("build.log", "ignored\n");
    repo.write("dist/out.js", "ignored\n");

    let list = files::list_files(&git(), &repo.info).expect("list");
    assert_eq!(
        list.files,
        vec![
            ".gitignore",
            "README.md",
            "Zeta.txt",
            "src/main.rs",
            "src/new.rs"
        ]
    );
    assert!(!list.truncated);
}

#[test]
fn list_of_an_empty_repo_is_empty() {
    let repo = TestRepo::new();
    let list = files::list_files(&git(), &repo.info).expect("list");
    assert!(list.files.is_empty());
    assert!(!list.truncated);
}

// ------------------------------------------------------------------ read

#[test]
fn read_returns_text_with_its_version() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "hello\r\nworld\r\n", "a");
    let f = files::read_text_file(&git(), &repo.info, "a.txt").expect("read");
    assert_eq!(f.content, "hello\r\nworld\r\n");
    assert!(!f.binary && !f.too_large);
    assert!(f.version.ends_with("-14"), "version {}", f.version);
}

#[test]
fn read_marks_a_nul_byte_or_invalid_utf8_as_binary() {
    let repo = TestRepo::new();
    std::fs::write(repo.path().join("nul.dat"), b"abc\0def").expect("write");
    std::fs::write(repo.path().join("bad.dat"), [0xff, 0xfe, b'a']).expect("write");
    for path in ["nul.dat", "bad.dat"] {
        let f = files::read_text_file(&git(), &repo.info, path).expect("read");
        assert!(f.binary, "{path} should be binary");
        assert!(f.content.is_empty());
        assert!(!f.too_large);
    }
}

#[test]
fn read_refuses_a_file_over_2_mib_but_takes_exactly_2_mib() {
    let repo = TestRepo::new();
    let limit = 2 * 1024 * 1024;
    std::fs::write(repo.path().join("exact.txt"), vec![b'a'; limit]).expect("write");
    std::fs::write(repo.path().join("big.txt"), vec![b'a'; limit + 1]).expect("write");

    let exact = files::read_text_file(&git(), &repo.info, "exact.txt").expect("read");
    assert!(!exact.too_large);
    assert_eq!(exact.content.len(), limit);

    let big = files::read_text_file(&git(), &repo.info, "big.txt").expect("read");
    assert!(big.too_large);
    assert!(big.content.is_empty());
    assert!(big.version.is_empty());
}

#[cfg(unix)]
#[test]
fn read_refuses_a_symlink() {
    let repo = TestRepo::new();
    repo.commit_file("README.md", "# Title\n", "readme");
    std::os::unix::fs::symlink("README.md", repo.path().join("link.md")).expect("symlink");
    let msg = invalid(files::read_text_file(&git(), &repo.info, "link.md").unwrap_err());
    assert_eq!(msg, "link.md is a symlink.");
}

#[test]
fn read_refuses_paths_outside_the_repo_and_the_git_folder() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "a\n", "a");
    let g = git();
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "../outside.txt").unwrap_err()),
        "path outside the repo: ../outside.txt"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "/etc/passwd").unwrap_err()),
        "path outside the repo: /etc/passwd"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, ".git/config").unwrap_err()),
        "path inside the git folder: .git/config"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, ".GIT/HEAD").unwrap_err()),
        "path inside the git folder: .GIT/HEAD"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "").unwrap_err()),
        "No file path given."
    );
}

#[test]
fn read_refuses_a_folder_and_a_missing_file() {
    let repo = TestRepo::new();
    repo.commit_file("src/a.rs", "a\n", "a");
    let g = git();
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "src").unwrap_err()),
        "not a regular file: src"
    );
    assert_eq!(
        invalid(files::read_text_file(&g, &repo.info, "nope.txt").unwrap_err()),
        "file not found: nope.txt"
    );
}

// ------------------------------------------------------------------ write

#[test]
fn write_round_trips_and_returns_the_version_that_read_reports() {
    let repo = TestRepo::new();
    let g = git();
    let version = files::write_text_file(&g, &repo.info, "notes/todo.txt", "one\ntwo\n", None)
        .expect("write");
    assert_eq!(repo.read("notes/todo.txt"), "one\ntwo\n");
    let f = files::read_text_file(&g, &repo.info, "notes/todo.txt").expect("read");
    assert_eq!(f.content, "one\ntwo\n");
    assert_eq!(f.version, version);
}

#[test]
fn write_refuses_a_stale_version_and_keeps_the_disk_file() {
    let repo = TestRepo::new();
    let g = git();
    repo.commit_file("a.txt", "first\n", "a");
    let stale = files::read_text_file(&g, &repo.info, "a.txt")
        .expect("read")
        .version;
    files::write_text_file(&g, &repo.info, "a.txt", "second\n", Some(&stale)).expect("save");

    let err = files::write_text_file(&g, &repo.info, "a.txt", "third\n", Some(&stale));
    assert_eq!(invalid(err.unwrap_err()), CHANGED);
    assert_eq!(repo.read("a.txt"), "second\n");

    let current = files::read_text_file(&g, &repo.info, "a.txt")
        .expect("read")
        .version;
    files::write_text_file(&g, &repo.info, "a.txt", "third\n", Some(&current)).expect("save");
    assert_eq!(repo.read("a.txt"), "third\n");
}

#[test]
fn write_refuses_a_missing_file_when_a_version_was_expected() {
    let repo = TestRepo::new();
    let err = files::write_text_file(&git(), &repo.info, "gone.txt", "x", Some("abc-1"));
    assert_eq!(invalid(err.unwrap_err()), CHANGED);
    assert!(!repo.path().join("gone.txt").exists());
}

#[test]
fn write_keeps_crlf_bytes_exactly() {
    let repo = TestRepo::new();
    let g = git();
    files::write_text_file(&g, &repo.info, "win.txt", "a\r\nb\r\n", None).expect("write");
    let bytes = std::fs::read(repo.path().join("win.txt")).expect("read bytes");
    assert_eq!(bytes, b"a\r\nb\r\n");
}

#[test]
fn write_refuses_paths_outside_the_repo_and_the_git_folder() {
    let repo = TestRepo::new();
    let g = git();
    assert_eq!(
        invalid(files::write_text_file(&g, &repo.info, "../x.txt", "x", None).unwrap_err()),
        "path outside the repo: ../x.txt"
    );
    assert_eq!(
        invalid(
            files::write_text_file(&g, &repo.info, ".git/hooks/pre-commit", "x", None).unwrap_err()
        ),
        "path inside the git folder: .git/hooks/pre-commit"
    );
    assert!(!repo.path().join(".git/hooks/pre-commit").exists());
}

#[test]
fn write_refuses_a_folder_and_a_symlink() {
    let repo = TestRepo::new();
    let g = git();
    repo.commit_file("src/a.rs", "a\n", "a");
    assert_eq!(
        invalid(files::write_text_file(&g, &repo.info, "src", "x", None).unwrap_err()),
        "not a regular file: src"
    );
    #[cfg(unix)]
    {
        repo.commit_file("README.md", "# Title\n", "readme");
        std::os::unix::fs::symlink("README.md", repo.path().join("link.md")).expect("symlink");
        assert_eq!(
            invalid(files::write_text_file(&g, &repo.info, "link.md", "x", None).unwrap_err()),
            "link.md is a symlink."
        );
        assert_eq!(repo.read("README.md"), "# Title\n");
    }
}

// ------------------------------------------------------------------ search

#[test]
fn search_matches_a_fixed_string_with_its_line_and_column() {
    let repo = TestRepo::new();
    repo.commit_file("src/a.rs", "fn main() {\n    let x = foo();\n}\n", "a");
    repo.commit_file("src/b.rs", "foo\n", "b");
    let r = files::search_files(&git(), &repo.info, "foo()", true, false).expect("search");
    assert_eq!(r.hits.len(), 1);
    let h = &r.hits[0];
    assert_eq!(
        (h.path.as_str(), h.line, h.column),
        ("src/a.rs", 2, 13),
        "hit {h:?}"
    );
    assert_eq!(h.text, "    let x = foo();");
    assert!(!r.truncated);
}

#[test]
fn search_is_case_insensitive_only_when_asked() {
    let repo = TestRepo::new();
    repo.commit_file("notes.md", "todo: one\nTodo two\nDONE\n", "notes");
    let g = git();
    let loose = files::search_files(&g, &repo.info, "TODO", false, false).expect("search");
    assert_eq!(
        loose.hits.iter().map(|h| h.line).collect::<Vec<_>>(),
        vec![1, 2]
    );
    let strict = files::search_files(&g, &repo.info, "TODO", true, false).expect("search");
    assert!(strict.hits.is_empty());
}

#[test]
fn search_takes_a_regex_when_asked() {
    let repo = TestRepo::new();
    repo.commit_file("lib.rs", "pub fn alpha() {}\nlet beta = 1;\n", "lib");
    let g = git();
    let r = files::search_files(&g, &repo.info, "fn [a-z]+\\(", true, true).expect("search");
    assert_eq!(r.hits.len(), 1);
    assert_eq!(r.hits[0].line, 1);
    assert_eq!(r.hits[0].column, 5);
    // As plain text, `(` and `+` match only themselves.
    let plain = files::search_files(&g, &repo.info, "fn [a-z]+\\(", true, false).expect("search");
    assert!(plain.hits.is_empty());
}

#[test]
fn search_reports_an_invalid_regex_as_a_git_error() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "[x\n", "a");
    let err = files::search_files(&git(), &repo.info, "[", true, true).unwrap_err();
    assert!(matches!(err, GitError::Command { .. }), "got {err:?}");
}

#[test]
fn search_without_a_match_is_empty() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "hello\n", "a");
    let r = files::search_files(&git(), &repo.info, "zzz-not-here", true, false).expect("search");
    assert!(r.hits.is_empty());
    assert!(!r.truncated);
}

#[test]
fn search_counts_the_column_in_characters() {
    let repo = TestRepo::new();
    repo.commit_file("uni.txt", "héllo needle\nsay needle\r\n", "uni");
    let r = files::search_files(&git(), &repo.info, "needle", true, false).expect("search");
    assert_eq!(r.hits.len(), 2);
    assert_eq!((r.hits[0].line, r.hits[0].column), (1, 7));
    assert_eq!(r.hits[0].text, "héllo needle");
    // Drop the carriage return of a CRLF line from the text.
    assert_eq!((r.hits[1].line, r.hits[1].column), (2, 5));
    assert_eq!(r.hits[1].text, "say needle");
}

#[test]
fn search_cuts_the_text_of_a_long_line_to_400_characters() {
    let repo = TestRepo::new();
    let line = format!("{}needle", "x".repeat(500));
    repo.commit_file("long.txt", &format!("{line}\n"), "long");
    let r = files::search_files(&git(), &repo.info, "needle", true, false).expect("search");
    assert_eq!(r.hits.len(), 1);
    assert_eq!(r.hits[0].text.chars().count(), 400);
    assert_eq!(r.hits[0].column, 501);
}

#[cfg(unix)]
#[test]
fn search_does_not_follow_a_symlink_out_of_the_repo() {
    let repo = TestRepo::new();
    let outside = tempfile::tempdir().expect("tempdir");
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "zqSecret\n").expect("write");
    std::os::unix::fs::symlink(&secret, repo.path().join("tracked-link.txt")).expect("symlink");
    repo.sh(&["add", "tracked-link.txt"]);
    std::os::unix::fs::symlink(&secret, repo.path().join("untracked-link.txt")).expect("symlink");
    let r = files::search_files(&git(), &repo.info, "zqSecret", true, false).expect("search");
    assert!(r.hits.is_empty(), "hits {:?}", r.hits);
}

#[test]
fn search_does_not_read_the_query_as_an_option() {
    let repo = TestRepo::new();
    repo.commit_file("opts.txt", "--verbose flag\n", "opts");
    let r = files::search_files(&git(), &repo.info, "--verbose", true, false).expect("search");
    assert_eq!(r.hits.len(), 1);
}

#[test]
fn search_skips_ignored_files_and_includes_untracked_ones() {
    let repo = TestRepo::new();
    repo.commit_file(".gitignore", "secret.env\n", "ignore");
    repo.commit_file("public.txt", "needle here\n", "public");
    repo.write("secret.env", "needle in the secret\n");
    repo.write("new.txt", "needle untracked\n");
    let r = files::search_files(&git(), &repo.info, "needle", true, false).expect("search");
    let paths: Vec<&str> = r.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(paths, vec!["new.txt", "public.txt"]);
}

#[test]
fn search_stops_at_2000_hits_and_says_so() {
    let repo = TestRepo::new();
    repo.write("many.txt", &"needle\n".repeat(2100));
    let r = files::search_files(&git(), &repo.info, "needle", true, false).expect("search");
    assert_eq!(r.hits.len(), 2000);
    assert!(r.truncated);
    assert_eq!(r.hits[0].line, 1);
}

#[test]
fn search_refuses_a_line_break_or_a_nul_and_accepts_an_empty_query() {
    let repo = TestRepo::new();
    let g = git();
    for bad in ["a\nb", "a\0b", "a\rb"] {
        let msg = invalid(files::search_files(&g, &repo.info, bad, true, false).unwrap_err());
        assert_eq!(
            msg,
            "The search text cannot contain a line break or a NUL character."
        );
    }
    let empty = files::search_files(&g, &repo.info, "", true, false).expect("search");
    assert!(empty.hits.is_empty());
}
