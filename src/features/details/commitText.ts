/** Small pure helpers of the commit details panel: who committed and the push state. Dates come from `state/dates.ts`. */

export interface PersonLike {
  name: string;
  email: string;
  time: number;
}

/** True when the committer line adds information (another person, or committed later than authored). */
export function committerDiffers(author: PersonLike, committer: PersonLike): boolean {
  return author.name !== committer.name || author.email.toLowerCase() !== committer.email.toLowerCase() || Math.abs(committer.time - author.time) > 60;
}

export type PushState =
  /** Reachable from at least one remote branch. */
  | { kind: "pushed"; remotes: string[] }
  /** On no remote branch. `ahead` = commits to push on the current branch when the commit is on it. */
  | { kind: "unpushed"; remote: string; ahead: number | null }
  /** The repository has no remote: nothing to say. */
  | { kind: "none" };

export interface PushInput {
  /** `branches_containing` result: local and remote branch names. */
  branches: readonly string[];
  /** Full names of the remote branches of the repo ("origin/main"). */
  remoteBranches: ReadonlySet<string>;
  /** Remote names ("origin"). */
  remotes: readonly string[];
  /** Checked-out branch, its upstream ("origin/main") and ahead count. */
  current: { branch: string | null; upstream: string | null; ahead: number };
}

export function pushState(i: PushInput): PushState {
  if (i.remotes.length === 0) return { kind: "none" };
  const remotes = i.branches.filter((b) => i.remoteBranches.has(b));
  if (remotes.length > 0) return { kind: "pushed", remotes };
  const up = i.current.upstream;
  // remote names may contain "/": the longest configured name that prefixes the upstream
  const upRemote = up ? [...i.remotes].filter((r) => up.startsWith(r + "/")).sort((a, b) => b.length - a.length)[0] : undefined;
  const remote = upRemote ?? i.remotes.find((r) => r === "origin") ?? i.remotes[0];
  const onCurrent = i.current.branch !== null && i.branches.includes(i.current.branch);
  return { kind: "unpushed", remote, ahead: onCurrent && i.current.ahead > 0 ? i.current.ahead : null };
}
