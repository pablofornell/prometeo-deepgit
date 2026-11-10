// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NARROW_DIFF_PX, WIDE_DIFF_PX, effectiveDiffMode } from "./diffMode";

const MID = (NARROW_DIFF_PX + WIDE_DIFF_PX) / 2;

describe("effectiveDiffMode", () => {
  it("uses the saved mode in a wide pane", () => {
    expect(effectiveDiffMode(null, "sideBySide", 1000)).toBe("sideBySide");
    expect(effectiveDiffMode(null, "unified", 1000)).toBe("unified");
  });
  it("falls back to unified in a narrow pane when nothing was chosen this session", () => {
    expect(effectiveDiffMode(null, "sideBySide", NARROW_DIFF_PX - 1)).toBe("unified");
    expect(effectiveDiffMode(null, "sideBySide", NARROW_DIFF_PX - 1, "sideBySide")).toBe("unified");
  });
  it("keeps an explicit choice at any width", () => {
    expect(effectiveDiffMode("sideBySide", "unified", 400)).toBe("sideBySide");
    expect(effectiveDiffMode("unified", "sideBySide", 1400)).toBe("unified");
    expect(effectiveDiffMode("sideBySide", "sideBySide", MID, "unified")).toBe("sideBySide");
    expect(effectiveDiffMode("unified", "sideBySide", MID, "sideBySide")).toBe("unified");
  });
  it("ignores an unknown width (hidden pane): keeps the shown layout, else the saved one", () => {
    expect(effectiveDiffMode(null, "sideBySide", 0)).toBe("sideBySide");
    expect(effectiveDiffMode(null, "sideBySide", 0, "unified")).toBe("unified");
    expect(effectiveDiffMode(null, "unified", 0, "sideBySide")).toBe("sideBySide");
  });

  describe("hysteresis band", () => {
    it("stays unified after a narrow fallback until the pane is clearly wide", () => {
      expect(effectiveDiffMode(null, "sideBySide", NARROW_DIFF_PX, "unified")).toBe("unified");
      expect(effectiveDiffMode(null, "sideBySide", MID, "unified")).toBe("unified");
      expect(effectiveDiffMode(null, "sideBySide", WIDE_DIFF_PX - 1, "unified")).toBe("unified");
      expect(effectiveDiffMode(null, "sideBySide", WIDE_DIFF_PX, "unified")).toBe("sideBySide");
    });
    it("keeps side by side inside the band when widening or narrowing from a wide pane", () => {
      expect(effectiveDiffMode(null, "sideBySide", WIDE_DIFF_PX - 1, "sideBySide")).toBe("sideBySide");
      expect(effectiveDiffMode(null, "sideBySide", NARROW_DIFF_PX, "sideBySide")).toBe("sideBySide");
    });
    it("shows the saved mode when nothing is shown yet", () => {
      expect(effectiveDiffMode(null, "sideBySide", MID)).toBe("sideBySide");
      expect(effectiveDiffMode(null, "unified", MID)).toBe("unified");
    });
    it("never shows side by side inside the band when the saved mode is unified", () => {
      expect(effectiveDiffMode(null, "unified", MID, "sideBySide")).toBe("unified");
    });
    it("walks a drag from narrow to wide and back without flipping inside the band", () => {
      const widths = [400, 700, 719, 720, 760, 819, 820, 900, 819, 760, 720, 719, 600];
      let shown: "unified" | "sideBySide" | null = null;
      const seen: string[] = [];
      for (const w of widths) {
        shown = effectiveDiffMode(null, "sideBySide", w, shown);
        seen.push(shown === "unified" ? "u" : "s");
      }
      //            400  700  719  720  760  819  820  900  819  760  720  719  600
      expect(seen).toEqual(["u", "u", "u", "u", "u", "u", "s", "s", "s", "s", "s", "u", "u"]);
    });
  });
});
