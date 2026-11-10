// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GraphRow } from "../../api/types";
import { DEFAULT_METRICS as M, autoGraphWidth, laneX, passThroughShape, rowGraphShape, segmentPath } from "./graph";

describe("segmentPath", () => {
  it("draws straight lanes as lines", () => {
    expect(segmentPath(0, 0, 0, 2, M)).toBe("M14 0V24");
    expect(segmentPath(1, 1, 1, 2, M)).toBe("M28 12V24");
  });

  it("draws a lane change as a cubic that starts and ends vertically", () => {
    expect(segmentPath(0, 1, 1, 2, M)).toBe("M14 12C14 18 28 18 28 24");
    expect(segmentPath(2, 0, 0, 1, M)).toBe("M42 0C42 6 14 6 14 12");
  });

  it("scales with the row height", () => {
    expect(segmentPath(0, 0, 0, 2, { ...M, rowHeight: 28 })).toBe("M14 0V28");
  });
});

describe("rowGraphShape", () => {
  const g: GraphRow = {
    node: 1, color: 3, width: 3,
    segments: [
      { x1: 0, y1: 0, x2: 0, y2: 2, color: 0 },
      { x1: 1, y1: 0, x2: 1, y2: 1, color: 3 },
      { x1: 1, y1: 1, x2: 2, y2: 2, color: 3 },
    ],
  };

  it("merges the edges of one colour and places the node", () => {
    const s = rowGraphShape(g, "merge", M);
    expect(s.edges).toHaveLength(2);
    expect(s.edges.find((e) => e.color === 3)?.d).toBe("M28 0V12M28 12C28 18 42 18 42 24");
    expect(s.node).toEqual({ x: laneX(1, M), y: 12, color: 3, kind: "merge" });
  });

  it("builds pass-through lines from the lanes that enter from above", () => {
    expect(passThroughShape(g, M)).toEqual([
      { d: "M14 0V24", color: 0 },
      { d: "M28 0V24", color: 3 },
    ]);
  });
});

describe("autoGraphWidth", () => {
  it("is 16 + lanes x 14 clamped to 30..220", () => {
    expect(autoGraphWidth(0)).toBe(30);
    expect(autoGraphWidth(1)).toBe(30);
    expect(autoGraphWidth(5)).toBe(86);
    expect(autoGraphWidth(40)).toBe(220);
  });
});
