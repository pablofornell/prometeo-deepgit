import { describe, expect, it } from "vitest";
import { MAX_EDITS, diffSeq, intern, mergeRanges, type DiffRange } from "./seqDiff";

const chars = (s: string) => [...s];

function apply(a: string[], b: string[], ranges: DiffRange[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (const r of ranges) {
    out.push(...a.slice(at, r.start1), ...b.slice(r.start2, r.end2));
    at = r.end1;
  }
  out.push(...a.slice(at));
  return out;
}

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp[0][0];
}

/** Small deterministic generator, so a failure can be replayed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("diffSeq", () => {
  it("returns nothing for equal input and one range for an empty side", () => {
    expect(diffSeq(chars("abc"), chars("abc"))).toEqual([]);
    expect(diffSeq([], [])).toEqual([]);
    expect(diffSeq([], chars("ab"))).toEqual([{ start1: 0, end1: 0, start2: 0, end2: 2 }]);
    expect(diffSeq(chars("ab"), [])).toEqual([{ start1: 0, end1: 2, start2: 0, end2: 0 }]);
  });

  it("finds a single replacement, insertion and deletion", () => {
    expect(diffSeq(chars("abc"), chars("aXc"))).toEqual([{ start1: 1, end1: 2, start2: 1, end2: 2 }]);
    expect(diffSeq(chars("ac"), chars("abc"))).toEqual([{ start1: 1, end1: 1, start2: 1, end2: 2 }]);
    expect(diffSeq(chars("abc"), chars("ac"))).toEqual([{ start1: 1, end1: 2, start2: 1, end2: 1 }]);
  });

  it("is a shortest edit script and reproduces b (random inputs)", () => {
    const r = rng(7);
    for (let t = 0; t < 400; t++) {
      const len = () => Math.floor(r() * 14);
      const a = Array.from({ length: len() }, () => "abcd"[Math.floor(r() * 4)]);
      const b = Array.from({ length: len() }, () => "abcd"[Math.floor(r() * 4)]);
      const ranges = diffSeq(a, b);
      expect(apply(a, b, ranges)).toEqual(b);
      const edits = ranges.reduce((n, x) => n + (x.end1 - x.start1) + (x.end2 - x.start2), 0);
      expect(edits).toBe(a.length + b.length - 2 * lcs(a, b));
      // ranges are ordered and never touch
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i].start1 > ranges[i - 1].end1 || ranges[i].start2 > ranges[i - 1].end2).toBe(true);
      }
    }
  });

  it("handles long inputs with a few edits quickly", () => {
    const a = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[100] = "changed";
    b.splice(5000, 0, "inserted");
    b.splice(15000, 3);
    const ranges = diffSeq(a, b);
    expect(apply(a, b, ranges)).toEqual(b);
    expect(ranges).toHaveLength(3);
  });

  it("falls back to one change when the files are entirely different", () => {
    const n = MAX_EDITS + 200;
    const a = Array.from({ length: n }, (_, i) => `a${i}`);
    const b = Array.from({ length: n }, (_, i) => `b${i}`);
    const ranges = diffSeq(a, b);
    expect(ranges).toEqual([{ start1: 0, end1: n, start2: 0, end2: n }]);
  });

  it("interns equal strings to equal numbers", () => {
    const [x, y] = intern(["a", "b", "a"], ["b", "c"]);
    expect(x).toEqual([0, 1, 0]);
    expect(y).toEqual([1, 2]);
  });
});

describe("mergeRanges", () => {
  const lines = (s: string) => (s === "" ? [] : s.split(""));

  it("is empty when nothing changed", () => {
    expect(mergeRanges(lines("abc"), lines("abc"), lines("abc"))).toEqual([]);
  });

  it("reports a change of one side only", () => {
    expect(mergeRanges(lines("abc"), lines("aXc"), lines("abc"))).toEqual([{ left: [1, 2], base: [1, 2], right: [1, 2] }]);
    expect(mergeRanges(lines("abc"), lines("abc"), lines("ac"))).toEqual([{ left: [1, 2], base: [1, 2], right: [1, 1] }]);
  });

  it("keeps separate changes of the two sides apart", () => {
    const r = mergeRanges(lines("abcde"), lines("aXcde"), lines("abcdY"));
    expect(r).toEqual([
      { left: [1, 2], base: [1, 2], right: [1, 2] },
      { left: [4, 5], base: [4, 5], right: [4, 5] },
    ]);
  });

  it("joins overlapping changes into one range", () => {
    // left changes b..c, right changes c..d: one region b..d
    const r = mergeRanges(lines("abcde"), lines("aXYde"), lines("abZWe"));
    expect(r).toEqual([{ left: [1, 4], base: [1, 4], right: [1, 4] }]);
  });

  it("covers inserted lines at the end and an empty base", () => {
    expect(mergeRanges(lines("ab"), lines("abc"), lines("ab"))).toEqual([{ left: [2, 3], base: [2, 2], right: [2, 2] }]);
    expect(mergeRanges(lines(""), lines("x"), lines("y"))).toEqual([{ left: [0, 1], base: [0, 0], right: [0, 1] }]);
  });

  it("ranges are ordered, disjoint, and the gaps are equal in all three versions", () => {
    const r = rng(11);
    for (let t = 0; t < 300; t++) {
      const base = Array.from({ length: Math.floor(r() * 12) }, () => "abc"[Math.floor(r() * 3)]);
      const mutate = (x: string[]) => {
        const y = [...x];
        for (let k = 0; k < 3; k++) {
          const at = Math.floor(r() * (y.length + 1));
          if (r() < 0.5) y.splice(at, Math.floor(r() * 3));
          else y.splice(at, 0, "xyz"[Math.floor(r() * 3)]);
        }
        return y;
      };
      const left = mutate(base);
      const right = mutate(base);
      const ranges = mergeRanges(base, left, right);
      let l = 0;
      let b = 0;
      let rr = 0;
      for (const m of ranges) {
        // the gap before the range is unchanged
        expect(m.base[0] - b).toBe(m.left[0] - l);
        expect(m.base[0] - b).toBe(m.right[0] - rr);
        expect(left.slice(l, m.left[0])).toEqual(base.slice(b, m.base[0]));
        expect(right.slice(rr, m.right[0])).toEqual(base.slice(b, m.base[0]));
        [l, b, rr] = [m.left[1], m.base[1], m.right[1]];
      }
      expect(left.slice(l)).toEqual(base.slice(b));
      expect(right.slice(rr)).toEqual(base.slice(b));
    }
  });
});
