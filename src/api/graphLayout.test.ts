// @vitest-environment node
import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphInput } from "./graphLayout";

const row = (key: string, ...parents: string[]): GraphInput => ({ key, parents });

describe("layoutGraph", () => {
  it("lays a linear history in lane 0 with one colour", () => {
    const { rows, maxLanes } = layoutGraph([row("c", "b"), row("b", "a"), row("a")]);
    expect(rows.map((r) => r.node)).toEqual([0, 0, 0]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
    expect(maxLanes).toBe(1);
    // first row: new lane, only the bottom half is drawn
    expect(rows[0].segments).toEqual([{ x1: 0, y1: 1, x2: 0, y2: 2, color: 0 }]);
    // middle row: top half + bottom half
    expect(rows[1].segments).toEqual([
      { x1: 0, y1: 0, x2: 0, y2: 1, color: 0 },
      { x1: 0, y1: 1, x2: 0, y2: 2, color: 0 },
    ]);
    // root commit: no segment below the node
    expect(rows[2].segments).toEqual([{ x1: 0, y1: 0, x2: 0, y2: 1, color: 0 }]);
  });

  it("opens a second lane for the second parent of a merge and joins it at the fork", () => {
    //   m (parents a, f)
    //   |\
    //   a f
    //   |/
    //   r
    const { rows, maxLanes } = layoutGraph([row("m", "a", "f"), row("a", "r"), row("f", "r"), row("r")]);
    expect(maxLanes).toBe(2);
    const merge = rows[0];
    expect(merge.node).toBe(0);
    expect(merge.segments).toContainEqual({ x1: 0, y1: 1, x2: 0, y2: 2, color: merge.color });
    const toSecond = merge.segments.find((s) => s.x2 === 1);
    expect(toSecond).toBeDefined();
    expect(toSecond?.color).not.toBe(merge.color);
    // a stays in lane 0, f is in lane 1
    expect(rows[1].node).toBe(0);
    expect(rows[2].node).toBe(1);
    // f curves back into the lane that already expects r; r then sits in lane 0
    expect(rows[2].segments).toContainEqual({ x1: 1, y1: 1, x2: 0, y2: 2, color: rows[0].color });
    expect(rows[3].node).toBe(0);
  });

  it("draws pass-through lanes for lanes that are not on the node", () => {
    const { rows } = layoutGraph([row("m", "a", "f"), row("f", "r"), row("a", "r"), row("r")]);
    // row 1 is f (lane 1); lane 0 (expects a) passes through
    expect(rows[1].node).toBe(1);
    expect(rows[1].segments).toContainEqual({ x1: 0, y1: 0, x2: 0, y2: 2, color: rows[0].color });
  });

  it("reports width as the highest used column + 1", () => {
    const { rows } = layoutGraph([row("m", "a", "b"), row("a"), row("b")]);
    expect(rows[0].width).toBe(2);
    expect(rows[2].width).toBe(2);
  });

  it("starts a fresh lane with a new colour for an unrelated tip", () => {
    const { rows } = layoutGraph([row("x", "p"), row("y", "q"), row("p"), row("q")]);
    expect(rows[0].node).toBe(0);
    expect(rows[1].node).toBe(1);
    expect(rows[1].color).not.toBe(rows[0].color);
    // p is on lane 0, q on lane 1
    expect(rows[2].node).toBe(0);
    expect(rows[3].node).toBe(1);
  });

  it("reuses freed slots (leftmost first) and trims trailing lanes", () => {
    const { rows } = layoutGraph([row("x", "p"), row("p"), row("y", "q"), row("q")]);
    expect(rows.map((r) => r.node)).toEqual([0, 0, 0, 0]);
    expect(rows[2].width).toBe(1);
  });

  it("honours colour hints for new lanes", () => {
    const { rows } = layoutGraph([row("x"), row("y")], [7, undefined]);
    expect(rows[0].color).toBe(7);
    expect(rows[1].color).toBe(0);
  });

  it("stableFirstParent keeps a first-parent chain in its column when a branch lane expects the same parent", () => {
    const input = [row("M", "Y2", "B2"), row("Y2", "Y1"), row("B2", "B1"), row("B1", "X"), row("Y1", "X"), row("X")];
    // PLAN.md section 6: the chain moves into the branch lane (column 1)
    expect(layoutGraph(input).rows[5].node).toBe(1);
    // with the option it stays in column 0 and both lanes converge on X
    const stable = layoutGraph(input, [], { stableFirstParent: true });
    expect(stable.rows[5].node).toBe(0);
    expect(stable.rows[5].segments.filter((s) => s.y1 === 0 && s.y2 === 1).map((s) => s.x1).sort()).toEqual([0, 1]);
  });

  it("handles a large linear history quickly", () => {
    const n = 20000;
    const input: GraphInput[] = [];
    for (let i = 0; i < n; i++) input.push(row("c" + i, i + 1 < n ? "c" + (i + 1) : ""));
    input[n - 1] = row("c" + (n - 1));
    const t0 = performance.now();
    const { maxLanes } = layoutGraph(input);
    expect(maxLanes).toBe(1);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
