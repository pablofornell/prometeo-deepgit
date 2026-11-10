/**
 * Ref pill budget of a log row. The pills may use at most `PILL_SHARE` of the subject column and the subject keeps at
 * least `SUBJECT_MIN_SHARE` of it (and `minSubject` px). When the pills do not fit they collapse to the leading pills
 * that do (at least one) plus "+N"; the full list stays in the tooltip.
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
const MORE = 26;
const MAX_PILL = 150;
const MAX_SPLIT = 220;

const KIND_ORDER: Record<RefLabel["kind"], number> = { head: 0, local: 1, remote: 2, tag: 3, stash: 4 };

/** Pixels the pills of a row may use inside a subject column of `subjectWidth` px. */
export function pillBudget(subjectWidth: number, minSubject: number): number {
  const w = Math.max(0, subjectWidth);
  const keep = Math.max(minSubject, w * SUBJECT_MIN_SHARE);
  return Math.max(0, Math.min(w * PILL_SHARE, w - keep));
}

/** Estimated widths of the pills `RefPills` shows (same order and merging of a local branch with its remote). */
export function pillWidths(refs: readonly RefLabel[]): number[] {
  const sorted = [...refs].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const locals = sorted.filter((r) => r.kind === "local").map((r) => r.name);
  const syncedRemote = (name: string) => locals.some((n) => name === "origin/" + n || name.endsWith("/" + n));
  const out: number[] = [];
  for (const r of sorted) {
    if (r.kind === "remote" && syncedRemote(r.name)) continue;
    const synced = r.kind === "local" && sorted.some((x) => x.kind === "remote" && (x.name === "origin/" + r.name || x.name.endsWith("/" + r.name)));
    const text = r.name.length * CHAR;
    if (r.kind === "local" && r.isCurrent) out.push(Math.min(MAX_SPLIT, HEAD_LABEL + PAD + ICON + text + (synced ? ICON : 0)));
    else out.push(Math.min(MAX_PILL, PAD + (r.kind === "head" ? 0 : ICON) + text + (synced ? ICON : 0)));
  }
  return out;
}

/** How many pills to show before "+N": all when they fit in `budget`, otherwise as many as fit with the "+N" chip, at least one. */
export function visiblePills(widths: readonly number[], budget: number): number {
  const n = widths.length;
  if (n <= 1) return n;
  let total = 0;
  for (const w of widths) total += w;
  total += GAP * (n - 1);
  if (total <= budget) return n;
  let used = 0;
  let k = 0;
  while (k < n - 1) {
    const next = used + (k > 0 ? GAP : 0) + widths[k];
    if (next + GAP + MORE > budget) break;
    used = next;
    k++;
  }
  return Math.max(1, k);
}
