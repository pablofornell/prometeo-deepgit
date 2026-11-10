// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_RATIOS, allocate, maxBottom, ratioFor, sanitizeRatios } from "./heights";

const mins = { top: 260, bottom: 120 };

describe("allocate", () => {
  it("splits by ratio when there is room", () => {
    const h = allocate(832, 6, true, DEFAULT_RATIOS, mins);
    expect(h.available).toBe(826);
    expect(h.bottom).toBe(165);
    expect(h.top).toBe(826 - 165);
    expect(h.top).toBeGreaterThanOrEqual(mins.top);
  });
  it("gives the whole column to the main row when the bottom window is hidden", () => {
    expect(allocate(600, 6, false, DEFAULT_RATIOS, mins)).toEqual({ top: 600, bottom: 0, available: 600 });
  });
  it("shrinks the bottom window when the main row would get too short", () => {
    const h = allocate(500, 6, true, { bottom: 0.6 }, mins);
    expect(h.top).toBe(mins.top);
    expect(h.bottom).toBe(494 - 260);
  });
  it("never goes below the minimum of the bottom window", () => {
    const h = allocate(300, 6, true, { bottom: 0.1 }, mins);
    expect(h.bottom).toBe(mins.bottom);
  });
});

describe("helpers", () => {
  it("sanitizes persisted ratios", () => {
    expect(sanitizeRatios(null)).toEqual(DEFAULT_RATIOS);
    expect(sanitizeRatios({ bottom: 0.35 })).toEqual({ bottom: 0.35 });
    expect(sanitizeRatios({ bottom: 0.95 })).toEqual(DEFAULT_RATIOS);
    expect(sanitizeRatios({ bottom: NaN as number })).toEqual(DEFAULT_RATIOS);
    expect(sanitizeRatios({ bottom: -1 })).toEqual(DEFAULT_RATIOS);
  });
  it("migrates the old { diff, bottom } value and ignores unknown keys", () => {
    expect(sanitizeRatios({ diff: 0.3, bottom: 0.25, extra: 1 } as unknown as Partial<{ bottom: number }>)).toEqual({ bottom: 0.25 });
    expect(sanitizeRatios({ diff: 0.3 } as unknown as Partial<{ bottom: number }>)).toEqual(DEFAULT_RATIOS);
  });
  it("converts a size to a ratio", () => {
    expect(ratioFor(205, 820)).toBeCloseTo(0.25);
    expect(ratioFor(10, 0)).toBe(0);
  });
  it("limits the bottom window so the main row keeps its minimum", () => {
    const h = allocate(832, 6, true, DEFAULT_RATIOS, mins);
    expect(maxBottom(h, mins)).toBe(826 - 260);
    expect(maxBottom({ top: 0, bottom: 0, available: 100 }, mins)).toBe(mins.bottom);
  });
});
