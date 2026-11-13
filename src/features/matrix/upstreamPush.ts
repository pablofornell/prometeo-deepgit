/**
 * Pure rules of the matrix "Push and set upstream" (ITERATION-3.md section 7): which cells qualify, which remote is
 * the default, what each repo of the dialog does, how many commits go out, and how the bulk run and its toast behave.
 * No UI and no API calls here: the dialog passes the push function in.
 */
import type { CommitRow, Refs } from "../../api/types";
import type { BranchCell, BranchColumn } from "../../state/branchTable";

/** Parallel pushes at most (DESIGN 5.17 rule 4). */
export const MAX_PARALLEL_PUSHES = 4;

/**
 * A local branch (checked out or not) that has no upstream setting. A branch whose upstream was deleted (`gone`)
 * still has one, so it does not count.
 */
export const lacksUpstream = (cell: BranchCell): boolean =>
  (cell.state === "current" || cell.state === "local") && cell.upstream === null && !cell.gone;

/** True when 1 or more repos have the column's branch as a local branch without upstream. */
export const columnLacksUpstream = (col: BranchColumn): boolean => Object.values(col.cells).some(lacksUpstream);

/** Remote names of the repos, in order of first appearance. */
export function remoteNames(remotesByRepo: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const names of remotesByRepo) for (const n of names) if (!out.includes(n)) out.push(n);
  return out;
}

/** `origin` when a repo has it; else the first remote; `origin` when no repo has any remote. */
export const defaultRemote = (names: readonly string[]): string => (names.includes("origin") || names.length === 0 ? "origin" : names[0]);

export interface UpstreamRow {
  repoId: string;
  /** False when the repo cannot take the push: the row is disabled and unchecked. */
  enabled: boolean;
  /** Why it is disabled, for the detail text. */
  reason: string | null;
}

/** One row per repo: enabled when the repo has a remote with the chosen name. */
export function planUpstreamRows(repos: readonly { repoId: string; remotes: readonly string[] }[], remote: string): UpstreamRow[] {
  return repos.map((r) => {
    const has = r.remotes.includes(remote);
    return { repoId: r.repoId, enabled: has, reason: has ? null : `No remote named ${remote}` };
  });
}

/**
 * Commits that are on no remote, from the rows of `git log <branch>` (children before parents). A commit is on a
 * remote when a remote branch points at it or at a descendant, so the label is passed down to the parents.
 * `complete` is false when the walk may have ended before reaching a remote commit (the log was capped).
 */
export function countUnpushed(rows: readonly Pick<CommitRow, "oid" | "parents" | "refs">[], capped: boolean): { count: number; complete: boolean } {
  const onRemote = new Set<string>();
  let count = 0;
  let reached = false;
  for (const row of rows) {
    if (row.refs.some((r) => r.kind === "remote")) onRemote.add(row.oid);
    if (onRemote.has(row.oid)) {
      reached = true;
      for (const p of row.parents) onRemote.add(p);
    } else {
      count++;
    }
  }
  return { count, complete: !capped || reached };
}

/** "3 commits", "1 commit", "200+ commits" (the walk was capped before it reached a remote commit). */
export function commitsText({ count, complete }: { count: number; complete: boolean }): string {
  return `${count}${complete ? "" : "+"} ${count === 1 && complete ? "commit" : "commits"}`;
}

// ---------------------------------------------------------------- the run

export type RowStatus = { kind: "queued" } | { kind: "running" } | { kind: "done" } | { kind: "failed"; message: string; full: string };

/** First non-empty line of a git error, for the row text. */
export function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim())?.trim() ?? "";
}

export interface PushOutcome {
  ok: boolean;
  /** git output summary when not ok. */
  message: string;
  /** Extra git output; tooltip only. */
  detail?: string;
}

/**
 * Runs the pushes, at most `limit` at once, in the order of `repoIds`. `push` may reject: that is a failure of that
 * repo only. `onStatus` is called when a repo starts and when it ends. Resolves when all ended; it never rejects.
 */
export async function runUpstreamPushes(
  repoIds: readonly string[],
  push: (repoId: string) => Promise<PushOutcome>,
  onStatus: (repoId: string, status: RowStatus) => void,
  limit = MAX_PARALLEL_PUSHES,
): Promise<Record<string, RowStatus>> {
  const result: Record<string, RowStatus> = {};
  for (const id of repoIds) {
    result[id] = { kind: "queued" };
    onStatus(id, result[id]);
  }
  let next = 0;
  const worker = async () => {
    while (next < repoIds.length) {
      const id = repoIds[next++];
      result[id] = { kind: "running" };
      onStatus(id, result[id]);
      try {
        const r = await push(id);
        result[id] = r.ok ? { kind: "done" } : failure(r.message, r.detail);
      } catch (e) {
        const o = e as { message?: unknown; detail?: unknown };
        result[id] = failure(typeof o?.message === "string" ? o.message : String(e), typeof o?.detail === "string" ? o.detail : undefined);
      }
      onStatus(id, result[id]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, repoIds.length) }, worker));
  return result;
}

function failure(message: string, detail?: string): RowStatus {
  const full = [message, detail].filter((s) => !!s && s.trim()).join("\n");
  return { kind: "failed", message: firstLine(message) || firstLine(detail ?? "") || "Push failed", full: full || "Push failed" };
}

export interface RunSummary {
  kind: "success" | "error";
  title: string;
  body: string;
  /** Add the "Show in console" action. */
  console: boolean;
}

/** The one toast at the end of the run (section 7.4 rule 6). `statuses` has the repos that were pushed. */
export function summarizeRun(branch: string, remote: string, statuses: Record<string, RowStatus>, nameOf: (repoId: string) => string): RunSummary {
  const ids = Object.keys(statuses);
  const bad = ids.filter((id) => statuses[id].kind === "failed");
  if (bad.length === 0) {
    return { kind: "success", title: `Pushed ${branch} to ${ids.length} ${ids.length === 1 ? "repo" : "repos"}`, body: `Upstream set to ${remote}/${branch}.`, console: false };
  }
  return { kind: "error", title: `Push failed in ${bad.length} of ${ids.length} ${ids.length === 1 ? "repo" : "repos"}`, body: bad.map(nameOf).join(", "), console: true };
}

/** Shape of what the dialog needs from the refs of a repo. */
export const remotesOf = (refs: Pick<Refs, "remotes"> | undefined): string[] => refs?.remotes.map((r) => r.name) ?? [];
