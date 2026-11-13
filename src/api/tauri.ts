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
  ApiErrorShape, AuthNotice, AuthPrompt, CloneOpts, CloneProgress, CloneResult, CloneTarget, CommitDetails, ConflictEntry, ConflictSide, ConflictVersions,
  ConsoleEntry, DiffSpec, ExpectedOids, FileDiff, FileList, LogQuery, LogSessionInfo, MergeOpts, OpResult, Project, CommitRow, HunkOpts, RepoChanged, RepoSummary, Refs,
  ResetMode, SearchResult, StashUntracked, TextFile, Workspace, WorkingTree,
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
/** Renames a project (trimmed; refused: empty, over 80 characters, control characters, another project's name). The id stays. */
export const projectRename = (projectId: string, name: string) => invoke<Project>("project_rename", { projectId, name });
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
/** Untracked files of a stash; null when the stash has none (made without `-u`). */
export const stashUntracked = (repoId: string, oid: string) => invoke<StashUntracked | null>("stash_untracked", { repoId, oid });
/** Local and remote branch names that contain the commit. */
export const branchesContaining = (repoId: string, oid: string) => invoke<string[]>("branches_containing", { repoId, oid });
export const workingTree = (repoId: string) => invoke<WorkingTree>("working_tree", { repoId });
export const fileDiff = (repoId: string, spec: DiffSpec, path: string, oldPath: string | null = null, context = 3) =>
  invoke<FileDiff>("file_diff", { repoId, spec, path, oldPath, context });
/** File content at `rev`, or the worktree file when `rev` is null (max 2 MiB). */
export const fileContent = (repoId: string, rev: string | null, path: string) => invoke<string>("file_content", { repoId, rev, path });
export const lastCommitMessage = (repoId: string) => invoke<string>("last_commit_message", { repoId });
/** Tracked and untracked files of the worktree, without the ignored ones (those come apart in `ignored`). Sorted by path. */
export const listFiles = (repoId: string) => invoke<FileList>("list_files", { repoId });
/** A worktree file as text (2 MiB at most). Binary and too large files give empty content and a flag. */
export const readTextFile = (repoId: string, path: string) => invoke<TextFile>("read_text_file", { repoId, path });
/** Searches the tracked and untracked files that are not ignored. Hits are capped at 2 000. */
export const searchFiles = (repoId: string, query: string, opts: { caseSensitive: boolean; regex: boolean }) =>
  invoke<SearchResult>("search_files", { repoId, query, caseSensitive: opts.caseSensitive, regex: opts.regex });

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
/**
 * Saves a worktree file with `content` as it is (line ends unchanged). `expectedVersion` is the version that
 * `readTextFile` returned. The save is refused when the file changed since. Null skips that check.
 * Returns the new version.
 */
export const writeTextFile = (repoId: string, path: string, content: string, expectedVersion: string | null) =>
  invoke<string>("write_text_file", { repoId, path, content, expectedVersion });
/** `signOff` adds a `Signed-off-by` trailer (`--signoff`); the backend does not add it twice. */
export const commit = (repoId: string, message: string, amend = false, signOff = false) =>
  invoke<OpResult>("commit", { repoId, message, amend, signOff });
/** A remote branch target + `newBranch` creates a tracking branch. */
export const checkout = (repoId: string, target: string, newBranch: string | null = null) => invoke<OpResult>("checkout", { repoId, target, newBranch });
export const branchCreate = (repoId: string, name: string, startPoint: string, checkout: boolean) =>
  invoke<OpResult>("branch_create", { repoId, name, startPoint, checkout });
/** `remote = true` deletes the branch on the remote (`push <remote> --delete`); `name` must then be `"<remote>/<branch>"`. */
export const branchDelete = (repoId: string, name: string, force = false, remote = false) =>
  invoke<OpResult>("branch_delete", { repoId, name, force, remote });
export const branchRename = (repoId: string, oldName: string, newName: string) => invoke<OpResult>("branch_rename", { repoId, oldName, newName });
export const DEFAULT_MERGE_OPTS: MergeOpts = { mode: "ff", message: null, noCommit: false, allowUnrelatedHistories: false };
export const merge = (repoId: string, target: string, opts: Partial<MergeOpts> = {}) =>
  invoke<OpResult>("merge", { repoId, target, opts: { ...DEFAULT_MERGE_OPTS, ...opts } });
export const rebase = (repoId: string, onto: string) => invoke<OpResult>("rebase", { repoId, onto });
export const cherryPick = (repoId: string, oids: string[]) => invoke<OpResult>("cherry_pick", { repoId, oids });
export const revert = (repoId: string, oid: string) => invoke<OpResult>("revert", { repoId, oid });
export const reset = (repoId: string, target: string, mode: ResetMode) => invoke<OpResult>("reset", { repoId, target, mode });
/** Acts on the detected in-progress operation (merge, rebase, cherry-pick, revert). */
export const opContinue = (repoId: string) => invoke<OpResult>("op_continue", { repoId });
export const opAbort = (repoId: string) => invoke<OpResult>("op_abort", { repoId });
export const opSkip = (repoId: string) => invoke<OpResult>("op_skip", { repoId });
/**
 * `remote = null` fetches all remotes. `background` (the auto-fetch) never opens a login dialog: it uses saved
 * credentials or fails fast. A fetch the user starts leaves it false.
 */
export const fetch = (repoId: string, remote: string | null = null, prune = false, background = false) =>
  invoke<OpResult>("fetch", { repoId, remote, prune, background });
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

// ---------------------------------------------------------------- 5.7 clone

/**
 * Clones `url` into `parentDir/dirName`, then adds the repository to `target`. `operationId` ties the
 * `clone-progress` events and `cloneCancel` to this call. A failed or cancelled clone leaves nothing on disk.
 */
export const cloneRepo = (operationId: string, url: string, parentDir: string, dirName: string, opts: CloneOpts, target: CloneTarget) =>
  invoke<CloneResult>("clone_repo", { operationId, url, parentDir, dirName, opts, target });
/** Stops the clone with this id (no-op when it has finished). `cloneRepo` then rejects with "The operation was cancelled.". */
export const cloneCancel = (operationId: string) => invoke<void>("clone_cancel", { operationId });

// ---------------------------------------------------------------- 5.6 authentication

/**
 * Answers an `auth-prompt`. `answer = null` cancels it (Reject for a host key). `secondary` is the password of a
 * `withPassword` dialog. Resolves false when the prompt is gone (timed out, or its command ended).
 */
export const authReply = (id: number, answer: string | null, remember: boolean, secondary: string | null = null) =>
  invoke<boolean>("auth_reply", { id, answer, remember, secondary });
/** Tells the backend whether saved credentials may be read and offered (`settings.useCredentialStore`). */
export const setAuthPrefs = (useCredentialStore: boolean) => invoke<void>("set_auth_prefs", { useCredentialStore });
/** Forgets every credential DeepGit saved in the system key store. Resolves to how many entries were removed. */
export const credentialsClear = () => invoke<number>("credentials_clear");

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
/** git or ssh asks for a credential. Prefer `state/auth.ts`, which subscribes once and shows the dialog. */
export const onAuthPrompt = (cb: (p: AuthPrompt) => void) => listen<AuthPrompt>("auth-prompt", cb);
/** A question is gone (timeout, command ended): close its dialog. */
export const onAuthPromptClose = (cb: (e: { id: number }) => void) => listen<{ id: number }>("auth-prompt-close", cb);
export const onAuthNotice = (cb: (n: AuthNotice) => void) => listen<AuthNotice>("auth-notice", cb);
/** A repository changed on disk or through a write command (debounced by the backend). */
export const onRepoChanged = (cb: (e: RepoChanged) => void) => listen<RepoChanged>("repo-changed", cb);
/** Progress of a running `cloneRepo` (filter on `operationId`). */
export const onCloneProgress = (cb: (e: CloneProgress) => void) => listen<CloneProgress>("clone-progress", cb);

// ---------------------------------------------------------------- 5.8 merge conflicts

/** The unmerged files of a repo; `ours` / `theirs` are the user's view (swapped during a rebase). */
export const conflicts = (repoId: string) => invoke<ConflictEntry[]>("conflicts", { repoId });
/** Base, yours and theirs of one conflicted file with labels, the swap flag and the line ending. */
export const conflictVersions = (repoId: string, path: string) => invoke<ConflictVersions>("conflict_versions", { repoId, path });
/** Keeps one whole side of each path (`checkout --ours|--theirs` + `add`, or `rm` when that side deleted the file). Emits repo-changed. */
export const acceptSide = (repoId: string, paths: string[], side: ConflictSide) => invoke<void>("accept_side", { repoId, paths, side });
/**
 * Writes the merged text (LF line ends; the backend restores the file's line ending and mode). `resolved = true` stages it,
 * `false` only writes it (the file keeps conflict markers and stays unmerged). Refused when the file is no longer
 * conflicted or when any of the three versions (Yours, Theirs, base) is no longer the one in `expected`.
 */
export const saveResolution = (repoId: string, path: string, content: string, expected: ExpectedOids, resolved: boolean) =>
  invoke<void>("save_resolution", {
    repoId,
    path,
    content,
    expectedOursOid: expected.ours,
    expectedTheirsOid: expected.theirs,
    expectedBaseOid: expected.base,
    resolved,
  });
