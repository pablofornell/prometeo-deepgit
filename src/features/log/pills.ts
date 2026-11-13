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
/** Width of one character of a pill name at 11 px (semibold "main" measures 6.75 px per character in Chromium). */
const CHAR = 6.8;
const HEAD_LABEL = 42;
/** The "+N" chip (about 22 px) and the gap in front of it. */
const MORE = 26;
const MAX_PILL = 150;
const MAX_SPLIT = 220;
/** Smallest width of an ordinary pill, and of the branch segment of the split HEAD pill (the HEAD segment never shrinks). */
const MIN_PILL = 40;
const MIN_BRANCH = 48;
/** Estimated width of one character of the subject (semibold on the HEAD row), the gap between subject and pills, and the subject's own minimum. */
const SUBJECT_CHAR = 7.5;
const SUBJECT_GAP = 8;
const SUBJECT_MIN = 40;

const KIND_ORDER: Record<RefLabel["kind"], number> = { head: 0, local: 1, remote: 2, tag: 3, stash: 4 };

/**
 * Pixels the pills of a row may use inside a subject column of `subjectWidth` px. The share rule above holds for a
 * long subject. A short subject (`subjectChars` characters) leaves free room: the pills may use all of it, so a
 * branch name is not cut while there is space.
 */
export function pillBudget(subjectWidth: number, minSubject: number, subjectChars?: number): number {
  const w = Math.max(0, subjectWidth);
  const keep = Math.max(minSubject, w * SUBJECT_MIN_SHARE);
  const share = Math.max(0, Math.min(w * PILL_SHARE, w - keep));
  if (subjectChars === undefined) return share;
  const free = Math.min(w - subjectChars * SUBJECT_CHAR - SUBJECT_GAP, w - SUBJECT_MIN - SUBJECT_GAP);
  return Math.max(share, free);
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
    const text = Math.ceil(r.name.length * CHAR);
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
 * How many pills to show before "+N". All of them when they fit at their natural widths; else as many as fit with the
 * first pill (the HEAD pill, which the CSS shrinks last) at its natural width and the others at their minimum width,
 * with room for the "+N" chip; else the first pill alone; else the same with the first pill at its minimum width. At least one. `mins` defaults
 * to `widths` (pills that do not shrink).
 */
export function visiblePills(widths: readonly number[], budget: number, mins: readonly number[] = widths): number {
  const n = widths.length;
  if (n <= 1) return n;
  const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0) + GAP * (n - 1);
  if (sum(widths) <= budget) return n;
  // The first pill keeps its natural width: its branch name is not cut while the others can still give way.
  for (let k = n; k > 1; k--) {
    let need = widths[0] + (k < n ? MORE : 0);
    for (let i = 1; i < k; i++) need += GAP + mins[i];
    if (need <= budget) return k;
  }
  if (widths[0] + MORE <= budget) return 1;
  if (sum(mins) <= budget) return n;
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
