// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pointerRatio, stepToward, targetScrollLeft } from "./pointerScroll";

describe("pointerRatio", () => {
  it("is 0 in the left edge band and 1 in the right edge band", () => {
    // pane from x=100, 400 px wide, 32 px edge bands
    expect(pointerRatio(100, 100, 400)).toBe(0);
    expect(pointerRatio(131, 100, 400)).toBe(0);
    expect(pointerRatio(500, 100, 400)).toBe(1);
    expect(pointerRatio(468, 100, 400)).toBe(1);
  });

  it("maps the middle of the inner band linearly", () => {
    // inner band: x from 132 to 468 (336 px); the centre is x=300
    expect(pointerRatio(300, 100, 400)).toBeCloseTo(0.5, 10);
    expect(pointerRatio(216, 100, 400)).toBeCloseTo(0.25, 10);
  });

  it("clamps pointers outside the pane", () => {
    expect(pointerRatio(0, 100, 400)).toBe(0);
    expect(pointerRatio(9999, 100, 400)).toBe(1);
  });

  it("uses the whole width when the pane is narrower than the two edge bands", () => {
    // 40 px wide, edges would take 64 px: plain ratio over the width
    expect(pointerRatio(120, 100, 40)).toBeCloseTo(0.5, 10);
    expect(pointerRatio(100, 100, 40)).toBe(0);
  });

  it("is 0 for a pane with no width", () => {
    expect(pointerRatio(50, 100, 0)).toBe(0);
  });
});

describe("targetScrollLeft", () => {
  it("scales the ratio by the overflow", () => {
    expect(targetScrollLeft(300, 100, 400, 1000)).toBeCloseTo(500, 6);
    expect(targetScrollLeft(100, 100, 400, 1000)).toBe(0);
    expect(targetScrollLeft(500, 100, 400, 1000)).toBe(1000);
  });

  it("returns 0 when there is no overflow", () => {
    expect(targetScrollLeft(500, 100, 400, 0)).toBe(0);
    expect(targetScrollLeft(500, 100, 400, -5)).toBe(0);
    expect(targetScrollLeft(500, 100, 400, Number.NaN)).toBe(0);
  });

  it("honours a custom edge band", () => {
    // edge 0: plain ratio over the whole pane
    expect(targetScrollLeft(200, 100, 400, 1000, 0)).toBeCloseTo(250, 6);
  });
});

describe("stepToward", () => {
  it("moves a fraction of the distance per step", () => {
    expect(stepToward(0, 100)).toBeCloseTo(20, 10);
    expect(stepToward(0, 100, 0.5)).toBe(50);
    expect(stepToward(100, 0)).toBeCloseTo(80, 10);
  });

  it("snaps to the target when less than half a pixel away", () => {
    expect(stepToward(99.6, 100)).toBe(100);
    expect(stepToward(100.4, 100)).toBe(100);
    expect(stepToward(100, 100)).toBe(100);
  });

  it("reaches the target after a bounded number of steps", () => {
    let pos = 0;
    let steps = 0;
    while (pos !== 1000 && steps < 1000) {
      pos = stepToward(pos, 1000);
      steps++;
    }
    expect(pos).toBe(1000);
    expect(steps).toBeLessThan(60);
  });
});
