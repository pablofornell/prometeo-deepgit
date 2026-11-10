/** Small pure helpers of the commit details panel: date wording and push state. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n: number) => String(n).padStart(2, "0");

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * "today at 10:42, Tue 10 Nov 2026", "yesterday at 18:03, Mon 9 Nov 2026" or "on Tue 3 Nov 2026 at 10:42"
 * (local time), to follow "Authored" / "Committed".
 */
export function whenText(unixSec: number, nowMs: number = Date.now()): string {
  const d = new Date(unixSec * 1000);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const date = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const days = Math.round((startOfDay(new Date(nowMs)) - startOfDay(d)) / 86400000);
  if (days === 0) return `today at ${hm}, ${date}`;
  if (days === 1) return `yesterday at ${hm}, ${date}`;
  return `on ${date} at ${hm}`;
}

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
