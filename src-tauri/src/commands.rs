//! `#[tauri::command]` wrappers (PLAN.md section 5). Every command is async; gitcore is blocking,
//! so each call runs in `spawn_blocking`. Write commands hold the per-repo lock and emit
//! `repo-changed` afterwards, whether the call succeeded or not.

use std::sync::Arc;

use gitcore::{
    clone as gitclone, diff, log, ops, refs as gitrefs, status, ApiError, CloneOpts, CloneProgress,
    CloneResult, CloneTarget, CommitDetails, CommitRow, DiffSpec, FileDiff, Git, HunkRef, LogQuery,
    LogSessionInfo, MergeOpts, OpResult, Project, Refs, RepoChanged, RepoInfo, RepoSummary,
    ResetMode, WorkingTree, Workspace,
};
use gitcore::{AuthMode, GitError};
use tauri::{AppHandle, Emitter, State};

use crate::state::{api_error, lock, AppState};

type St<'a> = State<'a, Arc<AppState>>;
type Res<T> = Result<T, ApiError>;

/// Runs a blocking closure off the async runtime.
async fn blocking<T, F>(f: F) -> Res<T>
where
    T: Send + 'static,
    F: FnOnce() -> Res<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| api_error(format!("background task failed: {e}")))?
}

/// A read-only gitcore call on one repo.
async fn read<T, F>(state: &AppState, repo_id: &str, f: F) -> Res<T>
where
    T: Send + 'static,
    F: FnOnce(&Git, &RepoInfo) -> Result<T, GitError> + Send + 'static,
{
    let repo = state.repo(repo_id)?;
    let git = state.git.clone();
    blocking(move || f(&git, &repo).map_err(ApiError::from)).await
}

/// A mutating gitcore call: serialized per repo, followed by `repo-changed`.
async fn write<T, F>(app: &AppHandle, state: &AppState, repo_id: &str, f: F) -> Res<T>
where
    T: Send + 'static,
    F: FnOnce(&Git, &RepoInfo) -> Result<T, GitError> + Send + 'static,
{
    let repo = state.repo(repo_id)?;
    let git = state.git.clone();
    let _guard = state.repo_lock(repo_id).lock_owned().await;
    let result = blocking(move || f(&git, &repo).map_err(ApiError::from)).await;
    let _ = app.emit(
        "repo-changed",
        RepoChanged {
            repo_id: repo_id.to_string(),
        },
    );
    result
}

// ------------------------------------------------------------------ workspace

#[tauri::command]
pub async fn workspace_load(state: St<'_>) -> Res<Workspace> {
    Ok(state.workspace_snapshot())
}

#[tauri::command]
pub async fn workspace_save_ui(state: St<'_>, ui: serde_json::Value) -> Res<()> {
    let st = state.inner().clone();
    blocking(move || st.save_ui(ui)).await
}

#[tauri::command]
pub async fn project_add(state: St<'_>, path: String) -> Res<Project> {
    let st = state.inner().clone();
    blocking(move || st.add_project(&path)).await
}

#[tauri::command]
pub async fn project_remove(state: St<'_>, project_id: String) -> Res<()> {
    let st = state.inner().clone();
    blocking(move || st.remove_project(&project_id)).await
}

#[tauri::command]
pub async fn project_rescan(state: St<'_>, project_id: String) -> Res<Project> {
    let st = state.inner().clone();
    blocking(move || st.rescan_project(&project_id)).await
}

#[tauri::command]
pub async fn project_set_active(state: St<'_>, project_id: String) -> Res<()> {
    let st = state.inner().clone();
    blocking(move || st.set_active_project(&project_id)).await
}

/// Sets a repo colour: `color` is a palette index, `custom` a `#RRGGBB` string; neither means Auto.
#[tauri::command]
pub async fn repo_set_color(
    state: St<'_>,
    repo_id: String,
    color: Option<u8>,
    custom: Option<String>,
) -> Res<RepoInfo> {
    let st = state.inner().clone();
    blocking(move || st.set_repo_color(&repo_id, color, custom.as_deref())).await
}

/// Same as `repo_set_color` for a project.
#[tauri::command]
pub async fn project_set_color(
    state: St<'_>,
    project_id: String,
    color: Option<u8>,
    custom: Option<String>,
) -> Res<Project> {
    let st = state.inner().clone();
    blocking(move || st.set_project_color(&project_id, color, custom.as_deref())).await
}

/// Summaries of the given repos, computed in parallel. A repo whose summary fails (for example
/// its folder was deleted) is left out and logged, so one broken repo does not blank the UI.
#[tauri::command]
pub async fn repo_summaries(state: St<'_>, repo_ids: Vec<String>) -> Res<Vec<RepoSummary>> {
    let repos = repo_ids
        .iter()
        .map(|id| state.repo(id))
        .collect::<Res<Vec<_>>>()?;
    let git = state.git.clone();
    blocking(move || {
        let results: Vec<Option<RepoSummary>> = std::thread::scope(|s| {
            let handles: Vec<_> = repos
                .iter()
                .map(|r| {
                    let git = &git;
                    s.spawn(move || match gitrefs::repo_summary(git, r) {
                        Ok(sum) => Some(sum),
                        Err(e) => {
                            tracing::warn!("summary of {} failed: {e}", r.name);
                            None
                        }
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or(None))
                .collect()
        });
        Ok(results.into_iter().flatten().collect())
    })
    .await
}

// ------------------------------------------------------------------ log sessions

#[tauri::command]
pub async fn log_open(state: St<'_>, query: LogQuery) -> Res<LogSessionInfo> {
    if query.repo_ids.is_empty() {
        return Err(api_error("no repository selected"));
    }
    let repos = query
        .repo_ids
        .iter()
        .map(|id| state.repo(id))
        .collect::<Res<Vec<_>>>()?;
    let st = state.inner().clone();
    blocking(move || {
        let (rows, max_lanes, truncated, skipped) = log::load(&st.git, &repos, &query)?;
        Ok(lock(&st.sessions).open(rows, max_lanes, truncated, skipped))
    })
    .await
}

#[tauri::command]
pub async fn log_rows(
    state: St<'_>,
    session_id: u64,
    start: u32,
    count: u32,
) -> Res<Vec<CommitRow>> {
    let session = lock(&state.sessions)
        .get(session_id)
        .ok_or_else(|| api_error("unknown log session"))?;
    Ok(session.range(start, count))
}

#[tauri::command]
pub async fn log_find(
    state: St<'_>,
    session_id: u64,
    oid: String,
    repo_id: Option<String>,
) -> Res<Option<u32>> {
    let session = lock(&state.sessions)
        .get(session_id)
        .ok_or_else(|| api_error("unknown log session"))?;
    Ok(session.find(&oid, repo_id.as_deref()))
}

#[tauri::command]
pub async fn log_close(state: St<'_>, session_id: u64) -> Res<()> {
    lock(&state.sessions).close(session_id);
    Ok(())
}

// ------------------------------------------------------------------ read

#[tauri::command]
pub async fn refs(state: St<'_>, repo_id: String) -> Res<Refs> {
    read(&state, &repo_id, gitrefs::read_refs).await
}

#[tauri::command]
pub async fn commit_details(state: St<'_>, repo_id: String, oid: String) -> Res<CommitDetails> {
    read(&state, &repo_id, move |g, r| {
        diff::commit_details(g, r, &oid)
    })
    .await
}

#[tauri::command]
pub async fn branches_containing(state: St<'_>, repo_id: String, oid: String) -> Res<Vec<String>> {
    read(&state, &repo_id, move |g, r| {
        gitrefs::branches_containing(g, r, &oid)
    })
    .await
}

#[tauri::command]
pub async fn working_tree(state: St<'_>, repo_id: String) -> Res<WorkingTree> {
    read(&state, &repo_id, status::working_tree).await
}

#[tauri::command]
pub async fn file_diff(
    state: St<'_>,
    repo_id: String,
    spec: DiffSpec,
    path: String,
    old_path: Option<String>,
    context: u32,
) -> Res<FileDiff> {
    read(&state, &repo_id, move |g, r| {
        diff::file_diff(g, r, &spec, &path, old_path.as_deref(), context)
    })
    .await
}

#[tauri::command]
pub async fn file_content(
    state: St<'_>,
    repo_id: String,
    rev: Option<String>,
    path: String,
) -> Res<String> {
    read(&state, &repo_id, move |g, r| {
        diff::file_content(g, r, rev.as_deref(), &path)
    })
    .await
}

#[tauri::command]
pub async fn last_commit_message(state: St<'_>, repo_id: String) -> Res<String> {
    read(&state, &repo_id, diff::last_commit_message).await
}

// ------------------------------------------------------------------ write: index and worktree

#[tauri::command]
pub async fn stage(app: AppHandle, state: St<'_>, repo_id: String, paths: Vec<String>) -> Res<()> {
    write(&app, &state, &repo_id, move |g, r| ops::stage(g, r, &paths)).await
}

#[tauri::command]
pub async fn unstage(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    paths: Vec<String>,
) -> Res<()> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::unstage(g, r, &paths)
    })
    .await
}

#[tauri::command]
pub async fn discard(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    paths: Vec<String>,
) -> Res<()> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::discard(g, r, &paths)
    })
    .await
}

/// JS: `{ repoId, path, hunkIndex, reverse, oldPath?, expected?, context? }`. `expected` (the
/// `{ oldStart, oldLines, newStart, newLines, hash? }` of the hunk the user saw; `hash` is the
/// FNV-1a body hash of `gitcore::hunk_hash`) selects the hunk and makes the call fail when the
/// file changed; `context` is the context of the diff shown (3 when
/// absent); `oldPath` is the old path of a staged rename.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn stage_hunk(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    path: String,
    hunk_index: u32,
    reverse: bool,
    old_path: Option<String>,
    expected: Option<HunkRef>,
    context: Option<u32>,
) -> Res<()> {
    write(&app, &state, &repo_id, move |g, r| {
        let opts = ops::HunkOpts {
            old_path: old_path.as_deref(),
            expected,
            context,
        };
        ops::stage_hunk(g, r, &path, hunk_index, reverse, &opts)
    })
    .await
}

/// JS: `{ repoId, path, hunkIndex, expected?, context? }` (see `stage_hunk`).
#[tauri::command]
pub async fn discard_hunk(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    path: String,
    hunk_index: u32,
    expected: Option<HunkRef>,
    context: Option<u32>,
) -> Res<()> {
    write(&app, &state, &repo_id, move |g, r| {
        let opts = ops::HunkOpts {
            old_path: None,
            expected,
            context,
        };
        ops::discard_hunk(g, r, &path, hunk_index, &opts)
    })
    .await
}

// ------------------------------------------------------------------ write: commits and branches

#[tauri::command]
pub async fn commit(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    message: String,
    amend: bool,
    sign_off: bool,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::commit(g, r, &message, amend, sign_off)
    })
    .await
}

#[tauri::command]
pub async fn checkout(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    target: String,
    new_branch: Option<String>,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::checkout(g, r, &target, new_branch.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn branch_create(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    name: String,
    start_point: String,
    checkout: bool,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::branch_create(g, r, &name, &start_point, checkout)
    })
    .await
}

#[tauri::command]
pub async fn branch_delete(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    name: String,
    force: bool,
    remote: bool,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::branch_delete(g, r, &name, force, remote)
    })
    .await
}

/// JS: `{ repoId, oldName, newName }` (PLAN.md calls them `old` / `new`, which are awkward names).
#[tauri::command]
pub async fn branch_rename(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    old_name: String,
    new_name: String,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::branch_rename(g, r, &old_name, &new_name)
    })
    .await
}

#[tauri::command]
pub async fn merge(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    target: String,
    opts: MergeOpts,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::merge(g, r, &target, &opts)
    })
    .await
}

#[tauri::command]
pub async fn rebase(app: AppHandle, state: St<'_>, repo_id: String, onto: String) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| ops::rebase(g, r, &onto)).await
}

#[tauri::command]
pub async fn cherry_pick(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    oids: Vec<String>,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::cherry_pick(g, r, &oids)
    })
    .await
}

#[tauri::command]
pub async fn revert(app: AppHandle, state: St<'_>, repo_id: String, oid: String) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| ops::revert(g, r, &oid)).await
}

#[tauri::command]
pub async fn reset(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    target: String,
    mode: ResetMode,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::reset(g, r, &target, mode)
    })
    .await
}

#[tauri::command]
pub async fn op_continue(app: AppHandle, state: St<'_>, repo_id: String) -> Res<OpResult> {
    write(&app, &state, &repo_id, ops::op_continue).await
}

#[tauri::command]
pub async fn op_abort(app: AppHandle, state: St<'_>, repo_id: String) -> Res<OpResult> {
    write(&app, &state, &repo_id, ops::op_abort).await
}

#[tauri::command]
pub async fn op_skip(app: AppHandle, state: St<'_>, repo_id: String) -> Res<OpResult> {
    write(&app, &state, &repo_id, ops::op_skip).await
}

// ------------------------------------------------------------------ write: remotes

/// `background` marks the auto-fetch: it never opens a login dialog (saved credentials only, it
/// fails fast otherwise). A fetch the user starts leaves it out.
#[tauri::command]
pub async fn fetch(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    remote: Option<String>,
    prune: bool,
    background: Option<bool>,
) -> Res<OpResult> {
    let background = background.unwrap_or(false);
    write(&app, &state, &repo_id, move |g, r| {
        if background {
            let silent = g.clone().with_auth_mode(AuthMode::Silent);
            ops::fetch(&silent, r, remote.as_deref(), prune)
        } else {
            ops::fetch(g, r, remote.as_deref(), prune)
        }
    })
    .await
}

#[tauri::command]
pub async fn pull(app: AppHandle, state: St<'_>, repo_id: String, rebase: bool) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| ops::pull(g, r, rebase)).await
}

// Mirrors the PLAN.md argument list.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn push(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    remote: Option<String>,
    branch: Option<String>,
    force: bool,
    set_upstream: bool,
    tags: bool,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::push(
            g,
            r,
            remote.as_deref(),
            branch.as_deref(),
            force,
            set_upstream,
            tags,
        )
    })
    .await
}

// ------------------------------------------------------------------ write: stash and tags

#[tauri::command]
pub async fn stash_save(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::stash_save(g, r, message.as_deref(), include_untracked, keep_index)
    })
    .await
}

/// JS: `{ repoId, index, oid? }`; with `oid` (the stash commit the UI listed) the call fails when
/// `stash@{index}` is a different commit by now. Same for `stash_pop` and `stash_drop`.
#[tauri::command]
pub async fn stash_apply(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    index: u32,
    oid: Option<String>,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::stash_apply(g, r, index, oid.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn stash_pop(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    index: u32,
    oid: Option<String>,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::stash_pop(g, r, index, oid.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn stash_drop(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    index: u32,
    oid: Option<String>,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::stash_drop(g, r, index, oid.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn tag_create(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    name: String,
    target: String,
    message: Option<String>,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::tag_create(g, r, &name, &target, message.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn tag_delete(
    app: AppHandle,
    state: St<'_>,
    repo_id: String,
    name: String,
) -> Res<OpResult> {
    write(&app, &state, &repo_id, move |g, r| {
        ops::tag_delete(g, r, &name)
    })
    .await
}

// ------------------------------------------------------------------ clone

/// Payload of the `clone-progress` event.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CloneProgressEvent {
    operation_id: String,
    #[serde(flatten)]
    progress: CloneProgress,
}

/// JS: `{ operationId, url, parentDir, dirName, opts, target }`. Clones into `parentDir/dirName`,
/// emits `clone-progress` events tagged with `operationId`, then adds the new repository to the
/// project (`target`). `clone_cancel` with the same id stops it. A failed or cancelled clone
/// leaves nothing behind.
// Mirrors the PLAN.md argument list.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn clone_repo(
    app: AppHandle,
    state: St<'_>,
    operation_id: String,
    url: String,
    parent_dir: String,
    dir_name: String,
    opts: CloneOpts,
    target: CloneTarget,
) -> Res<CloneResult> {
    let cancel = state.begin_clone(&operation_id)?;
    let st = state.inner().clone();
    let id = operation_id.clone();
    let result = blocking(move || {
        let plan =
            gitclone::plan_clone(&url, &parent_dir, &dir_name, &opts).map_err(ApiError::from)?;
        st.check_clone_target(&plan.parent, &target)?;
        let sink: gitclone::ProgressSink = Arc::new(move |progress| {
            let _ = app.emit(
                "clone-progress",
                CloneProgressEvent {
                    operation_id: id.clone(),
                    progress,
                },
            );
        });
        let path =
            gitclone::run_clone(&st.git, &plan, &opts, &cancel, sink).map_err(ApiError::from)?;
        st.add_cloned(&path, &target)
    })
    .await;
    state.end_clone(&operation_id);
    result
}

/// Stops the clone with this operation id. Does nothing when it has finished already.
#[tauri::command]
pub async fn clone_cancel(state: St<'_>, operation_id: String) -> Res<()> {
    state.cancel_clone(&operation_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend sends `expected` in camelCase; the optional hunk parameters can be absent.
    #[test]
    fn hunk_ref_is_camel_case_json() {
        let v = serde_json::json!({ "oldStart": 5, "oldLines": 0, "newStart": 6, "newLines": 2 });
        let h: HunkRef = serde_json::from_value(v).unwrap();
        assert_eq!(
            h,
            HunkRef {
                old_start: 5,
                old_lines: 0,
                new_start: 6,
                new_lines: 2,
                hash: None
            }
        );
        let back = serde_json::to_value(&h).unwrap();
        assert_eq!(back["oldStart"], 5);
        assert!(back.get("hash").is_none());
        let v = serde_json::json!({ "oldStart": 5, "oldLines": 0, "newStart": 6, "newLines": 2, "hash": "107351ed" });
        let h: HunkRef = serde_json::from_value(v).unwrap();
        assert_eq!(h.hash.as_deref(), Some("107351ed"));
        let none: Option<HunkRef> = serde_json::from_value(serde_json::Value::Null).unwrap();
        assert!(none.is_none());
    }
}
