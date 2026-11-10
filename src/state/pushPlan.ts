/** Pure rules of `actions.push`: which branch each repo pushes, to which remote, and when there is nothing to push. */
import type { Refs } from "../api/types";
import { splitRemoteRefLoose } from "./remoteRefs";

export interface PushRepoState {
  /** Checked-out branch (`summary.branch`), null when HEAD is detached. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  /** Local branches from the refs cache; undefined until loaded. */
  local?: { name: string; upstream: string | null; ahead: number }[];
  /** Remote branches and remotes of the refs cache (remote names may contain "/"); undefined until loaded. */
  refs?: Pick<Refs, "remote" | "remotes">;
}

export interface PushRequest {
  remote: string | null;
  /** Branch asked for; null = the current branch of each repo. */
  branch: string | null;
  force: boolean;
  setUpstream: boolean;
  tags: boolean;
}

export interface PushPlan {
  /** Reason to skip this repo, or null. */
  skip: string | null;
  /** Branch to send (always explicit, so repos on different branches work in one batch). */
  branch: string | null;
  /** Explicit remote, or null to let the backend default. */
  remote: string | null;
  setUpstream: boolean;
  /** Upstream of the pushed branch, null when it has none, it is unknown or it has another name (see `retargetedFrom`). */
  upstream: string | null;
  /**
   * Set when the branch tracks a branch with a different name (`myfix` -> `origin/main`). `git push <remote> myfix`
   * would create `<remote>/myfix` and the API cannot push to the differently named upstream, so the plan treats the
   * branch as having no matching upstream: it is pushed to `<remote>/<branch>` with `-u`. Holds the old upstream.
   */
  retargetedFrom: string | null;
  /** `"<remote>/<branch>"` that receives the push, when the remote is known. */
  target: string | null;
  /** True when that remote branch already exists. */
  targetExists: boolean;
  /** Commits that go out (for the toast), when known. */
  ahead: number;
}

/** "origin/main" -> "origin"; "team/fork/main" -> "team/fork" when the refs know that remote. */
export const remoteOfUpstream = (upstream: string | null | undefined, refs?: Pick<Refs, "remote" | "remotes">): string | null =>
  upstream ? splitRemoteRefLoose(upstream, refs)?.remote ?? null : null;

export function planPush(s: PushRepoState, o: PushRequest): PushPlan {
  const branch = o.branch ?? s.branch;
  if (!branch) return { skip: "detached HEAD (no branch to push)", branch: null, remote: o.remote, setUpstream: false, upstream: null, ahead: 0, retargetedFrom: null, target: null, targetExists: false };

  let upstream = s.upstream;
  let ahead = s.ahead;
  let known = true;
  if (branch !== s.branch) {
    // another branch than HEAD: its own tracking data, not the summary's
    const lb = s.local?.find((b) => b.name === branch);
    if (lb) {
      upstream = lb.upstream;
      ahead = lb.ahead;
    } else {
      upstream = null;
      ahead = 0;
      known = false;
    }
  }
  // an upstream with another branch name is not where this branch goes: push to <remote>/<branch> and track that
  const upSplit = upstream ? splitRemoteRefLoose(upstream, s.refs) : null;
  const retargetedFrom = upstream && upSplit && upSplit.branch !== branch ? upstream : null;
  const upstreamRemote = upSplit?.remote ?? null;
  if (retargetedFrom) {
    ahead = 0;
    upstream = null;
  }
  const tracked = !!upstream;
  const nothing = known && tracked && ahead === 0 && !o.force && !o.tags;
  const remote = o.remote ?? upstreamRemote;
  const target = remote ? `${remote}/${branch}` : null;
  return {
    skip: nothing ? "nothing to push" : null,
    branch,
    remote,
    setUpstream: o.setUpstream || (known && !tracked),
    upstream,
    ahead: tracked ? ahead : 0,
    retargetedFrom,
    target,
    targetExists: !!target && !!s.refs?.remote.some((b) => b.fullName === target),
  };
}
