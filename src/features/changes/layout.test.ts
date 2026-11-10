// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isCompact } from "./layout";

describe("isCompact", () => {
  it("is false while the list minimum and the full commit box fit", () => {
    expect(isCompact(400, 120, 176)).toBe(false);
    expect(isCompact(296, 120, 176)).toBe(false);
  });
  it("is true when they do not fit", () => {
    expect(isCompact(295, 120, 176)).toBe(true);
    expect(isCompact(150, 120, 176)).toBe(true);
  });
  it("ignores an unmeasured (hidden) island", () => {
    expect(isCompact(0, 120, 176)).toBe(false);
  });
});
