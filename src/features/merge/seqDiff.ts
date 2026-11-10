/**
 * Sequence diff and the three-way merge ranges. Pure, no DOM.
 *
 *   diffSeq(a, b)                       // changed ranges of a -> b (Myers, shortest edit script)
 *   mergeRanges(base, left, right)      // ports IntelliJ's ComparisonMergeUtil.buildSimple
 *
 * Items are compared with `===`; pass interned numbers (see `intern`) to make long sequences fast.
 */

/** `a[start1, end1)` is replaced by `b[start2, end2)`. Either side can be empty (an insertion or a deletion). */
export interface DiffRange {
  start1: number;
  end1: number;
  start2: number;
  end2: number;
}

/** Above this many edits per side-by-side pass the diff gives up and returns one big change (memory guard). */
export const MAX_EDITS = 2500;

/** Maps equal values to equal small integers, so the diff compares numbers instead of strings. */
export function intern(...lists: readonly (readonly string[])[]): number[][] {
  const ids = new Map<string, number>();
  return lists.map((l) =>
    l.map((s) => {
      let id = ids.get(s);
      if (id === undefined) ids.set(s, (id = ids.size));
      return id;
    }),
  );
}

/**
 * Shortest edit script between `a` and `b` as the list of changed ranges, in order and never touching.
 * Common prefix and suffix are trimmed first; beyond `MAX_EDITS` differing items the middle is one change.
 */
export function diffSeq<T>(a: readonly T[], b: readonly T[]): DiffRange[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ start1: pre, end1: pre + n, start2: pre, end2: pre + m }];

  const max = n + m;
  const limit = Math.min(max, MAX_EDITS);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[pre + x] === b[pre + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return [{ start1: pre, end1: pre + n, start2: pre, end2: pre + m }];

  // Walk back from (n, m): in round d the edit came from diagonal prevK, then a run of equal items.
  const out: DiffRange[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snap = trace[d]; // V as it was when round d started
    const at = (k: number) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    if (prevK === k + 1) out.push({ start1: pre + prevX, end1: pre + prevX, start2: pre + prevY, end2: pre + prevY + 1 });
    else out.push({ start1: pre + prevX, end1: pre + prevX + 1, start2: pre + prevY, end2: pre + prevY });
    x = prevX;
    y = prevY;
  }
  out.reverse();
  return mergeTouching(out);
}

/** Joins ranges that touch (a deletion next to an insertion becomes one replacement). */
function mergeTouching(list: DiffRange[]): DiffRange[] {
  const out: DiffRange[] = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && last.end1 === r.start1 && last.end2 === r.start2) {
      last.end1 = r.end1;
      last.end2 = r.end2;
    } else out.push({ ...r });
  }
  return out;
}

// ---------------------------------------------------------------- three-way merge ranges

/** One region where the three versions differ: line ranges `[start, end)` in each of them. */
export interface MergeRange {
  left: [number, number];
  base: [number, number];
  right: [number, number];
}

interface Unchanged {
  /** Base range. */
  b0: number;
  b1: number;
  /** The same lines in the other version. */
  s0: number;
  s1: number;
}

function unchangedOf(changes: readonly DiffRange[], baseLen: number): Unchanged[] {
  const out: Unchanged[] = [];
  let b = 0;
  let s = 0;
  for (const c of changes) {
    if (c.start1 > b) out.push({ b0: b, b1: c.start1, s0: s, s1: s + (c.start1 - b) });
    b = c.end1;
    s = c.end2;
  }
  if (b < baseLen) out.push({ b0: b, b1: baseLen, s0: s, s1: s + (baseLen - b) });
  return out;
}

/**
 * Walks the unchanged runs of base-versus-left and base-versus-right in lockstep; what lies between two
 * runs that both keep the base is a region where at least one side changed (IntelliJ `FairMergeBuilder`).
 * Equal inputs give an empty list.
 */
export function mergeRangesFromDiffs(
  baseLen: number,
  leftLen: number,
  rightLen: number,
  baseToLeft: readonly DiffRange[],
  baseToRight: readonly DiffRange[],
): MergeRange[] {
  const u1 = unchangedOf(baseToLeft, baseLen);
  const u2 = unchangedOf(baseToRight, baseLen);
  const changes: MergeRange[] = [];
  let il = 0;
  let ib = 0;
  let ir = 0;
  const processChange = (el: number, eb: number, er: number) => {
    if (il === el && ib === eb && ir === er) return;
    changes.push({ left: [il, el], base: [ib, eb], right: [ir, er] });
  };
  let i = 0;
  let j = 0;
  while (i < u1.length && j < u2.length) {
    const r1 = u1[i];
    const r2 = u2[j];
    if (r1.b1 <= r2.b0) {
      i++;
      continue;
    }
    if (r2.b1 <= r1.b0) {
      j++;
      continue;
    }
    const startBase = Math.max(r1.b0, r2.b0);
    const endBase = Math.min(r1.b1, r2.b1);
    const count = endBase - startBase;
    const startLeft = r1.s0 + (startBase - r1.b0);
    const startRight = r2.s0 + (startBase - r2.b0);
    processChange(startLeft, startBase, startRight);
    il = startLeft + count;
    ib = endBase;
    ir = startRight + count;
    if (r1.b1 <= r2.b1) i++;
    else j++;
  }
  processChange(leftLen, baseLen, rightLen);
  return changes;
}

/** Merge ranges of three sequences (line arrays or token arrays). */
export function mergeRanges<T>(base: readonly T[], left: readonly T[], right: readonly T[]): MergeRange[] {
  return mergeRangesFromDiffs(base.length, left.length, right.length, diffSeq(base, left), diffSeq(base, right));
}
