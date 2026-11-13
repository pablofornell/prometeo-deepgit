/**
 * The single place for git actions used by menus, buttons and shortcuts everywhere.
 *
 *   await checkout(repoId, "main");                         // one repo
 *   await checkout(selectedRepoIds(), "feature/x", { branchOnly: true });   // many repos: parallel, summarised
 *   await createBranch([repoId], oid);                      // asks for the name via the "newBranch" dialog
 *   const r = await merge([repoId], "origin/main");         // r.ok / r.failed / r.skipped / r.conflicts
 *
 * Every action:
 *  - accepts one repo id or a list (runs at most 4 in parallel, shows a progress activity for 2+),
 *  - asks for input through `state/dialogs.ts` when it needs any (cancel = nothing happens, `cancelled: true`),
 *  - shows a toast: success ("Checked out in 2 repos", body "feature/x in api-gateway and ledger-service. 1 skipped."),
 *    warning for conflicts ("Open Local changes"), error with "Show in console",
 *  - skips repos where it does not apply (an operation in progress, branch missing...) instead of failing,
 *  - refreshes the summaries of the repos it touched,
 *  - resolves to a `BatchResult`; it never rejects.
 */
import { ApiError, toApiError } from "../api/tauri";
import * as api from "../api/tauri";
import type { CloneOpts, CloneProgress, CloneResult, ConflictSide, ExpectedOids, HunkOpts, OpResult } from "../api/types";
import { joinNames, plural, toast, type ToastAction } from "../components/ui";
import { beginActivity } from "./activity";
import { confirmAction, showDialog, type PushResult } from "./dialogs";
import { notifyRepoChanged } from "./events";
import { openBottomTool } from "./layout";
import { planPush } from "./pushPlan";
import { beginRepoOp } from "./repoBusy";
import { remoteCounterpart, splitRemoteRef } from "./remoteRefs";
import { cachedRefs, ensureRefs, hasLocalBranch, hasRemoteBranch, refreshRefs } from "./refs";
import { setChangesRepoId, setMainTab } from "./selection";
import { activeProject, adoptClonedProject, projectRepos, refreshSummaries, renameProject as saveProjectName, repoById, summary, workspace } from "./workspace";

// ---------------------------------------------------------------- result type

/** What an action did, per repo. */
export interface BatchResult {
  /** Repos where the operation succeeded. */
  ok: string[];
  /** Repos where it did not apply, with the reason. */
  skipped: { repoId: string; reason: string }[];
  /** Repos where git failed. */
  failed: { repoId: string; error: ApiError }[];
  /** Repos that stopped with merge/rebase conflicts (also reported by a warning toast). */
  conflicts: string[];
  /** The user closed the dialog: nothing ran. */
  cancelled: boolean;
  /** Raw results by repo id. */
  results: Record<string, OpResult | undefined>;
}

export type RepoIds = string | readonly string[];

const MAX_PARALLEL = 4;

const toIds = (r: RepoIds): string[] => [...new Set(typeof r === "string" ? [r] : r)];
const nameOf = (id: string): string => repoById(id)?.name ?? id;
const emptyResult = (cancelled = false): BatchResult => ({ ok: [], skipped: [], failed: [], conflicts: [], cancelled, results: {} });
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const showConsole: ToastAction = { label: "Show in console", onClick: () => openBottomTool("console") };

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function firstLine(s: string, max = 140): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// ---------------------------------------------------------------- the runner

interface RunSpec {
  /** Imperative verb, for failure titles: "check out" -> "Could not check out main". */
  verb: string;
  /** Past tense for the success title: "Checked out". */
  past: string;
  /** Subject shown in the title for one repo and in the body for many ("feature/x"). */
  what?: string;
  repoIds: string[];
  /** Return a reason to skip a repo. */
  skip?: (repoId: string) => string | null;
  run: (repoId: string) => Promise<OpResult | void>;
  /** No success toast (stage, unstage...). Errors and conflicts still show. */
  quiet?: boolean;
  /** Label of the progress activity (2+ repos). */
  progress?: string;
  /** Extra toast actions on success. */
  actions?: ToastAction[];
  /** Success body override. */
  body?: (r: BatchResult) => string | undefined;
  /** Background work: no progress activity and no toast at all (success, conflicts or errors); the caller reads the result. */
  silent?: boolean;
}

async function runBatch(spec: RunSpec): Promise<BatchResult> {
  const res = emptyResult();
  const todo: string[] = [];
  for (const id of spec.repoIds) {
    const reason = spec.skip?.(id) ?? null;
    if (reason) res.skipped.push({ repoId: id, reason });
    else todo.push(id);
  }
  const activity = todo.length > 1 && !spec.silent ? beginActivity(spec.progress ?? `${cap(spec.verb)} in ${todo.length} repositories`, todo.length) : null;
  await pool(todo, MAX_PARALLEL, async (id) => {
    const endOp = beginRepoOp(id);
    try {
      const r = await spec.run(id);
      res.results[id] = r ?? undefined;
      if (r && !r.ok && r.conflicts) res.conflicts.push(id);
      else if (r && !r.ok) res.failed.push({ repoId: id, error: new ApiError(r.message || `Could not ${spec.verb}`) });
      else res.ok.push(id);
    } catch (e) {
      res.failed.push({ repoId: id, error: toApiError(e) });
    } finally {
      endOp();
      activity?.step();
    }
  });
  activity?.end();

  const touched = [...res.ok, ...res.failed.map((f) => f.repoId), ...res.conflicts];
  for (const id of touched) {
    notifyRepoChanged(id);
    if (cachedRefs(id)) void refreshRefs(id);
  }
  if (touched.length > 0) void refreshSummaries(touched);
  if (!spec.silent) report(spec, res);
  return res;
}

function report(spec: RunSpec, res: BatchResult): void {
  const what = spec.what ? ` ${spec.what}` : "";
  // 1. conflicts: warning
  if (res.conflicts.length > 0) {
    const names = res.conflicts.map(nameOf);
    toast({
      kind: "warning",
      title: res.conflicts.length === 1 ? `Conflicts in ${names[0]}` : `Conflicts in ${res.conflicts.length} repos`,
      body: `${cap(spec.verb)}${what} stopped in ${joinNames(names)}. Resolve the conflicts in Local changes, then continue or abort.`,
      actions: [
        {
          label: "Open Local changes",
          onClick: () => {
            setChangesRepoId(res.conflicts[0]);
            setMainTab("changes");
          },
        },
        showConsole,
      ],
    });
  }
  // 2. failures: error toast
  if (res.failed.length > 0) {
    if (res.failed.length === 1) {
      const f = res.failed[0];
      const multi = spec.repoIds.length > 1;
      toast({
        kind: "error",
        title: f.error.message || `Could not ${spec.verb}${what}`,
        body: [multi ? nameOf(f.repoId) : "", f.error.detail ? firstLine(f.error.detail, 300) : ""].filter(Boolean).join(": ") || undefined,
        actions: [showConsole],
      });
    } else {
      toast({
        kind: "error",
        title: `Could not ${spec.verb}${what} in ${res.failed.length} repos`,
        body: res.failed.slice(0, 3).map((f) => `${nameOf(f.repoId)}: ${f.error.message}`).join("\n"),
        actions: [showConsole],
      });
    }
  }
  // 3. success
  if (res.ok.length > 0 && !spec.quiet) {
    const names = res.ok.map(nameOf);
    const extra = [res.skipped.length ? `${res.skipped.length} skipped.` : "", res.failed.length ? `${res.failed.length} failed.` : ""].filter(Boolean).join(" ");
    if (res.ok.length === 1 && spec.repoIds.length === 1) {
      const msg = firstLine(res.results[res.ok[0]]?.message ?? "");
      toast({ kind: "success", title: `${spec.past}${what}`, body: spec.body?.(res) ?? (msg || names[0]) });
    } else {
      toast({
        kind: "success",
        title: `${spec.past} in ${plural(res.ok.length, "repo")}`,
        body: spec.body?.(res) ?? `${spec.what ? spec.what + " in " : ""}${joinNames(names)}.${extra ? " " + extra : ""}`,
        actions: spec.actions ?? [showConsole],
      });
    }
  }
  // 4. nothing ran at all
  if (res.ok.length + res.failed.length + res.conflicts.length === 0 && res.skipped.length > 0 && !spec.quiet) {
    const reasons = [...new Set(res.skipped.map((s) => s.reason))];
    toast({
      kind: "info",
      title: `Nothing to ${spec.verb}${what}`,
      body: res.skipped.length === 1 ? `${nameOf(res.skipped[0].repoId)}: ${res.skipped[0].reason}` : `${res.skipped.length} repos skipped. ${reasons.slice(0, 2).join(". ")}.`,
    });
  }
}

// ---------------------------------------------------------------- skip rules

const busy = (id: string): string | null => {
  const s = summary(id);
  return s && s.state !== "clean" ? `${s.state === "cherryPicking" ? "cherry-pick" : s.state === "rebasing" ? "rebase" : s.state} in progress` : null;
};

/** Repos that have a local or remote branch with this (short) name. */
function hasBranchSomewhere(id: string, name: string): boolean {
  return hasLocalBranch(id, name) || hasRemoteBranch(id, name);
}

const currentBranch = (id: string): string => summary(id)?.branch ?? "HEAD";

/** `"<remote>/<branch>"` of the remote branch that goes with local branch `name` (see `remoteCounterpart`). */
const remoteBranchOf = (id: string, name: string): string | undefined => remoteCounterpart(cachedRefs(id), name);

// ---------------------------------------------------------------- checkout and branches

export interface CheckoutOptions {
  /** Create and check out this new branch at `target` (a remote branch target tracks it). */
  newBranch?: string | null;
  /**
   * `target` is a branch name that may exist in some repos only: each repo checks out its local branch, or
   * creates a tracking branch from `origin/<target>`, or is skipped (matrix "Checkout in 5 repos").
   */
  branchOnly?: boolean;
}

/** Checks out a branch, tag or commit in the given repos. */
export async function checkout(repoIds: RepoIds, target: string, opts: CheckoutOptions = {}): Promise<BatchResult> {
  const ids = toIds(repoIds);
  if (opts.branchOnly) await ensureRefs(ids);
  return runBatch({
    verb: "check out",
    past: "Checked out",
    what: target,
    repoIds: ids,
    skip: (id) => {
      const b = busy(id);
      if (b) return b;
      if (opts.branchOnly && !hasBranchSomewhere(id, target)) return `no branch ${target}`;
      return null;
    },
    run: (id) => {
      if (opts.branchOnly && !hasLocalBranch(id, target)) {
        const remote = cachedRefs(id)?.remote.find((r) => r.name === target || r.fullName === target);
        return api.checkout(id, remote?.fullName ?? target, target);
      }
      return api.checkout(id, target, opts.newBranch ?? null);
    },
  });
}

/** Double-click on a remote branch: asks for the local name ("checkoutRemote" dialog), then creates a tracking branch. */
export async function checkoutRemote(repoId: string, remoteBranch: string): Promise<BatchResult> {
  const r = await showDialog("checkoutRemote", { repoId, remoteBranch });
  if (!r) return emptyResult(true);
  return checkout(repoId, remoteBranch, { newBranch: r.localName });
}

export interface CreateBranchOptions {
  /** Skip the dialog and use this name. */
  name?: string;
  checkout?: boolean;
  /** Human text for the dialog ("api-gateway @ 9f3c2a1"). */
  startLabel?: string;
}

/** New branch at `startPoint` (branch, tag or oid). Asks for the name unless `opts.name` is given. */
export async function createBranch(repoIds: RepoIds, startPoint: string, opts: CreateBranchOptions = {}): Promise<BatchResult> {
  let ids = toIds(repoIds);
  let name = opts.name;
  let doCheckout = opts.checkout ?? true;
  if (!name) {
    const r = await showDialog("newBranch", { repoIds: ids, startPoint, startLabel: opts.startLabel });
    if (!r) return emptyResult(true);
    name = r.name;
    doCheckout = r.checkout;
    ids = r.repoIds.length > 0 ? r.repoIds : ids;
  }
  const branch = name;
  return runBatch({
    verb: "create branch",
    past: doCheckout ? "Created and checked out" : "Created branch",
    what: branch,
    repoIds: ids,
    skip: busy,
    run: (id) => api.branchCreate(id, branch, startPoint, doCheckout),
  });
}

export interface DeleteBranchOptions {
  /** Also delete the remote branch. */
  remote?: boolean;
  force?: boolean;
  /** Skip the confirmation (default: ask). */
  confirm?: boolean;
}

/** Deletes a local branch (and optionally the remote one) after a confirmation. */
export async function deleteBranch(repoIds: RepoIds, name: string, opts: DeleteBranchOptions = {}): Promise<BatchResult> {
  const ids = toIds(repoIds);
  let remote = opts.remote ?? false;
  let force = opts.force ?? false;
  if (opts.confirm !== false) {
    // the remote counterpart is resolved per repo (never a differently named upstream); no counterpart, no checkbox
    await ensureRefs(ids);
    const remoteNames = [...new Set(ids.map((id) => remoteBranchOf(id, name)).filter((n): n is string => !!n))];
    const withRemote = ids.filter((id) => remoteBranchOf(id, name)).length;
    const remoteLabel = remoteNames.length === 1 && withRemote === ids.length ? remoteNames[0] : remoteNames.length === 1 ? `${remoteNames[0]} (${withRemote} of ${ids.length} repos)` : `the remote branches (${withRemote} of ${ids.length} repos)`;
    const r = await confirmAction({
      title: "Delete branch",
      message: `Delete ${name}${ids.length > 1 ? ` in ${plural(ids.length, "repo")}` : ""}? Commits that are not merged can be lost.`,
      confirmLabel: "Delete",
      danger: true,
      checkboxes: [
        ...(remoteNames.length > 0 ? [{ id: "remote", label: `Also delete ${remoteLabel}`, checked: remote }] : []),
        { id: "force", label: "Force delete (not merged)", checked: force },
      ],
    });
    if (!r) return emptyResult(true);
    remote = r.checked.remote ?? false;
    force = r.checked.force ?? false;
  }
  return runBatch({
    verb: "delete branch",
    past: "Deleted branch",
    what: name,
    repoIds: ids,
    skip: (id) => (cachedRefs(id) && !hasLocalBranch(id, name) ? `no branch ${name}` : null),
    run: async (id) => {
      const local = await api.branchDelete(id, name, force, false);
      const full = remote ? remoteBranchOf(id, name) : undefined;
      if (full) await api.branchDelete(id, full, false, true);
      return local;
    },
  });
}

/** Deletes a branch on its remote (`git push <remote> --delete <name>`) after a confirmation. The local branch stays. */
export async function deleteRemoteBranch(repoId: string, remote: string, name: string): Promise<BatchResult> {
  const r = await confirmAction({
    title: "Delete remote branch",
    message: `Delete ${remote}/${name} on the remote server? Other people lose the branch too.`,
    confirmLabel: "Delete remote branch",
    danger: true,
  });
  if (!r) return emptyResult(true);
  return runBatch({
    verb: "delete remote branch",
    past: "Deleted remote branch",
    what: `${remote}/${name}`,
    repoIds: [repoId],
    run: () => api.branchDelete(repoId, `${remote}/${name}`, false, true),
  });
}

/** Renames a local branch (dialog "renameBranch"); can also rename it on the remote. */
export async function renameBranch(repoId: string, oldName: string): Promise<BatchResult> {
  await ensureRefs([repoId]);
  const remoteName = remoteBranchOf(repoId, oldName);
  const r = await showDialog("renameBranch", { repoId, oldName, hasRemote: !!remoteName, remoteName });
  if (!r) return emptyResult(true);
  return runBatch({
    verb: "rename branch",
    past: "Renamed branch",
    what: `${oldName} to ${r.newName}`,
    repoIds: [repoId],
    run: async (id) => {
      // look the remote branch up first: the rename moves the upstream
      const oldRemote = r.renameRemote ? remoteBranchOf(id, oldName) : undefined;
      const res = await api.branchRename(id, oldName, r.newName);
      if (oldRemote) {
        const remote = splitRemoteRef(oldRemote, cachedRefs(id))?.remote ?? "origin";
        await api.push(id, { remote, branch: r.newName, setUpstream: true });
        await api.branchDelete(id, oldRemote, false, true);
      }
      return res;
    },
  });
}

// ---------------------------------------------------------------- integrate

/** What `source` names, for the default merge message. */
function mergeSourceKind(id: string, source: string): "branch" | "remote" | "tag" | "commit" {
  const refs = cachedRefs(id);
  if (refs?.local.some((b) => b.name === source)) return "branch";
  if (refs?.remote.some((b) => b.fullName === source)) return "remote";
  if (refs?.tags.some((t) => t.name === source)) return "tag";
  return /^[0-9a-f]{4,40}$/.test(source) ? "commit" : "branch";
}

/**
 * Merges `source` into the current branch of each repo (dialog "merge": mode, message, `--no-commit`,
 * unrelated histories). Repos on a diverged branch fail on "fast-forward only" with a clear error; the others go on.
 */
export async function merge(repoIds: RepoIds, source: string): Promise<BatchResult> {
  const ids = toIds(repoIds);
  await ensureRefs(ids);
  const r = await showDialog("merge", { repoIds: ids, source, target: currentBranch(ids[0]), sourceKind: mergeSourceKind(ids[0], source) });
  if (!r) return emptyResult(true);
  return runBatch({
    verb: "merge",
    past: "Merged",
    what: source,
    repoIds: ids,
    skip: (id) => busy(id) ?? (cachedRefs(id) && !hasBranchSomewhere(id, source) && !/^[0-9a-f]{4,40}$/.test(source) ? `no ${source}` : null),
    run: (id) => api.merge(id, source, r),
  });
}

/** Rebases the current branch of each repo onto `onto` (dialog "rebase"; local changes are autostashed by the backend). */
export async function rebase(repoIds: RepoIds, onto: string): Promise<BatchResult> {
  const ids = toIds(repoIds);
  const r = await showDialog("rebase", { repoIds: ids, branch: currentBranch(ids[0]), onto });
  if (!r) return emptyResult(true);
  return runBatch({
    verb: "rebase",
    past: "Rebased",
    what: `onto ${r.onto}`,
    repoIds: ids,
    skip: busy,
    // the backend always runs `git rebase --autostash`
    run: (id) => api.rebase(id, r.onto),
  });
}

/** Cherry-picks commits onto the current branch of one repo. */
export function cherryPick(repoId: string, oids: string[]): Promise<BatchResult> {
  return runBatch({
    verb: "cherry-pick",
    past: "Cherry-picked",
    what: oids.length === 1 ? oids[0].slice(0, 7) : plural(oids.length, "commit"),
    repoIds: [repoId],
    skip: busy,
    run: () => api.cherryPick(repoId, oids),
  });
}

/** Reverts one commit on the current branch. */
export function revert(repoId: string, oid: string): Promise<BatchResult> {
  return runBatch({
    verb: "revert",
    past: "Reverted",
    what: oid.slice(0, 7),
    repoIds: [repoId],
    skip: busy,
    run: () => api.revert(repoId, oid),
  });
}

/** Resets the current branch to `target` (dialog "reset": soft, mixed, hard, keep). */
export async function reset(repoIds: RepoIds, target: string, targetLabel?: string): Promise<BatchResult> {
  const ids = toIds(repoIds);
  const dirty = ids.reduce((n, id) => n + (summary(id)?.staged ?? 0) + (summary(id)?.unstaged ?? 0), 0);
  const r = await showDialog("reset", { repoIds: ids, target, targetLabel, dirtyFiles: dirty });
  if (!r) return emptyResult(true);
  return runBatch({
    verb: "reset",
    past: "Reset",
    what: `to ${targetLabel ?? target.slice(0, 7)} (${r.mode})`,
    repoIds: ids,
    skip: busy,
    run: (id) => api.reset(id, target, r.mode),
  });
}

/** Continues the merge / rebase / cherry-pick / revert in progress. Repos with nothing in progress are skipped. */
export function opContinue(repoIds: RepoIds): Promise<BatchResult> {
  return runBatch({
    verb: "continue",
    past: "Continued",
    repoIds: toIds(repoIds),
    skip: (id) => (summary(id)?.state === "clean" ? "nothing in progress" : null),
    run: (id) => api.opContinue(id),
  });
}

const OP_NAMES: Record<string, string> = { merging: "merge", rebasing: "rebase", cherryPicking: "cherry-pick", reverting: "revert" };
const opName = (id: string): string => OP_NAMES[summary(id)?.state ?? ""] ?? "operation";

/**
 * Aborts the operation in progress. Asks first ("Abort rebase in ledger-service?") because the conflict resolutions
 * are lost; callers that already asked pass `{ confirmed: true }`.
 */
export async function opAbort(repoIds: RepoIds, opts: { confirmed?: boolean } = {}): Promise<BatchResult> {
  const ids = toIds(repoIds);
  if (!opts.confirmed) {
    const active = ids.filter((id) => summary(id) && summary(id)?.state !== "clean");
    if (active.length > 0) {
      const kinds = [...new Set(active.map(opName))];
      const what = kinds.length === 1 ? kinds[0] : "operation";
      const where = active.length === 1 ? nameOf(active[0]) : plural(active.length, "repo");
      const r = await confirmAction({
        title: `Abort ${what}`,
        message: `Abort ${what} in ${where}? The conflict resolutions you made are lost.`,
        confirmLabel: `Abort ${what}`,
        danger: true,
      });
      if (!r) return emptyResult(true);
    }
  }
  return runBatch({
    verb: "abort",
    past: "Aborted",
    repoIds: ids,
    skip: (id) => (summary(id)?.state === "clean" ? "nothing in progress" : null),
    run: (id) => api.opAbort(id),
  });
}

/** Skips the current step of a rebase / cherry-pick. */
export function opSkip(repoIds: RepoIds): Promise<BatchResult> {
  return runBatch({
    verb: "skip",
    past: "Skipped",
    repoIds: toIds(repoIds),
    skip: (id) => (summary(id)?.state === "clean" ? "nothing in progress" : null),
    run: (id) => api.opSkip(id),
  });
}

// ---------------------------------------------------------------- remotes

export interface FetchOptions {
  remote?: string | null;
  prune?: boolean;
  /** No success toast. Errors still show. */
  quiet?: boolean;
  /** Background auto-fetch: no activity and no toast of any kind; read the returned `BatchResult` (`state/autoFetch.ts`). */
  silent?: boolean;
  /** Run as a background command: never opens a login dialog (saved credentials only). Set with `silent` by the auto-fetch. */
  background?: boolean;
}

/** Fetches the given repos (all remotes unless `opts.remote`). */
export function fetch(repoIds: RepoIds, opts: FetchOptions = {}): Promise<BatchResult> {
  const ids = toIds(repoIds);
  return runBatch({
    verb: "fetch",
    past: "Fetched",
    repoIds: ids,
    quiet: opts.quiet,
    silent: opts.silent,
    progress: `Fetching ${plural(ids.length, "repository", "repositories")}`,
    run: (id) => api.fetch(id, opts.remote ?? null, opts.prune ?? false, opts.background ?? false),
    body: (r) => (r.ok.length > 1 ? `${plural(r.ok.length, "repository", "repositories")} up to date.${r.failed.length ? ` ${r.failed.length} failed.` : ""}` : undefined),
  });
}

/** Fetches every repo of the active project (title bar button, Ctrl+T). */
export function fetchAll(opts: Omit<FetchOptions, "remote"> = {}): Promise<BatchResult> {
  return fetch(projectRepos().map((r) => r.id), { prune: true, ...opts });
}

/** Pulls the current branch of each repo (merge, or rebase with `opts.rebase`). Repos without an upstream are skipped. */
export function pull(repoIds: RepoIds, opts: { rebase?: boolean } = {}): Promise<BatchResult> {
  return runBatch({
    verb: "pull",
    past: "Pulled",
    repoIds: toIds(repoIds),
    skip: (id) => busy(id) ?? (summary(id) && !summary(id)?.upstream ? "no upstream branch" : null),
    run: (id) => api.pull(id, opts.rebase ?? false),
  });
}

export interface PushOptions {
  /** Open the "push" dialog first (default true). */
  ask?: boolean;
  remote?: string | null;
  branch?: string | null;
  force?: boolean;
  setUpstream?: boolean;
  tags?: boolean;
}

/**
 * Pushes `opts.branch`, or the current branch of each repo (every repo gets its own branch name, so a batch of repos on
 * different branches works). Branches without an upstream are pushed with `-u`; detached repos and branches with
 * nothing to push are skipped.
 */
export async function push(repoIds: RepoIds, opts: PushOptions = {}): Promise<BatchResult> {
  const ids = toIds(repoIds);
  let o: PushResult = { remote: opts.remote ?? null, branch: opts.branch ?? null, force: opts.force ?? false, setUpstream: opts.setUpstream ?? false, tags: opts.tags ?? false };
  if (opts.ask ?? true) {
    const r = await showDialog("push", { repoIds: ids, branch: opts.branch ?? undefined });
    if (!r) return emptyResult(true);
    o = r;
  }
  // a non-HEAD branch is judged by its own upstream/ahead, which only the refs know
  await ensureRefs(ids);
  const planOf = (id: string) => {
    const s = summary(id);
    if (!s) return { skip: null, branch: o.branch, remote: o.remote, setUpstream: o.setUpstream, upstream: null, ahead: 0, retargetedFrom: null, target: null, targetExists: false };
    const refs = cachedRefs(id);
    return planPush({ branch: s.branch, upstream: s.upstream ?? null, ahead: s.ahead, local: refs?.local, refs }, o);
  };
  const pushed = new Map<string, number>();
  const retargeted = new Map<string, string>();
  return runBatch({
    verb: "push",
    past: "Pushed",
    what: o.branch ?? undefined,
    repoIds: ids,
    skip: (id) => busy(id) ?? planOf(id).skip,
    run: (id) => {
      const plan = planOf(id);
      pushed.set(id, plan.ahead);
      // the branch tracked a differently named upstream: it goes to <remote>/<branch> and tracks that from now on
      if (plan.retargetedFrom && plan.branch && plan.target) retargeted.set(id, `${plan.branch} to ${plan.targetExists ? "" : "new "}${plan.target} (it tracked ${plan.retargetedFrom})`);
      return api.push(id, { remote: plan.remote, branch: plan.branch, force: o.force, setUpstream: plan.setUpstream, tags: o.tags });
    },
    body: (r) => {
      const n = r.ok.reduce((sum, id) => sum + (pushed.get(id) ?? 0), 0);
      const moved = r.ok.filter((id) => retargeted.has(id));
      if (moved.length > 0) return `Pushed ${moved.map((id) => retargeted.get(id)).join("; ")}.${r.ok.length > moved.length ? ` ${plural(r.ok.length - moved.length, "other repo")} pushed.` : ""}${r.skipped.length ? ` ${r.skipped.length} skipped.` : ""}`;
      return n > 0 ? `${plural(n, "commit")} pushed${r.skipped.length ? `. ${r.skipped.length} skipped.` : "."}` : undefined;
    },
  });
}

// ---------------------------------------------------------------- stash and tags

/** Stashes local changes (dialog "stash"). */
export async function stashSave(repoIds: RepoIds): Promise<BatchResult> {
  const ids = toIds(repoIds);
  const r = await showDialog("stash", { repoIds: ids });
  if (!r) return emptyResult(true);
  return runBatch({
    verb: "stash changes",
    past: "Stashed changes",
    repoIds: ids,
    skip: (id) => {
      const s = summary(id);
      return s && s.staged + s.unstaged + (r.includeUntracked ? s.untracked : 0) === 0 ? "no local changes" : null;
    },
    run: (id) => api.stashSave(id, r.message, r.includeUntracked, r.keepIndex),
  });
}

/** Applies a stash and keeps it. */
export function stashApply(repoId: string, index: number, oid?: string): Promise<BatchResult> {
  return runBatch({ verb: "apply stash", past: "Applied stash", what: `stash@{${index}}`, repoIds: [repoId], run: () => api.stashApply(repoId, index, oid) });
}

/** Applies a stash and drops it. */
export function stashPop(repoId: string, index: number, oid?: string): Promise<BatchResult> {
  return runBatch({ verb: "pop stash", past: "Popped stash", what: `stash@{${index}}`, repoIds: [repoId], run: () => api.stashPop(repoId, index, oid) });
}

/** Drops a stash after a confirmation. */
export async function stashDrop(repoId: string, index: number, oid?: string): Promise<BatchResult> {
  const r = await confirmAction({
    title: "Drop stash",
    message: `Drop stash@{${index}} in ${nameOf(repoId)}? Its changes cannot be restored.`,
    confirmLabel: "Drop stash",
    danger: true,
  });
  if (!r) return emptyResult(true);
  return runBatch({ verb: "drop stash", past: "Dropped stash", what: `stash@{${index}}`, repoIds: [repoId], run: () => api.stashDrop(repoId, index, oid) });
}

/** Creates a tag at `target` (dialog "tag"). */
export async function tagCreate(repoIds: RepoIds, target: string, targetLabel?: string): Promise<BatchResult> {
  const ids = toIds(repoIds);
  const r = await showDialog("tag", { repoIds: ids, target, targetLabel });
  if (!r) return emptyResult(true);
  return runBatch({ verb: "create tag", past: "Created tag", what: r.name, repoIds: ids, run: (id) => api.tagCreate(id, r.name, target, r.message) });
}

/** Deletes a tag after a confirmation. */
export async function tagDelete(repoIds: RepoIds, name: string): Promise<BatchResult> {
  const ids = toIds(repoIds);
  const r = await confirmAction({
    title: "Delete tag",
    message: `Delete tag ${name}${ids.length > 1 ? ` in ${plural(ids.length, "repo")}` : ""}?`,
    confirmLabel: "Delete tag",
    danger: true,
  });
  if (!r) return emptyResult(true);
  return runBatch({ verb: "delete tag", past: "Deleted tag", what: name, repoIds: ids, run: (id) => api.tagDelete(id, name) });
}

// ---------------------------------------------------------------- index and commit

/** Stages files. No success toast; errors still show. */
export function stage(repoId: string, paths: string[]): Promise<BatchResult> {
  return runBatch({ verb: "stage", past: "Staged", repoIds: [repoId], quiet: true, run: () => api.stage(repoId, paths).then(() => undefined) });
}

/** Unstages files. */
export function unstage(repoId: string, paths: string[]): Promise<BatchResult> {
  return runBatch({ verb: "unstage", past: "Unstaged", repoIds: [repoId], quiet: true, run: () => api.unstage(repoId, paths).then(() => undefined) });
}

/** Stages or unstages one hunk (`reverse` = unstage). */
export function stageHunk(repoId: string, path: string, hunkIndex: number, reverse = false, opts?: HunkOpts): Promise<BatchResult> {
  return runBatch({
    verb: reverse ? "unstage hunk" : "stage hunk",
    past: reverse ? "Unstaged hunk" : "Staged hunk",
    repoIds: [repoId],
    quiet: true,
    run: () => api.stageHunk(repoId, path, hunkIndex, reverse, opts).then(() => undefined),
  });
}

export interface DiscardOptions {
  /** Skip the confirmation (default: ask). */
  confirm?: boolean;
  /** How many of `paths` are untracked (they get deleted): shown in the confirmation. */
  untracked?: number;
}

/** Discards worktree changes of files after a confirmation ("Discard 3 files"). Untracked files are deleted. */
export async function discard(repoId: string, paths: string[], opts: DiscardOptions = {}): Promise<BatchResult> {
  if (opts.confirm !== false) {
    const shown = paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` and ${paths.length - 5} more` : "");
    const r = await confirmAction({
      title: "Discard changes",
      message: [`Discard changes in ${plural(paths.length, "file")} of ${nameOf(repoId)}? ${shown}`, ...(opts.untracked ? [`${plural(opts.untracked, "untracked file")} will be deleted.`] : []), "This cannot be undone."],
      confirmLabel: `Discard ${plural(paths.length, "file")}`,
      danger: true,
    });
    if (!r) return emptyResult(true);
  }
  return runBatch({ verb: "discard changes", past: "Discarded changes", what: `in ${plural(paths.length, "file")}`, repoIds: [repoId], run: () => api.discard(repoId, paths).then(() => undefined) });
}

/** Discards one hunk after a confirmation (`opts.confirm: false` when the caller, e.g. the diff viewer, already asked). */
export async function discardHunk(repoId: string, path: string, hunkIndex: number, opts: { confirm?: boolean } & HunkOpts = {}): Promise<BatchResult> {
  const r = opts.confirm === false ? {} : await confirmAction({
    title: "Discard hunk",
    message: `Discard this change in ${path}? This cannot be undone.`,
    confirmLabel: "Discard hunk",
    danger: true,
  });
  if (!r) return emptyResult(true);
  return runBatch({ verb: "discard hunk", past: "Discarded hunk", repoIds: [repoId], quiet: true, run: () => api.discardHunk(repoId, path, hunkIndex, opts).then(() => undefined) });
}

/**
 * Commits the staged changes of each repo with one message ("Commit in 3 repos"). Repos with nothing
 * staged are skipped unless `amend`.
 */
export function commit(repoIds: RepoIds, message: string, opts: { amend?: boolean; signOff?: boolean } = {}): Promise<BatchResult> {
  const ids = toIds(repoIds);
  const subject = firstLine(message, 100);
  return runBatch({
    verb: "commit",
    past: opts.amend ? "Amended commit" : "Committed",
    repoIds: ids,
    skip: (id) => (!opts.amend && summary(id) && (summary(id)?.staged ?? 0) === 0 ? "nothing staged" : null),
    run: (id) => api.commit(id, message, opts.amend ?? false, opts.signOff ?? false),
    body: () => subject,
    progress: `Committing in ${plural(ids.length, "repository", "repositories")}`,
  });
}

// ---------------------------------------------------------------- clone

export interface CloneRequest {
  url: string;
  /** Folder that will contain the clone. */
  parentDir: string;
  /** Name of the new folder. */
  dirName: string;
  branch: string | null;
  depth: number | null;
  recurseSubmodules: boolean;
  /** "current": add to the active project (its folder must contain `parentDir`); "new": a new project at the clone. */
  addTo: "current" | "new";
}

export type CloneOutcome =
  | { ok: true; result: CloneResult }
  | { ok: false; cancelled: boolean; error: ApiError | null };

export interface CloneRun {
  /** Settles when the clone ends. Never rejects. Success also adds the repo to the workspace and shows a toast. */
  done: Promise<CloneOutcome>;
  /** Stops the clone; `done` then resolves with `cancelled: true`. */
  cancel(): void;
}

let cloneSeq = 0;
const CANCELLED = "The operation was cancelled.";

/**
 * Starts a clone (the "clone" dialog calls this) and reports the progress of git (phase and percent) to `onProgress`.
 * The dialog shows errors inline, so this does not toast a failure; it toasts the success.
 */
export function startClone(req: CloneRequest, onProgress: (p: CloneProgress) => void): CloneRun {
  const id = `clone-${Date.now().toString(36)}-${++cloneSeq}`;
  let cancelRequested = false;
  const project = activeProject();
  const opts: CloneOpts = { branch: req.branch, depth: req.depth, recurseSubmodules: req.recurseSubmodules };
  const target = req.addTo === "current" && project ? ({ kind: "project", projectId: project.id } as const) : ({ kind: "newProject" } as const);
  const done = (async (): Promise<CloneOutcome> => {
    let stop: (() => void) | undefined;
    try {
      // listen first: the first progress line can come before `cloneRepo` returns control
      stop = await api.onCloneProgress((e) => {
        if (e.operationId === id) onProgress(e);
      });
      const running = api.cloneRepo(id, req.url, req.parentDir, req.dirName, opts, target);
      // Cancel may have been pressed while the listener was being set up, before the backend knew this clone: say it
      // again now that the clone is on its way (the backend also remembers a cancel that came first).
      if (cancelRequested) void api.cloneCancel(id).catch(() => undefined);
      const result = await running;
      await adoptClonedProject(result);
      toast({ kind: "success", title: `Cloned ${req.dirName}`, body: result.createdProject ? `New project ${result.project.name}.` : `Added to ${result.project.name}.` });
      return { ok: true, result };
    } catch (e) {
      const err = toApiError(e);
      const cancelled = cancelRequested || err.message === CANCELLED;
      return { ok: false, cancelled, error: cancelled ? null : err };
    } finally {
      stop?.();
    }
  })();
  return {
    done,
    cancel: () => {
      cancelRequested = true;
      void api.cloneCancel(id).catch(() => undefined);
    },
  };
}

/** Opens the "clone" dialog. Resolves to what the clone made, or undefined when the user closed the dialog without cloning. */
export function cloneRepository(url?: string) {
  return showDialog("clone", { url });
}

// ---------------------------------------------------------------- merge conflicts

const SIDE_VERB: Record<ConflictSide, string> = { ours: "accept Yours", theirs: "accept Theirs" };

/**
 * Keeps one whole side of each conflicted file ("Accept Yours / Theirs"). A side that deleted the file deletes it
 * (`git rm`). The user's side is `"ours"`, also during a rebase (the backend swaps the index stages). No success toast;
 * when it resolved the last conflict of the repo it offers to continue (`opts.offerContinue = false` to skip that).
 */
export async function acceptSide(repoId: string, paths: string[], side: ConflictSide, opts: { offerContinue?: boolean } = {}): Promise<BatchResult> {
  const res = await runBatch({
    verb: SIDE_VERB[side],
    past: side === "ours" ? "Accepted Yours" : "Accepted Theirs",
    what: paths.length === 1 ? paths[0] : plural(paths.length, "file"),
    repoIds: [repoId],
    quiet: true,
    run: () => api.acceptSide(repoId, paths, side).then(() => undefined),
  });
  if (res.ok.length > 0 && opts.offerContinue !== false) await offerContinue(repoId);
  return res;
}

/**
 * Saves the merged text of one file (see `api.saveResolution`). `resolved = false` writes it with conflict markers and
 * leaves the file unmerged. Quiet on success; a refused save (the conflict changed, the file is no longer conflicted)
 * shows an error toast and comes back in `failed`.
 */
export function saveResolution(repoId: string, path: string, content: string, expected: ExpectedOids, resolved: boolean): Promise<BatchResult> {
  return runBatch({
    verb: "save the merge result",
    past: resolved ? "Resolved" : "Saved with conflict markers",
    what: path,
    repoIds: [repoId],
    quiet: true,
    run: () => api.saveResolution(repoId, path, content, expected, resolved).then(() => undefined),
  });
}

/** After a conflict was resolved: when the repo has none left, offers to continue the merge / rebase / cherry-pick / revert. */
export async function offerContinue(repoId: string): Promise<void> {
  await refreshSummaries([repoId]);
  const s = summary(repoId);
  if (!s || s.state === "clean" || s.state === "bisecting" || s.conflicted > 0) return;
  const op = opName(repoId);
  toast({
    kind: "success",
    title: `All conflicts resolved in ${nameOf(repoId)}`,
    body: `Continue the ${op} to finish it.`,
    actions: [{ label: `Continue ${op}`, onClick: () => void opContinue(repoId) }],
  });
}

/** Opens the conflicts dialog (files grouped by repo, Accept Yours / Theirs, Merge…). */
export async function openConflicts(repoIds: RepoIds): Promise<void> {
  const ids = toIds(repoIds);
  if (ids.length === 0) return;
  await showDialog("conflicts", { repoIds: ids });
}

/** Opens the merge window of one file. Resolves to true when the file was resolved. */
export async function openMerge(repoId: string, path: string, opts: { offerContinue?: boolean } = {}): Promise<boolean> {
  const r = await showDialog("mergeFile", { repoId, path });
  if (r?.resolved && opts.offerContinue !== false) await offerContinue(repoId);
  return r?.resolved ?? false;
}

/** Renames a project (dialog "renameProject"; the active project when no id is given). The sidebar card renames in place instead. */
export async function renameProject(projectId?: string): Promise<void> {
  const id = projectId ?? activeProject()?.id;
  if (!id || !workspace.projects.some((p) => p.id === id)) return;
  const r = await showDialog("renameProject", { projectId: id });
  if (!r) return;
  try {
    await saveProjectName(id, r.name);
  } catch (e) {
    toast({ kind: "error", title: "Could not rename the project", body: toApiError(e).message });
  }
}
