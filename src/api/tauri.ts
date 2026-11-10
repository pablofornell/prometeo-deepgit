/**
 * Typed wrappers for every Tauri command of docs/PLAN.md section 5, plus the two backend events.
 * Names are the camelCase of the Rust command (`log_open` -> `logOpen`); arguments are positional and
 * are sent as an object with camelCase keys (Tauri maps them to the snake_case Rust parameters).
 *
 * - Outside Tauri (a plain browser, `npm run dev`) every call is routed to the fake backend in `./mock`.
 * - Any rejection is normalised to an `ApiError { message, detail? }`; `await` + `try/catch` is enough:
 *
 *     try { await api.checkout(repoId, "main", null); }
 *     catch (e) { const err = toApiError(e); toast({ kind: "error", title: err.message }); }
 *
 * Feature code normally does not call this file for writes: use `src/state/actions.ts`, which adds
 * toasts, conflict handling and multi-repo fan-out.
 */
import type {
  ApiErrorShape, CommitDetails, ConsoleEntry, DiffSpec, FileDiff, LogQuery, LogSessionInfo, OpResult, Project,
  CommitRow, HunkOpts, RepoChanged, RepoSummary, Refs, ResetMode, Workspace, WorkingTree,
} from "./types";

/** True when running inside the Tauri webview (false in a plain browser). */
export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Error thrown by every wrapper. `message` is user-presentable; `detail` is git's stderr. */
export class ApiError extends Error implements ApiErrorShape {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.detail = detail;
  }
}

/** Converts anything a rejected promise can carry (string, Error, `{message, detail}`) to an `ApiError`. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (typeof e === "string") return new ApiError(e);
  if (e instanceof Error) return new ApiError(e.message);
  if (typeof e === "object" && e !== null) {
    const o = e as { message?: unknown; detail?: unknown };
    const message = typeof o.message === "string" ? o.message : JSON.stringify(e);
    return new ApiError(message, typeof o.detail === "string" ? o.detail : undefined);
  }
  return new ApiError(String(e));
}

type Args = Record<string, unknown>;

async function invoke<T>(cmd: string, args?: Args): Promise<T> {
  try {
    if (isTauri()) {
      const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
      return await tauriInvoke<T>(cmd, args);
    }
    const { mockInvoke } = await import("./mock");
    return (await mockInvoke(cmd, args ?? {})) as T;
  } catch (e) {
    throw toApiError(e);
  }
}

// ---------------------------------------------------------------- 5.1 workspace

export const workspaceLoad = () => invoke<Workspace>("workspace_load");
export const workspaceSaveUi = (ui: unknown) => invoke<void>("workspace_save_ui", { ui });
/** Adds a folder as a project; the backend discovers its repositories. */
export const projectAdd = (path: string) => invoke<Project>("project_add", { path });
export const projectRemove = (projectId: string) => invoke<void>("project_remove", { projectId });
export const projectRescan = (projectId: string) => invoke<Project>("project_rescan", { projectId });
export const projectSetActive = (projectId: string) => invoke<void>("project_set_active", { projectId });
export const repoSummaries = (repoIds: string[]) => invoke<RepoSummary[]>("repo_summaries", { repoIds });

// ---------------------------------------------------------------- 5.2 log sessions

export const logOpen = (query: LogQuery) => invoke<LogSessionInfo>("log_open", { query });
export const logRows = (sessionId: number, start: number, count: number) => invoke<CommitRow[]>("log_rows", { sessionId, start, count });
/**
 * Index of the commit with this oid (prefix ok) in the session, or null. Pass `repoId` to match only that repo's
 * commit (the same oid can appear in several repos of a combined log).
 */
export const logFind = (sessionId: number, oid: string, repoId?: string) =>
  invoke<number | null>("log_find", { sessionId, oid, ...(repoId === undefined ? {} : { repoId }) });
export const logClose = (sessionId: number) => invoke<void>("log_close", { sessionId });

// ---------------------------------------------------------------- 5.3 read

export const refs = (repoId: string) => invoke<Refs>("refs", { repoId });
export const commitDetails = (repoId: string, oid: string) => invoke<CommitDetails>("commit_details", { repoId, oid });
/** Local and remote branch names that contain the commit. */
export const branchesContaining = (repoId: string, oid: string) => invoke<string[]>("branches_containing", { repoId, oid });
export const workingTree = (repoId: string) => invoke<WorkingTree>("working_tree", { repoId });
export const fileDiff = (repoId: string, spec: DiffSpec, path: string, oldPath: string | null = null, context = 3) =>
  invoke<FileDiff>("file_diff", { repoId, spec, path, oldPath, context });
/** File content at `rev`, or the worktree file when `rev` is null (max 2 MiB). */
export const fileContent = (repoId: string, rev: string | null, path: string) => invoke<string>("file_content", { repoId, rev, path });
export const lastCommitMessage = (repoId: string) => invoke<string>("last_commit_message", { repoId });

// ---------------------------------------------------------------- 5.4 write (each emits repo-changed)

export const stage = (repoId: string, paths: string[]) => invoke<void>("stage", { repoId, paths });
export const unstage = (repoId: string, paths: string[]) => invoke<void>("unstage", { repoId, paths });
/** Discards worktree changes; for an untracked file this deletes it. */
export const discard = (repoId: string, paths: string[]) => invoke<void>("discard", { repoId, paths });
/** Safety fields of the hunk commands; a field that is undefined is left out of the args. */
function hunkArgs(o: HunkOpts): Args {
  const out: Args = {};
  if (o.oldPath !== undefined) out.oldPath = o.oldPath;
  if (o.expected !== undefined) out.expected = o.expected;
  if (o.context !== undefined) out.context = o.context;
  return out;
}
/** `reverse = true` unstages the hunk. */
export const stageHunk = (repoId: string, path: string, hunkIndex: number, reverse = false, opts: HunkOpts = {}) =>
  invoke<void>("stage_hunk", { repoId, path, hunkIndex, reverse, ...hunkArgs(opts) });
export const discardHunk = (repoId: string, path: string, hunkIndex: number, opts: HunkOpts = {}) =>
  invoke<void>("discard_hunk", { repoId, path, hunkIndex, ...hunkArgs(opts) });
export const commit = (repoId: string, message: string, amend = false) => invoke<OpResult>("commit", { repoId, message, amend });
/** A remote branch target + `newBranch` creates a tracking branch. */
export const checkout = (repoId: string, target: string, newBranch: string | null = null) => invoke<OpResult>("checkout", { repoId, target, newBranch });
export const branchCreate = (repoId: string, name: string, startPoint: string, checkout: boolean) =>
  invoke<OpResult>("branch_create", { repoId, name, startPoint, checkout });
/** `remote = true` deletes the branch on the remote (`push <remote> --delete`); `name` must then be `"<remote>/<branch>"`. */
export const branchDelete = (repoId: string, name: string, force = false, remote = false) =>
  invoke<OpResult>("branch_delete", { repoId, name, force, remote });
export const branchRename = (repoId: string, oldName: string, newName: string) => invoke<OpResult>("branch_rename", { repoId, oldName, newName });
export const merge = (repoId: string, target: string, noFf = false, squash = false) => invoke<OpResult>("merge", { repoId, target, noFf, squash });
export const rebase = (repoId: string, onto: string) => invoke<OpResult>("rebase", { repoId, onto });
export const cherryPick = (repoId: string, oids: string[]) => invoke<OpResult>("cherry_pick", { repoId, oids });
export const revert = (repoId: string, oid: string) => invoke<OpResult>("revert", { repoId, oid });
export const reset = (repoId: string, target: string, mode: ResetMode) => invoke<OpResult>("reset", { repoId, target, mode });
/** Acts on the detected in-progress operation (merge, rebase, cherry-pick, revert). */
export const opContinue = (repoId: string) => invoke<OpResult>("op_continue", { repoId });
export const opAbort = (repoId: string) => invoke<OpResult>("op_abort", { repoId });
export const opSkip = (repoId: string) => invoke<OpResult>("op_skip", { repoId });
/** `remote = null` fetches all remotes. */
export const fetch = (repoId: string, remote: string | null = null, prune = false) => invoke<OpResult>("fetch", { repoId, remote, prune });
export const pull = (repoId: string, rebase = false) => invoke<OpResult>("pull", { repoId, rebase });
/** `force` means `--force-with-lease`. */
export const push = (repoId: string, opts: { remote?: string | null; branch?: string | null; force?: boolean; setUpstream?: boolean; tags?: boolean } = {}) =>
  invoke<OpResult>("push", {
    repoId, remote: opts.remote ?? null, branch: opts.branch ?? null,
    force: opts.force ?? false, setUpstream: opts.setUpstream ?? false, tags: opts.tags ?? false,
  });
export const stashSave = (repoId: string, message: string | null = null, includeUntracked = false, keepIndex = false) =>
  invoke<OpResult>("stash_save", { repoId, message, includeUntracked, keepIndex });
/** `oid` is the stash the user sees; the backend refuses to act when the stash list has moved on. */
export const stashApply = (repoId: string, index: number, oid?: string) =>
  invoke<OpResult>("stash_apply", { repoId, index, ...(oid === undefined ? {} : { oid }) });
export const stashPop = (repoId: string, index: number, oid?: string) =>
  invoke<OpResult>("stash_pop", { repoId, index, ...(oid === undefined ? {} : { oid }) });
export const stashDrop = (repoId: string, index: number, oid?: string) =>
  invoke<OpResult>("stash_drop", { repoId, index, ...(oid === undefined ? {} : { oid }) });
export const tagCreate = (repoId: string, name: string, target: string, message: string | null = null) =>
  invoke<OpResult>("tag_create", { repoId, name, target, message });
export const tagDelete = (repoId: string, name: string) => invoke<OpResult>("tag_delete", { repoId, name });

// ---------------------------------------------------------------- 5.5 events

async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (isTauri()) {
    const { listen: tauriListen } = await import("@tauri-apps/api/event");
    return tauriListen<T>(event, (e) => cb(e.payload));
  }
  const { mockListen } = await import("./mock");
  return mockListen(event, (p) => cb(p as T));
}

/** Every git call (user actions and background reads). Prefer `state/console.ts`, which subscribes once. */
export const onGitConsole = (cb: (entry: ConsoleEntry) => void) => listen<ConsoleEntry>("git-console", cb);
/** A repository changed on disk or through a write command (debounced by the backend). */
export const onRepoChanged = (cb: (e: RepoChanged) => void) => listen<RepoChanged>("repo-changed", cb);
