/**
 * Appearance maths: limits, validation and the CSS variables derived from the user's sizes. Pure (no DOM, no store),
 * so it can be tested under node. `settings.ts` applies the result; `index.html` repeats the same few lines before
 * first paint (a test keeps both in sync).
 *
 * One base size drives everything:
 *   --dg-font-base       UI font size in px (10..20, default 13)
 *   --dg-text-scale      font-base / 13: every text-dependent token in tokens.css is `N * --dg-u` (1 px * text-scale)
 *   --dg-editor-font-base  mono size of diff, console, hashes (10..20, default 12; follows the UI size until set)
 *   --dg-ui-scale        page zoom as a number (0.8..2); used by the shell minimum size
 */

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_DEFAULT = 13;
/** Mono size at the default UI size. */
export const EDITOR_FONT_SIZE_DEFAULT = 12;

/** UI scale is stored in percent. */
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_STEP = 10;
export const UI_SCALE_DEFAULT = 100;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Whole number inside `[min, max]`; anything that is not a finite number becomes `fallback`. */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (!isNum(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export const sanitizeFontSize = (v: unknown): number => clampInt(v, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT);

/** `null` = follow the UI font size. */
export function sanitizeEditorFontSize(v: unknown): number | null {
  return isNum(v) ? clampInt(v, FONT_SIZE_MIN, FONT_SIZE_MAX, EDITOR_FONT_SIZE_DEFAULT) : null;
}

/** Percent, rounded to the step. */
export function sanitizeUiScale(v: unknown): number {
  if (!isNum(v)) return UI_SCALE_DEFAULT;
  const stepped = Math.round(v / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped));
}

/** Mono size that keeps the 12:13 ratio of the defaults. */
export function followedEditorFontSize(fontSize: number): number {
  return clampInt(Math.round((fontSize * EDITOR_FONT_SIZE_DEFAULT) / FONT_SIZE_DEFAULT), FONT_SIZE_MIN, FONT_SIZE_MAX, EDITOR_FONT_SIZE_DEFAULT);
}

/** Mono size in use: the explicit choice, or the followed one. */
export const effectiveEditorFontSize = (fontSize: number, editor: number | null): number => editor ?? followedEditorFontSize(fontSize);

/** `font size / 13`, the factor behind `--dg-u`. */
export const textScale = (fontSize: number): number => fontSize / FONT_SIZE_DEFAULT;

/** Next UI scale one step up or down, kept inside the limits. */
export const stepUiScale = (current: number, dir: 1 | -1): number => sanitizeUiScale(current + dir * UI_SCALE_STEP);

export interface AppearanceInput {
  fontSize: number;
  editorFontSize: number | null;
  uiScale: number;
}

/** CSS custom properties to set on `<html>`. */
export function appearanceVars(a: AppearanceInput): Record<string, string> {
  const font = sanitizeFontSize(a.fontSize);
  return {
    "--dg-font-base": `${font}px`,
    "--dg-text-scale": String(Math.round(textScale(font) * 10000) / 10000),
    "--dg-editor-font-base": `${effectiveEditorFontSize(font, sanitizeEditorFontSize(a.editorFontSize))}px`,
    "--dg-ui-scale": String(sanitizeUiScale(a.uiScale) / 100),
  };
}
