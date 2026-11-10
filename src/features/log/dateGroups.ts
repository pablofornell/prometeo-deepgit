/**
 * Date groups of the log (DESIGN.md 5.5 "Date groups") and the map between display rows and commit rows.
 *
 * The log shows extra rows that are not commits: the "Uncommitted changes" row on top and one group row
 * ("Today", "Yesterday", "October 2026"...) before the first commit of each group. `DisplayMap` converts
 * between the virtual list index and the commit index with a binary search, so it works for 100 000 rows.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface DateGroup {
  /** Stable key: equal keys mean "same group". */
  key: string;
  label: string;
}

/** Group of a commit time (unix seconds) relative to `nowMs`, in local time. Future times count as today. */
export function dateGroup(unixSec: number, nowMs: number = Date.now()): DateGroup {
  const t = new Date(unixSec * 1000);
  const now = new Date(nowMs);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = dayStart(now);
  const day = dayStart(t);
  if (day >= today) return { key: "today", label: "Today" };
  if (day >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) return { key: "yesterday", label: "Yesterday" };
  const sinceMonday = (now.getDay() + 6) % 7;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday).getTime();
  if (day >= weekStart) return { key: "week", label: "This week" };
  const lastWeekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday - 7).getTime();
  if (day >= lastWeekStart) return { key: "lastweek", label: "Last week" };
  if (t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth()) return { key: "month", label: "Earlier this month" };
  return { key: `${t.getFullYear()}-${t.getMonth()}`, label: `${MONTHS[t.getMonth()]} ${t.getFullYear()}` };
}

export type DisplayItem =
  | { kind: "wip" }
  | { kind: "date"; group: number; label: string }
  | { kind: "commit"; ci: number };

/**
 * Display rows = optional "Uncommitted changes" row + commits + one group row before each index in `groupStarts`
 * (ascending commit indexes; `labels[k]` names group `k`).
 */
export class DisplayMap {
  constructor(
    readonly total: number,
    readonly wip: boolean,
    readonly groupStarts: readonly number[] = [],
    readonly labels: readonly string[] = [],
  ) {}

  private get offset(): number {
    return this.wip ? 1 : 0;
  }

  get count(): number {
    return this.offset + this.total + this.groupStarts.length;
  }

  /** Number of groups whose first commit index is <= ci. */
  private groupsUpTo(ci: number): number {
    let lo = 0;
    let hi = this.groupStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.groupStarts[mid] <= ci) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Display index of commit `ci`. */
  displayOf(ci: number): number {
    return this.offset + ci + this.groupsUpTo(ci);
  }

  /** Display index of the group row that precedes commit `ci`, or -1 when `ci` does not start a group. */
  headerOf(ci: number): number {
    const k = this.groupsUpTo(ci) - 1;
    return k >= 0 && this.groupStarts[k] === ci ? this.offset + ci + k : -1;
  }

  /** Number of group rows whose display index is <= rel (rel = display index minus the wip offset). */
  private headersUpTo(rel: number): number {
    let lo = 0;
    let hi = this.groupStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.groupStarts[mid] + mid <= rel) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  itemAt(d: number): DisplayItem {
    const rel = d - this.offset;
    if (rel < 0) return { kind: "wip" };
    const n = this.headersUpTo(rel);
    if (n > 0 && this.groupStarts[n - 1] + (n - 1) === rel) return { kind: "date", group: n - 1, label: this.labels[n - 1] ?? "" };
    return { kind: "commit", ci: rel - n };
  }

  /** Display index and label of the group row at or above display index `d` (for the sticky label), or null. */
  stickyAt(d: number): { index: number; label: string } | null {
    const rel = d - this.offset;
    if (rel < 0) return null;
    const n = this.headersUpTo(rel);
    if (n === 0) return null;
    return { index: this.offset + this.groupStarts[n - 1] + (n - 1), label: this.labels[n - 1] ?? "" };
  }
}

/** Builds the group starts from one group key per commit (in log order). */
export function groupStartsOf(keys: ArrayLike<string>, labelOf: (key: string) => string): { starts: number[]; labels: string[] } {
  const starts: number[] = [];
  const labels: string[] = [];
  let prev: string | undefined;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === prev) continue;
    prev = keys[i];
    starts.push(i);
    labels.push(labelOf(keys[i]));
  }
  return { starts, labels };
}
