// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EDITOR_FONT_SIZE_DEFAULT, FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN,
  appearanceVars, clampInt, effectiveEditorFontSize, followedEditorFontSize, sanitizeEditorFontSize, sanitizeFontSize, sanitizeTintStrength, sanitizeUiScale,
  stepUiScale, textScale,
} from "./appearance";

describe("clampInt", () => {
  it("rounds and clamps numbers, falls back for everything else", () => {
    expect(clampInt(13.4, 10, 20, 13)).toBe(13);
    expect(clampInt(13.6, 10, 20, 13)).toBe(14);
    expect(clampInt(-5, 10, 20, 13)).toBe(10);
    expect(clampInt(999, 10, 20, 13)).toBe(20);
    for (const bad of [NaN, Infinity, "15", null, undefined, {}, [], true]) expect(clampInt(bad, 10, 20, 13)).toBe(13);
  });
});

describe("sanitizers", () => {
  it("font size: clamp to 10..20, default 13", () => {
    expect(sanitizeFontSize(FONT_SIZE_DEFAULT)).toBe(13);
    expect(sanitizeFontSize(9)).toBe(FONT_SIZE_MIN);
    expect(sanitizeFontSize(21)).toBe(FONT_SIZE_MAX);
    expect(sanitizeFontSize("big")).toBe(13);
    expect(sanitizeFontSize(NaN)).toBe(13);
  });
  it("editor font size: number is clamped, anything else means follow (null)", () => {
    expect(sanitizeEditorFontSize(14)).toBe(14);
    expect(sanitizeEditorFontSize(2)).toBe(FONT_SIZE_MIN);
    expect(sanitizeEditorFontSize(100)).toBe(FONT_SIZE_MAX);
    for (const v of [null, undefined, "12", NaN, {}]) expect(sanitizeEditorFontSize(v)).toBeNull();
  });
  it("ui scale: percent, step 10, 80..200, default 100", () => {
    expect(sanitizeUiScale(100)).toBe(UI_SCALE_DEFAULT);
    expect(sanitizeUiScale(105)).toBe(110);
    expect(sanitizeUiScale(10)).toBe(UI_SCALE_MIN);
    expect(sanitizeUiScale(500)).toBe(UI_SCALE_MAX);
    expect(sanitizeUiScale("150")).toBe(100);
    expect(sanitizeUiScale(Infinity)).toBe(100);
  });
  it("stepUiScale moves by 10 and stops at the limits", () => {
    expect(stepUiScale(100, 1)).toBe(110);
    expect(stepUiScale(100, -1)).toBe(90);
    expect(stepUiScale(UI_SCALE_MAX, 1)).toBe(UI_SCALE_MAX);
    expect(stepUiScale(UI_SCALE_MIN, -1)).toBe(UI_SCALE_MIN);
  });
});

describe("derived sizes", () => {
  it("text scale is font size / 13", () => {
    expect(textScale(13)).toBe(1);
    expect(textScale(26)).toBe(2);
  });
  it("the editor size follows the UI size with the 12:13 ratio and stays in range", () => {
    expect(followedEditorFontSize(13)).toBe(EDITOR_FONT_SIZE_DEFAULT);
    expect(followedEditorFontSize(18)).toBe(17);
    expect(followedEditorFontSize(20)).toBe(18);
    expect(followedEditorFontSize(10)).toBe(FONT_SIZE_MIN); // 9.2 would be below the range
    expect(effectiveEditorFontSize(18, null)).toBe(17);
    expect(effectiveEditorFontSize(18, 12)).toBe(12);
  });
  it("appearanceVars writes the five variables, validated", () => {
    expect(appearanceVars({ fontSize: 13, editorFontSize: null, uiScale: 100 })).toEqual({
      "--dg-font-base": "13px", "--dg-text-scale": "1", "--dg-editor-font-base": "12px", "--dg-ui-scale": "1", "--dg-repo-tint-k": "1",
    });
    expect(appearanceVars({ fontSize: 18, editorFontSize: 15, uiScale: 150 })).toEqual({
      "--dg-font-base": "18px", "--dg-text-scale": "1.3846", "--dg-editor-font-base": "15px", "--dg-ui-scale": "1.5", "--dg-repo-tint-k": "1",
    });
    expect(appearanceVars({ fontSize: 99, editorFontSize: NaN as unknown as number, uiScale: 7 })).toEqual({
      "--dg-font-base": "20px", "--dg-text-scale": "1.5385", "--dg-editor-font-base": "18px", "--dg-ui-scale": "0.8", "--dg-repo-tint-k": "1",
    });
    expect(appearanceVars({ fontSize: 13, editorFontSize: null, uiScale: 100, repoTintStrength: 150 })["--dg-repo-tint-k"]).toBe("1.5");
  });
});

describe("tint strength", () => {
  it("is rounded to steps of 25 inside 0..200 and falls back to 100", () => {
    expect(sanitizeTintStrength(100)).toBe(100);
    expect(sanitizeTintStrength(0)).toBe(0);
    expect(sanitizeTintStrength(112)).toBe(100);
    expect(sanitizeTintStrength(113)).toBe(125);
    expect(sanitizeTintStrength(-50)).toBe(0);
    expect(sanitizeTintStrength(900)).toBe(200);
    expect(sanitizeTintStrength("high")).toBe(100);
    expect(sanitizeTintStrength(null)).toBe(100);
    expect(sanitizeTintStrength(NaN)).toBe(100);
  });
  it("the variable is the percent divided by 100", () => {
    const k = (v: number) => appearanceVars({ fontSize: 13, editorFontSize: null, uiScale: 100, repoTintStrength: v })["--dg-repo-tint-k"];
    expect([k(0), k(25), k(100), k(200)]).toEqual(["0", "0.25", "1", "2"]);
  });
});
