/** Pure helpers for `<remote>/<branch>` names. Remote names may contain "/" (`team/fork`), so never cut at the first one. */
import type { Refs } from "../api/types";

export interface SplitRef {
  remote: string;
  branch: string;
}

/**
 * Splits `"team/fork/main"` into `{ remote: "team/fork", branch: "main" }`: the remote is a `RemoteBranch.remote` of the
 * matching remote branch, else the longest name of `remotes` that prefixes the ref. Null when nothing matches.
 */
export function splitRemoteRef(full: string, refs: Pick<Refs, "remote" | "remotes"> | undefined, extraRemotes: readonly string[] = []): SplitRef | null {
  const hit = refs?.remote.find((b) => b.fullName === full);
  if (hit) return { remote: hit.remote, branch: hit.name };
  const names = [...(refs?.remotes.map((r) => r.name) ?? []), ...extraRemotes];
  let best: string | null = null;
  for (const n of names) if (full.startsWith(n + "/") && full.length > n.length + 1 && (best === null || n.length > best.length)) best = n;
  return best === null ? null : { remote: best, branch: full.slice(best.length + 1) };
}

/** Like `splitRemoteRef`, but guesses the first segment as the remote when nothing is known (no refs loaded yet). */
export function splitRemoteRefLoose(full: string, refs: Pick<Refs, "remote" | "remotes"> | undefined): SplitRef | null {
  const s = splitRemoteRef(full, refs);
  if (s) return s;
  if (refs && refs.remotes.length > 0) return null;
  const i = full.indexOf("/");
  return i > 0 ? { remote: full.slice(0, i), branch: full.slice(i + 1) } : null;
}

/**
 * `"<remote>/<branch>"` of the remote branch that belongs to local branch `name`, or undefined.
 * It is the upstream ONLY when the upstream's branch part equals `name` (a `feature` that tracks `origin/develop` must
 * never delete or rename `develop`). Otherwise `origin/<name>`, but only when that remote branch exists.
 */
export function remoteCounterpart(refs: Pick<Refs, "local" | "remote" | "remotes"> | undefined, name: string): string | undefined {
  if (!refs) return undefined;
  const up = refs.local.find((b) => b.name === name)?.upstream;
  if (up) {
    const s = splitRemoteRef(up, refs);
    if (s && s.branch === name && refs.remote.some((b) => b.fullName === up)) return up;
  }
  return refs.remote.find((b) => b.remote === "origin" && b.name === name)?.fullName;
}
