// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NARROW_DIFF_PX, effectiveDiffMode } from "./diffMode";

describe("effectiveDiffMode", () => {
  it("uses the saved mode in a wide pane", () => {
    expect(effectiveDiffMode(null, "sideBySide", 1000)).toBe("sideBySide");
    expect(effectiveDiffMode(null, "unified", 1000)).toBe("unified");
  });
  it("falls back to unified in a narrow pane when nothing was chosen this session", () => {
    expect(effectiveDiffMode(null, "sideBySide", NARROW_DIFF_PX - 1)).toBe("unified");
    expect(effectiveDiffMode(null, "sideBySide", NARROW_DIFF_PX)).toBe("sideBySide");
  });
  it("keeps an explicit choice at any width", () => {
    expect(effectiveDiffMode("sideBySide", "unified", 400)).toBe("sideBySide");
    expect(effectiveDiffMode("unified", "sideBySide", 1400)).toBe("unified");
  });
  it("ignores an unknown width (hidden pane)", () => {
    expect(effectiveDiffMode(null, "sideBySide", 0)).toBe("sideBySide");
  });
});
