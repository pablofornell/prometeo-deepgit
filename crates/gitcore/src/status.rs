//! Working tree status (`git status --porcelain=v2 -z`) with numstat counts.

use std::collections::HashMap;
use std::path::Path;

use crate::error::GitError;
use crate::model::*;
use crate::runner::Git;

/// Added/deleted line counts of one path; `None` counts mean binary.
pub(crate) type Counts = HashMap<String, (Option<u32>, Option<u32>)>;

fn code_status(c: char) -> Option<FileStatus> {
    match c {
        'M' => Some(FileStatus::Modified),
        'A' => Some(FileStatus::Added),
        'D' => Some(FileStatus::Deleted),
        'R' => Some(FileStatus::Renamed),
        'C' => Some(FileStatus::Copied),
        'T' => Some(FileStatus::TypeChanged),
        _ => None,
    }
}

fn change(path: &str, old_path: Option<&str>, status: FileStatus) -> FileChange {
    FileChange {
        path: path.to_string(),
        old_path: old_path.map(str::to_string),
        status,
        additions: None,
        deletions: None,
        binary: false,
    }
}

/// Staged, unstaged (incl. untracked) and conflicted files of a repo.
pub fn working_tree(git: &Git, repo: &RepoInfo) -> Result<WorkingTree, GitError> {
    let path = Path::new(&repo.path);
    let out = git.run(
        path,
        Some(&repo.id),
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        false,
    )?;
    let mut tree = parse_porcelain_v2(&out.stdout, &repo.id)?;

    // Counts are best effort: a failing numstat must not hide the file list.
    let unstaged_counts = numstat(git, repo, &["diff", "--numstat", "-z"]);
    let staged_counts = numstat(git, repo, &["diff", "--cached", "--numstat", "-z", "-M"]);
    apply_counts(&mut tree.unstaged, &unstaged_counts);
    apply_counts(&mut tree.staged, &staged_counts);
    Ok(tree)
}

fn numstat(git: &Git, repo: &RepoInfo, args: &[&str]) -> Counts {
    match git.run(Path::new(&repo.path), Some(&repo.id), args, false) {
        Ok(out) => parse_numstat(&out.stdout),
        Err(_) => Counts::new(),
    }
}

fn apply_counts(files: &mut [FileChange], counts: &Counts) {
    for f in files {
        if f.status == FileStatus::Untracked {
            continue;
        }
        if let Some((a, d)) = counts.get(&f.path) {
            f.additions = *a;
            f.deletions = *d;
            f.binary = a.is_none() && d.is_none();
        }
    }
}

/// Parses `git status --porcelain=v2 -z` (no `--branch` headers needed, they are skipped).
pub fn parse_porcelain_v2(text: &str, repo_id: &str) -> Result<WorkingTree, GitError> {
    let mut tree = WorkingTree {
        repo_id: repo_id.to_string(),
        staged: Vec::new(),
        unstaged: Vec::new(),
        conflicted: Vec::new(),
    };
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    while let Some(tok) = tokens.next() {
        let bad = || GitError::Parse(format!("status entry: {tok:?}"));
        match tok.chars().next() {
            Some('#') | Some('!') => {}
            Some('?') => {
                let p = tok.get(2..).ok_or_else(bad)?;
                tree.unstaged.push(change(p, None, FileStatus::Untracked));
            }
            Some('1') => {
                // 1 XY sub mH mI mW hH hI path
                let f: Vec<&str> = tok.splitn(9, ' ').collect();
                if f.len() != 9 {
                    return Err(bad());
                }
                push_xy(&mut tree, f[1], f[8], None).ok_or_else(bad)?;
            }
            Some('2') => {
                // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
                let f: Vec<&str> = tok.splitn(10, ' ').collect();
                if f.len() != 10 {
                    return Err(bad());
                }
                let orig = tokens.next().ok_or_else(bad)?;
                push_xy(&mut tree, f[1], f[9], Some(orig)).ok_or_else(bad)?;
            }
            Some('u') => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let f: Vec<&str> = tok.splitn(11, ' ').collect();
                if f.len() != 11 {
                    return Err(bad());
                }
                tree.conflicted
                    .push(change(f[10], None, FileStatus::Conflicted));
            }
            _ => return Err(bad()),
        }
    }
    let by_path = |a: &FileChange, b: &FileChange| a.path.cmp(&b.path);
    tree.staged.sort_by(by_path);
    tree.unstaged.sort_by(by_path);
    tree.conflicted.sort_by(by_path);
    Ok(tree)
}

/// Adds the staged (X) and unstaged (Y) side of an ordinary or renamed entry.
fn push_xy(tree: &mut WorkingTree, xy: &str, path: &str, orig: Option<&str>) -> Option<()> {
    let mut it = xy.chars();
    let (x, y) = (it.next()?, it.next()?);
    if x != '.' {
        let old = orig.filter(|_| matches!(x, 'R' | 'C'));
        tree.staged.push(change(path, old, code_status(x)?));
    }
    if y != '.' {
        // A worktree-side rename only exists for intent-to-add; a staged rename that was then
        // edited is a plain modification relative to the index.
        let old = orig.filter(|_| matches!(y, 'R' | 'C'));
        tree.unstaged.push(change(path, old, code_status(y)?));
    }
    Some(())
}

/// Parses `git diff --numstat -z` output into counts keyed by the (new) path.
pub(crate) fn parse_numstat(text: &str) -> Counts {
    let mut counts = Counts::new();
    let mut tokens = text.split('\0');
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        let mut f = tok.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let path = if p.is_empty() {
            // Rename: "a\td\t\0old\0new\0"
            let _old = tokens.next();
            match tokens.next() {
                Some(new) => new,
                None => continue,
            }
        } else {
            p
        };
        counts.insert(path.to_string(), (a.parse().ok(), d.parse().ok()));
    }
    counts
}
