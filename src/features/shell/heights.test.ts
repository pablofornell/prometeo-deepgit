// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_RATIOS, allocate, maxFor, ratioFor, sanitizeRatios } from "./heights";

const mins = { top: 260, diff: 160, bottom: 120 };

describe("allocate", () => {
  it("splits by ratio when there is room", () => {
    const h = allocate(832, 6, true, true, DEFAULT_RATIOS, mins);
    expect(h.available).toBe(820);
    expect(h.diff).toBe(246);
    expect(h.bottom).toBe(164);
    expect(h.top).toBe(820 - 246 - 164);
    expect(h.top).toBeGreaterThanOrEqual(mins.top);
  });
  it("gives the whole column to the main row when nothing else is visible", () => {
    expect(allocate(600, 6, false, false, DEFAULT_RATIOS, mins)).toEqual({ top: 600, diff: 0, bottom: 0, available: 600 });
  });
  it("shrinks the bottom window first, then the diff", () => {
    const h = allocate(560, 6, true, true, { diff: 0.4, bottom: 0.4 }, mins);
    expect(h.top).toBeGreaterThanOrEqual(mins.top);
    expect(h.bottom).toBe(mins.bottom);
    expect(h.diff).toBe(548 - 260 - 120);
    const tight = allocate(552, 6, true, true, { diff: 0.4, bottom: 0.4 }, mins);
    expect(tight).toMatchObject({ top: 260, diff: 160, bottom: 120 });
  });
  it("never goes below the minimums of the optional parts", () => {
    const h = allocate(300, 6, true, true, { diff: 0.1, bottom: 0.1 }, mins);
    expect(h.diff).toBeGreaterThanOrEqual(160);
    expect(h.bottom).toBeGreaterThanOrEqual(120);
  });
  it("works with only the bottom window", () => {
    const h = allocate(700, 6, false, true, DEFAULT_RATIOS, mins);
    expect(h.bottom + h.top).toBe(694);
    expect(h.top).toBeGreaterThanOrEqual(260);
  });
});

describe("helpers", () => {
  it("sanitizes persisted ratios", () => {
    expect(sanitizeRatios(null)).toEqual(DEFAULT_RATIOS);
    expect(sanitizeRatios({ diff: 0.5, bottom: 0.5 })).toEqual(DEFAULT_RATIOS);
    expect(sanitizeRatios({ diff: 0.3, bottom: 0.2 })).toEqual({ diff: 0.3, bottom: 0.2 });
    expect(sanitizeRatios({ diff: NaN as number, bottom: -1 })).toEqual(DEFAULT_RATIOS);
  });
  it("converts a size to a ratio", () => {
    expect(ratioFor(205, 820)).toBeCloseTo(0.25);
    expect(ratioFor(10, 0)).toBe(0);
  });
  it("limits a part so the main row keeps its minimum", () => {
    const h = allocate(832, 6, true, true, DEFAULT_RATIOS, mins);
    expect(maxFor("diff", h, mins, true, true)).toBe(820 - 260 - h.bottom);
    expect(maxFor("bottom", h, mins, true, true)).toBe(820 - 260 - h.diff);
  });
});
