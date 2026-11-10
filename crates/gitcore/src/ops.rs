//! Write operations (PLAN.md section 5.4). Expected outcomes such as a merge conflict return
//! `OpResult { ok: false, conflicts: true }`; any other failure is a `GitError`.

use std::path::{Component, Path};

use crate::diff;
use crate::error::{check_name, check_push_branch, GitError};
use crate::model::*;
use crate::refs;
use crate::runner::{command_error, Git};
use crate::state;

fn path_of(repo: &RepoInfo) -> &Path {
    Path::new(&repo.path)
}

fn ok_result(out: &crate::runner::Output) -> OpResult {
    OpResult {
        ok: true,
        message: out.summary(),
        conflicts: false,
    }
}

/// Runs a write command. On failure, `conflictable` commands (merge, rebase, cherry-pick, revert,
/// stash apply...) that stopped on conflicts yield `ok: false, conflicts: true`, and ones that
/// stopped without conflicts (an empty cherry-pick, a failing hook) yield `ok: false,
/// conflicts: false`: the operation is in progress and the user continues, skips or aborts it.
/// A `conflictable` command that exits 0 can still leave conflicts behind (the autostash of a
/// rebase that could not be restored): that is `ok: false, conflicts: true` too.
fn op(
    git: &Git,
    repo: &RepoInfo,
    args: &[&str],
    stdin: Option<&[u8]>,
    conflictable: bool,
) -> Result<OpResult, GitError> {
    run_op(git, repo, args, stdin, conflictable, false)
}

/// `op` for `--continue` / `--skip`: those start in the in-progress state, so staying in it
/// counts as stopped (an empty commit), not only a change of state.
fn op_resume(git: &Git, repo: &RepoInfo, args: &[&str]) -> Result<OpResult, GitError> {
    run_op(git, repo, args, None, true, true)
}

fn run_op(
    git: &Git,
    repo: &RepoInfo,
    args: &[&str],
    stdin: Option<&[u8]>,
    conflictable: bool,
    resuming: bool,
) -> Result<OpResult, GitError> {
    let before = if conflictable {
        current_state(repo).unwrap_or(RepoStateKind::Clean)
    } else {
        RepoStateKind::Clean
    };
    let out = git.run_unchecked(path_of(repo), Some(&repo.id), args, true, stdin)?;
    let text = format!("{}\n{}", out.stdout, out.stderr);
    if out.code == 0 {
        if conflictable {
            // git <= 2.4x: "Applying autostash resulted in conflicts. Your changes are safe in
            // the stash." Newer git: "Your local changes are stashed, however applying them
            // resulted in conflicts."
            let autostash = text.contains("Applying autostash resulted in conflicts")
                || text.contains("Your changes are safe in the stash")
                || text.contains("Your local changes are stashed, however applying them");
            if autostash || has_unmerged(git, repo) {
                return Ok(OpResult {
                    ok: false,
                    message: if autostash {
                        autostash_message(args)
                    } else {
                        out.summary()
                    },
                    conflicts: true,
                });
            }
        }
        return Ok(ok_result(&out));
    }
    if conflictable {
        let conflicts = text.contains("CONFLICT")
            || text.contains("Automatic merge failed")
            || text.contains("could not apply")
            || has_unmerged(git, repo);
        let stopped = current_state(repo)
            .is_ok_and(|s| s != RepoStateKind::Clean && (resuming || s != before));
        if conflicts || stopped {
            let message = if !conflicts && resuming && text.contains("empty") {
                "The next commit is empty. Skip it or commit with --allow-empty.".to_string()
            } else {
                out.summary()
            };
            return Ok(OpResult {
                ok: false,
                message,
                conflicts,
            });
        }
    }
    Err(command_error(path_of(repo), args, &out))
}

/// The message for an operation that finished but could not restore the autostashed changes.
fn autostash_message(args: &[&str]) -> String {
    let what = match args.iter().find(|a| !a.starts_with('-')).copied() {
        Some("rebase") => "Rebase",
        Some("merge") => "Merge",
        Some("pull") => "Pull",
        Some("cherry-pick") => "Cherry-pick",
        Some("revert") => "Revert",
        Some("stash") => "Stash",
        _ => "The operation",
    };
    format!(
        "{what} done, but your local changes conflict with it. They are kept in the stash \
         (stash@{{0}}). Resolve the files, then drop the stash."
    )
}

fn has_unmerged(git: &Git, repo: &RepoInfo) -> bool {
    git.run_unchecked(
        path_of(repo),
        Some(&repo.id),
        &["diff", "--name-only", "--diff-filter=U", "-z"],
        false,
        None,
    )
    .map(|o| o.code == 0 && !o.stdout.is_empty())
    .unwrap_or(false)
}

fn has_head(git: &Git, repo: &RepoInfo) -> Result<bool, GitError> {
    let out = git.run_unchecked(
        path_of(repo),
        Some(&repo.id),
        &["rev-parse", "-q", "--verify", "HEAD"],
        false,
        None,
    )?;
    Ok(out.code == 0)
}

/// Rejects absolute paths and `..` so a path can never point outside the repo.
fn check_rel(path: &str) -> Result<(), GitError> {
    if Path::new(path)
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(GitError::Invalid(format!("path outside the repo: {path}")));
    }
    Ok(())
}

/// `args` prefixed with the literal-pathspec switch, then `--` and the paths.
fn with_paths<'a>(head: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut v = vec!["--literal-pathspecs"];
    v.extend_from_slice(head);
    v.push("--");
    v.extend(paths.iter().map(String::as_str));
    v
}

// ---------------------------------------------------------------- index and worktree

/// `git add -A -- paths`
pub fn stage(git: &Git, repo: &RepoInfo, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    git.run(
        path_of(repo),
        Some(&repo.id),
        &with_paths(&["add", "-A"], paths),
        true,
    )?;
    Ok(())
}

/// Old paths of the staged renames whose new path is among `paths` (or below one of them):
/// unstaging only the new side would leave the deletion of the old file staged on its own.
fn rename_sources(git: &Git, repo: &RepoInfo, paths: &[String]) -> Result<Vec<String>, GitError> {
    let out = git.run_unchecked(
        path_of(repo),
        Some(&repo.id),
        &["diff", "--cached", "--name-status", "-M", "-z"],
        false,
        None,
    )?;
    if out.code != 0 {
        return Ok(Vec::new());
    }
    let mut sources = Vec::new();
    for change in diff::parse_name_status(&out.stdout)? {
        let Some(old) = change
            .old_path
            .filter(|_| change.status == FileStatus::Renamed)
        else {
            continue;
        };
        if paths.iter().any(|p| covers(p, &change.path)) && !paths.contains(&old) {
            sources.push(old);
        }
    }
    Ok(sources)
}

/// True when `file` is `path` or lies below it (`path` may be a folder, `.` or empty).
fn covers(path: &str, file: &str) -> bool {
    let p = path.trim_end_matches('/');
    p.is_empty() || p == "." || file == p || file.starts_with(&format!("{p}/"))
}

/// `git restore --staged -- paths` (`git reset -q HEAD -- paths` when there is no HEAD yet). The
/// old path of a staged rename is unstaged together with its new path.
pub fn unstage(git: &Git, repo: &RepoInfo, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    let has_head = has_head(git, repo)?;
    let mut all: Vec<String> = paths.to_vec();
    if has_head {
        all.extend(rename_sources(git, repo, paths)?);
    }
    let head: &[&str] = if has_head {
        &["restore", "--staged"]
    } else {
        &["rm", "--cached", "-r", "-q", "--ignore-unmatch"]
    };
    git.run(path_of(repo), Some(&repo.id), &with_paths(head, &all), true)?;
    Ok(())
}

/// Reverts tracked paths to the index and deletes untracked ones.
pub fn discard(git: &Git, repo: &RepoInfo, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    for p in paths {
        check_rel(p)?;
    }
    let rp = path_of(repo);
    // Only what git lists as untracked (and not ignored) is deleted.
    let others = git.run(
        rp,
        Some(&repo.id),
        &with_paths(&["ls-files", "--others", "--exclude-standard", "-z"], paths),
        false,
    )?;
    for u in others.stdout.split('\0').filter(|s| !s.is_empty()) {
        check_rel(u)?;
        match std::fs::remove_file(rp.join(u)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    // A folder can hold tracked and untracked files at once: restore every path that covers at
    // least one tracked file (restoring a purely untracked path would fail).
    let tracked = git.run(
        rp,
        Some(&repo.id),
        &with_paths(&["ls-files", "-z"], paths),
        false,
    )?;
    let tracked_files: Vec<&str> = tracked
        .stdout
        .split('\0')
        .filter(|s| !s.is_empty())
        .collect();
    let restorable: Vec<String> = paths
        .iter()
        .filter(|p| tracked_files.iter().any(|f| covers(p, f)))
        .cloned()
        .collect();
    if !restorable.is_empty() {
        git.run(
            rp,
            Some(&repo.id),
            &with_paths(&["restore", "--worktree"], &restorable),
            true,
        )?;
    }
    Ok(())
}

/// Optional refinements of the hunk operations.
#[derive(Clone, Debug, Default)]
pub struct HunkOpts<'a> {
    /// Old path of a renamed file (needed to see the same diff as the UI for a staged rename).
    pub old_path: Option<&'a str>,
    /// Header numbers (and body hash) of the hunk the user saw; when set it selects the hunk (the
    /// index is ignored) and the call fails if the hunk changed.
    pub expected: Option<HunkRef>,
    /// Context lines of the diff the UI showed (default 3).
    pub context: Option<u32>,
}

/// Header of a patch for a renamed file with the rename dropped: both sides name the new path, so
/// a hunk applies to the file as it is in the index (the deletion of the old path stays alone).
fn without_rename(header: &[u8]) -> Vec<u8> {
    let line_with = |prefix: &[u8]| {
        header
            .split(|b| *b == b'\n')
            .find(|l| l.starts_with(prefix))
            .map(|l| l[prefix.len()..].to_vec())
    };
    if line_with(b"rename from ").is_none() {
        return header.to_vec();
    }
    let Some(plus) = line_with(b"+++ ") else {
        return header.to_vec();
    };
    // "b/path" or "\"b/path\"" -> "a/path" / "\"a/path\"".
    let mut minus = plus.clone();
    let at = usize::from(minus.first() == Some(&b'"'));
    if minus.get(at..at + 2) == Some(b"b/") {
        minus[at] = b'a';
    }
    let mut out = Vec::new();
    for (prefix, first, second) in [
        (&b"diff --git "[..], &minus, Some(&plus)),
        (&b"--- "[..], &minus, None),
        (&b"+++ "[..], &plus, None),
    ] {
        out.extend_from_slice(prefix);
        out.extend_from_slice(first);
        if let Some(second) = second {
            out.push(b' ');
            out.extend_from_slice(second);
        }
        out.push(b'\n');
    }
    out
}

/// Builds the single-hunk patch (raw bytes) for a hunk of the staged or unstaged diff of `path`.
/// The diff is recomputed with the context the UI used; `opts.expected` picks the hunk by its
/// header numbers, otherwise `hunk_index` does.
fn hunk_patch(
    git: &Git,
    repo: &RepoInfo,
    path: &str,
    hunk_index: u32,
    staged: bool,
    opts: &HunkOpts,
) -> Result<Vec<u8>, GitError> {
    let spec = if staged {
        DiffSpec::Staged
    } else {
        DiffSpec::Unstaged
    };
    let old_path = opts.old_path.filter(|_| staged);
    if let Some(o) = old_path {
        check_rel(o)?;
    }
    let context = opts.context.unwrap_or(3);
    let text = diff::raw_file_diff(git, repo, &spec, path, old_path, context, true)?;
    let mut patch = diff::split_patch(&text)?;
    if old_path.is_some() && !patch.header.windows(12).any(|w| w == b"rename from ") {
        // Too different to count as a rename: git lists the deletion of the old path first, and
        // its hunks are not the ones of `path`.
        let text = diff::raw_file_diff(git, repo, &spec, path, None, context, true)?;
        patch = diff::split_patch(&text)?;
    }
    let picked = match &opts.expected {
        Some(e) => {
            let stale = || GitError::Invalid("The file changed. Reload the diff.".into());
            let i = patch
                .hunks
                .iter()
                .position(|h| h.id.same_header(e))
                .ok_or_else(stale)?;
            // The same header can hide other content (the file was edited in place).
            if let Some(want) = &e.hash {
                if *want != patch.hunks[i].display_hash() {
                    return Err(stale());
                }
            }
            i
        }
        None => {
            let i = hunk_index as usize;
            if i >= patch.hunks.len() {
                return Err(GitError::Invalid(format!(
                    "hunk {hunk_index} not found in {path} ({} hunks)",
                    patch.hunks.len()
                )));
            }
            i
        }
    };
    let hunk = patch.hunks.swap_remove(picked);
    // The header lines of git's own diff (`diff --git`, `index`, `---`, `+++`, mode lines) are
    // reused so added and deleted files apply correctly too.
    let mut out = without_rename(&patch.header);
    out.extend_from_slice(&hunk.bytes);
    Ok(out)
}

fn apply_args(reverse: bool, cached: bool, context: Option<u32>) -> Vec<&'static str> {
    let mut args = vec!["apply"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("--whitespace=nowarn");
    if context == Some(0) {
        // A patch without context lines is refused otherwise.
        args.push("--unidiff-zero");
    }
    args.push("-");
    args
}

/// Stages one hunk of the unstaged diff, or unstages one hunk of the staged diff (`reverse`).
pub fn stage_hunk(
    git: &Git,
    repo: &RepoInfo,
    path: &str,
    hunk_index: u32,
    reverse: bool,
    opts: &HunkOpts,
) -> Result<(), GitError> {
    check_rel(path)?;
    let patch = hunk_patch(git, repo, path, hunk_index, reverse, opts)?;
    let args = apply_args(reverse, true, opts.context);
    git.run_stdin(path_of(repo), Some(&repo.id), &args, true, &patch)?;
    Ok(())
}

/// Reverts one hunk of the unstaged diff in the worktree.
pub fn discard_hunk(
    git: &Git,
    repo: &RepoInfo,
    path: &str,
    hunk_index: u32,
    opts: &HunkOpts,
) -> Result<(), GitError> {
    check_rel(path)?;
    let patch = hunk_patch(git, repo, path, hunk_index, false, opts)?;
    let args = apply_args(true, false, opts.context);
    git.run_stdin(path_of(repo), Some(&repo.id), &args, true, &patch)?;
    Ok(())
}

// ---------------------------------------------------------------- commit, branches, history

/// `git commit -F -` (message on stdin); `--amend` when asked. An empty message with `amend` keeps
/// the previous message.
pub fn commit(
    git: &Git,
    repo: &RepoInfo,
    message: &str,
    amend: bool,
) -> Result<OpResult, GitError> {
    if amend && message.trim().is_empty() {
        return op(git, repo, &["commit", "--amend", "--no-edit"], None, false);
    }
    let mut args = vec!["commit"];
    if amend {
        args.push("--amend");
    }
    args.extend(["-F", "-"]);
    op(git, repo, &args, Some(message.as_bytes()), false)
}

fn is_remote_branch(git: &Git, repo: &RepoInfo, name: &str) -> Result<bool, GitError> {
    check_name("branch", name)?;
    let full = format!("refs/remotes/{name}");
    let out = git.run_unchecked(
        path_of(repo),
        Some(&repo.id),
        &["show-ref", "--verify", "-q", &full],
        false,
        None,
    )?;
    Ok(out.code == 0)
}

/// Checks out `target`; with `new_branch` creates it (tracking `target` when it is a remote branch).
/// The trailing `--` makes git read `target` as a revision, never as a file to overwrite.
pub fn checkout(
    git: &Git,
    repo: &RepoInfo,
    target: &str,
    new_branch: Option<&str>,
) -> Result<OpResult, GitError> {
    check_name("branch or revision", target)?;
    if let Some(nb) = new_branch {
        check_name("branch name", nb)?;
    }
    match new_branch {
        None => op(git, repo, &["checkout", target, "--"], None, false),
        Some(nb) if is_remote_branch(git, repo, target)? => op(
            git,
            repo,
            &["checkout", "-b", nb, "--track", target, "--"],
            None,
            false,
        ),
        Some(nb) => op(
            git,
            repo,
            &["checkout", "-b", nb, target, "--"],
            None,
            false,
        ),
    }
}

pub fn branch_create(
    git: &Git,
    repo: &RepoInfo,
    name: &str,
    start_point: &str,
    checkout: bool,
) -> Result<OpResult, GitError> {
    check_name("branch name", name)?;
    check_name("start point", start_point)?;
    let mut args = if checkout {
        vec!["checkout", "-b", name]
    } else {
        vec!["branch", name]
    };
    if !start_point.is_empty() {
        args.push(start_point);
    }
    op(git, repo, &args, None, false)
}

/// Deletes a local branch, or with `remote` the remote branch `name` given as "origin/feature"
/// (`git push origin --delete feature`).
pub fn branch_delete(
    git: &Git,
    repo: &RepoInfo,
    name: &str,
    force: bool,
    remote: bool,
) -> Result<OpResult, GitError> {
    check_name("branch name", name)?;
    if remote {
        // The remote name can hold slashes ("team/fork"): use the longest configured one.
        let remotes = refs::read_remotes(git, repo)?;
        let (r, b) = remotes
            .iter()
            .filter_map(|r| {
                let branch = name.strip_prefix(r.name.as_str())?.strip_prefix('/')?;
                (!branch.is_empty()).then_some((r.name.as_str(), branch))
            })
            .max_by_key(|(r, _)| r.len())
            .ok_or_else(|| {
                GitError::Invalid(format!("{name} does not belong to a configured remote"))
            })?;
        check_push_branch("remote branch name", b)?;
        let target = format!("refs/heads/{b}");
        return op(
            git,
            repo,
            &["push", "--progress", r, "--delete", &target],
            None,
            false,
        );
    }
    op(
        git,
        repo,
        &["branch", if force { "-D" } else { "-d" }, name],
        None,
        false,
    )
}

pub fn branch_rename(
    git: &Git,
    repo: &RepoInfo,
    old: &str,
    new: &str,
) -> Result<OpResult, GitError> {
    check_name("branch name", old)?;
    check_name("branch name", new)?;
    op(git, repo, &["branch", "-m", old, new], None, false)
}

pub fn merge(
    git: &Git,
    repo: &RepoInfo,
    target: &str,
    no_ff: bool,
    squash: bool,
) -> Result<OpResult, GitError> {
    check_name("branch or revision", target)?;
    let mut args = vec!["merge"];
    if squash {
        args.push("--squash");
    } else {
        args.push("--no-edit");
        if no_ff {
            args.push("--no-ff");
        }
    }
    args.push(target);
    op(git, repo, &args, None, true)
}

/// `git rebase --autostash onto`: local changes are stashed first and restored afterwards (or by
/// `rebase --abort`). If restoring them conflicts, git keeps them in the stash and still succeeds.
pub fn rebase(git: &Git, repo: &RepoInfo, onto: &str) -> Result<OpResult, GitError> {
    check_name("branch or revision", onto)?;
    op(git, repo, &["rebase", "--autostash", onto], None, true)
}

pub fn cherry_pick(git: &Git, repo: &RepoInfo, oids: &[String]) -> Result<OpResult, GitError> {
    if oids.is_empty() {
        return Err(GitError::Invalid("no commits to cherry-pick".into()));
    }
    for o in oids {
        check_name("commit", o)?;
    }
    let mut args = vec!["cherry-pick"];
    args.extend(oids.iter().map(String::as_str));
    op(git, repo, &args, None, true)
}

pub fn revert(git: &Git, repo: &RepoInfo, oid: &str) -> Result<OpResult, GitError> {
    check_name("commit", oid)?;
    op(git, repo, &["revert", "--no-edit", oid], None, true)
}

pub fn reset(
    git: &Git,
    repo: &RepoInfo,
    target: &str,
    mode: ResetMode,
) -> Result<OpResult, GitError> {
    check_name("branch or revision", target)?;
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
        ResetMode::Hard => "--hard",
        ResetMode::Keep => "--keep",
    };
    op(git, repo, &["reset", flag, target], None, false)
}

// ---------------------------------------------------------------- in-progress operations

fn current_state(repo: &RepoInfo) -> Result<RepoStateKind, GitError> {
    state::repo_state(path_of(repo))
}

fn nothing_in_progress() -> GitError {
    GitError::Invalid("no operation in progress".into())
}

/// Continues the detected merge / rebase / cherry-pick / revert.
pub fn op_continue(git: &Git, repo: &RepoInfo) -> Result<OpResult, GitError> {
    let args: &[&str] = match current_state(repo)? {
        RepoStateKind::Merging => &["merge", "--continue"],
        RepoStateKind::Rebasing => &["rebase", "--continue"],
        RepoStateKind::CherryPicking => &["cherry-pick", "--continue"],
        RepoStateKind::Reverting => &["revert", "--continue"],
        RepoStateKind::Bisecting | RepoStateKind::Clean => return Err(nothing_in_progress()),
    };
    op_resume(git, repo, args)
}

/// Aborts the detected operation (`bisect reset` for a bisect).
pub fn op_abort(git: &Git, repo: &RepoInfo) -> Result<OpResult, GitError> {
    let args: &[&str] = match current_state(repo)? {
        RepoStateKind::Merging => &["merge", "--abort"],
        RepoStateKind::Rebasing => &["rebase", "--abort"],
        RepoStateKind::CherryPicking => &["cherry-pick", "--abort"],
        RepoStateKind::Reverting => &["revert", "--abort"],
        RepoStateKind::Bisecting => &["bisect", "reset"],
        RepoStateKind::Clean => return Err(nothing_in_progress()),
    };
    op(git, repo, args, None, false)
}

/// Skips the current commit of a rebase / cherry-pick / revert.
pub fn op_skip(git: &Git, repo: &RepoInfo) -> Result<OpResult, GitError> {
    let args: &[&str] = match current_state(repo)? {
        RepoStateKind::Rebasing => &["rebase", "--skip"],
        RepoStateKind::CherryPicking => &["cherry-pick", "--skip"],
        RepoStateKind::Reverting => &["revert", "--skip"],
        RepoStateKind::Merging | RepoStateKind::Bisecting => {
            return Err(GitError::Invalid("this operation cannot be skipped".into()))
        }
        RepoStateKind::Clean => return Err(nothing_in_progress()),
    };
    op_resume(git, repo, args)
}

// ---------------------------------------------------------------- remotes

/// `remote = None` fetches `--all`.
pub fn fetch(
    git: &Git,
    repo: &RepoInfo,
    remote: Option<&str>,
    prune: bool,
) -> Result<OpResult, GitError> {
    if let Some(r) = remote {
        check_name("remote", r)?;
    }
    let mut args = vec!["fetch", "--progress"];
    if prune {
        args.push("--prune");
    }
    args.push(remote.unwrap_or("--all"));
    op(git, repo, &args, None, false)
}

pub fn pull(git: &Git, repo: &RepoInfo, rebase: bool) -> Result<OpResult, GitError> {
    let args = if rebase {
        vec!["pull", "--progress", "--rebase"]
    } else {
        vec!["pull", "--progress", "--no-edit", "--ff"]
    };
    op(git, repo, &args, None, true)
}

/// `force` is `--force-with-lease`. A branch without a remote pushes to `origin`.
pub fn push(
    git: &Git,
    repo: &RepoInfo,
    remote: Option<&str>,
    branch: Option<&str>,
    force: bool,
    set_upstream: bool,
    tags: bool,
) -> Result<OpResult, GitError> {
    if let Some(r) = remote {
        check_name("remote", r)?;
    }
    if let Some(b) = branch {
        check_push_branch("branch name", b)?;
    }
    // Fully qualified, so a tag or a file named like the branch cannot change what is pushed.
    let refspec = branch.map(|b| format!("refs/heads/{b}:refs/heads/{b}"));
    let mut args = vec!["push", "--porcelain", "--progress"];
    if force {
        args.push("--force-with-lease");
    }
    if set_upstream {
        args.push("-u");
    }
    if tags {
        args.push("--tags");
    }
    match (remote, refspec.as_deref()) {
        (Some(r), Some(b)) => args.extend([r, b]),
        (Some(r), None) => args.push(r),
        (None, Some(b)) => args.extend(["origin", b]),
        (None, None) => {}
    }
    op(git, repo, &args, None, false)
}

// ---------------------------------------------------------------- stash and tags

pub fn stash_save(
    git: &Git,
    repo: &RepoInfo,
    message: Option<&str>,
    include_untracked: bool,
    keep_index: bool,
) -> Result<OpResult, GitError> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    if keep_index {
        args.push("--keep-index");
    }
    if let Some(m) = message.filter(|m| !m.is_empty()) {
        args.extend(["-m", m]);
    }
    op(git, repo, &args, None, false)
}

fn stash_op(
    git: &Git,
    repo: &RepoInfo,
    verb: &str,
    index: u32,
    oid: Option<&str>,
    conflictable: bool,
) -> Result<OpResult, GitError> {
    let sel = format!("stash@{{{index}}}");
    if let Some(expected) = oid {
        // The list can change between the UI listing it and this call (another stash, a pop).
        let now = git.run_unchecked(
            path_of(repo),
            Some(&repo.id),
            &["rev-parse", "-q", "--verify", &sel],
            false,
            None,
        )?;
        if now.code != 0 || now.stdout.trim() != expected {
            return Err(GitError::Invalid("The stash list changed. Reload.".into()));
        }
    }
    op(git, repo, &["stash", verb, &sel], None, conflictable)
}

pub fn stash_apply(
    git: &Git,
    repo: &RepoInfo,
    index: u32,
    oid: Option<&str>,
) -> Result<OpResult, GitError> {
    stash_op(git, repo, "apply", index, oid, true)
}

pub fn stash_pop(
    git: &Git,
    repo: &RepoInfo,
    index: u32,
    oid: Option<&str>,
) -> Result<OpResult, GitError> {
    stash_op(git, repo, "pop", index, oid, true)
}

pub fn stash_drop(
    git: &Git,
    repo: &RepoInfo,
    index: u32,
    oid: Option<&str>,
) -> Result<OpResult, GitError> {
    stash_op(git, repo, "drop", index, oid, false)
}

/// Annotated (`-a -m`) when `message` is given, lightweight otherwise. An empty `target` means HEAD.
pub fn tag_create(
    git: &Git,
    repo: &RepoInfo,
    name: &str,
    target: &str,
    message: Option<&str>,
) -> Result<OpResult, GitError> {
    check_name("tag name", name)?;
    check_name("target", target)?;
    let mut args = vec!["tag"];
    if let Some(m) = message.filter(|m| !m.is_empty()) {
        args.extend(["-a", name, "-m", m]);
    } else {
        args.push(name);
    }
    if !target.is_empty() {
        args.push(target);
    }
    op(git, repo, &args, None, false)
}

pub fn tag_delete(git: &Git, repo: &RepoInfo, name: &str) -> Result<OpResult, GitError> {
    check_name("tag name", name)?;
    op(git, repo, &["tag", "-d", name], None, false)
}
