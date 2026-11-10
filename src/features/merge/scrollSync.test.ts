import { describe, expect, it } from "vitest";
import { MergeModel } from "./model";
import { COL, anchorsOf, mapLine } from "./scrollSync";

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");

describe("scroll sync anchors", () => {
  // Theirs adds 4 lines at line 10, Yours changes line 20
  const base = lines(30, (i) => `line ${i}`);
  const right = base.replace("line 9\n", "line 9\nnew a\nnew b\nnew c\nnew d\n");
  const left = base.replace("line 20", "LINE 20");
  const model = new MergeModel(base, left, right);
  const a = anchorsOf(model);

  it("starts at the top and ends at the totals", () => {
    expect(a[0]).toEqual([0, 0, 0]);
    expect(a[a.length - 1]).toEqual([30, 30, 34]);
  });

  it("never goes back in any column", () => {
    for (let i = 1; i < a.length; i++) for (const c of [0, 1, 2]) expect(a[i][c]).toBeGreaterThanOrEqual(a[i - 1][c]);
  });

  it("maps a line before a change one to one and a line after it with the offset", () => {
    expect(mapLine(a, COL.result, COL.right, 5)).toBe(5);
    expect(mapLine(a, COL.result, COL.right, 25)).toBe(29);
    expect(mapLine(a, COL.right, COL.result, 29)).toBe(25);
    expect(mapLine(a, COL.left, COL.right, 25)).toBe(29);
  });

  it("the start of a change is at the same place in every pane", () => {
    const c = model.chunks[0];
    expect(mapLine(a, COL.result, COL.right, c.start)).toBe(c.right.start);
    expect(mapLine(a, COL.right, COL.result, c.right.start)).toBe(c.start);
  });

  it("goes linearly through a change that has another length in each pane", () => {
    const c = model.chunks[0]; // result 0 lines (inserted), theirs 4 lines
    expect(c.end - c.start).toBe(0);
    expect(c.right.end - c.right.start).toBe(4);
    // the whole inserted block in Theirs sits at the one line of the Result
    expect(mapLine(a, COL.right, COL.result, c.right.start + 2)).toBe(c.start);
    expect(mapLine(a, COL.right, COL.result, c.right.end)).toBe(c.end);
  });

  it("continues past the last anchor", () => {
    expect(mapLine(a, COL.result, COL.right, 32)).toBe(36);
  });
});
