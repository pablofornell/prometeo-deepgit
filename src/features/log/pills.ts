/**
 * Ref pill budget of a log row. The pills may use at most `PILL_SHARE` of the subject column and the subject keeps at
 * least `SUBJECT_MIN_SHARE` of it (and `minSubject` px). Pills shrink (ellipsis) down to a minimum width: a pill is
 * shown only when its minimum width fits, always with room for the "+N" chip (ITERATION-3 2.2). When the pills do not
 * fit they collapse to the leading pills that do (at least one) plus "+N"; the full list stays in the tooltip.
 */
import type { RefLabel } from "../../api/types";

export const PILL_SHARE = 0.45;
export const SUBJECT_MIN_SHARE = 0.4;
/** Same defaults as the `RefPill` CSS: 4 px gap, 150 px max pill, 220 px max split HEAD pill. */
const GAP = 4;
const PAD = 12;
const ICON = 14;
const CHAR = 6;
const HEAD_LABEL = 38;
/** The "+N" chip (about 22 px) and the gap in front of it. */
const MORE = 26;
const MAX_PILL = 150;
const MAX_SPLIT = 220;
/** Smallest width of an ordinary pill, and of the branch segment of the split HEAD pill (the HEAD segment never shrinks). */
const MIN_PILL = 40;
const MIN_BRANCH = 48;

const KIND_ORDER: Record<RefLabel["kind"], number> = { head: 0, local: 1, remote: 2, tag: 3, stash: 4 };

/** Pixels the pills of a row may use inside a subject column of `subjectWidth` px. */
export function pillBudget(subjectWidth: number, minSubject: number): number {
  const w = Math.max(0, subjectWidth);
  const keep = Math.max(minSubject, w * SUBJECT_MIN_SHARE);
  return Math.max(0, Math.min(w * PILL_SHARE, w - keep));
}

/** Natural and minimum width of one pill. */
export interface PillSize {
  width: number;
  min: number;
}

/** Estimated sizes of the pills `RefPills` shows (same order and merging of a local branch with its remote). */
export function pillSizes(refs: readonly RefLabel[]): PillSize[] {
  const sorted = [...refs].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const locals = sorted.filter((r) => r.kind === "local").map((r) => r.name);
  const syncedRemote = (name: string) => locals.some((n) => name === "origin/" + n || name.endsWith("/" + n));
  const out: PillSize[] = [];
  for (const r of sorted) {
    if (r.kind === "remote" && syncedRemote(r.name)) continue;
    const synced = r.kind === "local" && sorted.some((x) => x.kind === "remote" && (x.name === "origin/" + r.name || x.name.endsWith("/" + r.name)));
    const text = r.name.length * CHAR;
    if (r.kind === "local" && r.isCurrent) {
      out.push({ width: Math.min(MAX_SPLIT, HEAD_LABEL + PAD + ICON + text + (synced ? ICON : 0)), min: HEAD_LABEL + MIN_BRANCH });
    } else if (r.kind === "head") {
      // The plain HEAD pill (detached) never shrinks.
      const w = Math.min(MAX_PILL, PAD + text);
      out.push({ width: w, min: w });
    } else {
      // `min-width` (40 px) also holds a short name such as a "v1" tag at 40 px.
      out.push({ width: Math.max(MIN_PILL, Math.min(MAX_PILL, PAD + ICON + text + (synced ? ICON : 0))), min: MIN_PILL });
    }
  }
  return out;
}

/** Natural widths of the pills `RefPills` shows. */
export function pillWidths(refs: readonly RefLabel[]): number[] {
  return pillSizes(refs).map((p) => p.width);
}

/** Minimum widths of the pills `RefPills` shows (same order as `pillWidths`). */
export function pillMinWidths(refs: readonly RefLabel[]): number[] {
  return pillSizes(refs).map((p) => p.min);
}

/**
 * Width the pills of a row get: the budget, but never less than the first pill at its minimum width plus the "+N"
 * chip (when there is more than one pill). The subject gives up the difference.
 */
export function pillSpace(budget: number, mins: readonly number[]): number {
  if (mins.length === 0) return 0;
  return Math.max(budget, mins[0] + (mins.length > 1 ? MORE : 0));
}

/**
 * How many pills to show before "+N". All of them when they fit at their natural widths, or at their minimum widths
 * (they shrink with an ellipsis); otherwise as many leading pills as fit at their minimum width with room for the
 * "+N" chip, and at least one. `mins` defaults to `widths` (pills that do not shrink).
 */
export function visiblePills(widths: readonly number[], budget: number, mins: readonly number[] = widths): number {
  const n = widths.length;
  if (n <= 1) return n;
  const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0) + GAP * (n - 1);
  if (sum(widths) <= budget || sum(mins) <= budget) return n;
  let used = 0;
  let k = 0;
  while (k < n - 1) {
    const next = used + (k > 0 ? GAP : 0) + mins[k];
    if (next + MORE > budget) break;
    used = next;
    k++;
  }
  return Math.max(1, k);
}
