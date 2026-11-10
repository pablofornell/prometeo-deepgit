/**
 * The repo colour palette: names, menu order and the helpers that turn a repo's colour choice into CSS.
 * The colour values live in `colors.css` (`--dg-repo-N` fill, `--dg-repo-N-fg` text); this file only knows
 * the indexes. `PALETTE_SIZE` equals `PALETTE_SIZE` in `crates/gitcore/src/discover.rs`.
 */
import { readableFg, tintSource } from "./contrast";

export const PALETTE_SIZE = 12;

/** Names by palette index. The index order spreads similar hues apart, so the first colours handed out look different. */
export const REPO_COLOR_NAMES = [
  "Electric blue", "Orange", "Green", "Magenta", "Cyan", "Amber",
  "Violet", "Coral", "Lime", "Teal", "Pink", "Indigo",
] as const;

/** Palette indexes in rainbow order (the order the Set Color menu shows them). */
export const REPO_COLOR_ORDER = [7, 1, 5, 8, 2, 9, 4, 0, 11, 6, 3, 10] as const;

/** What a repo or project stores: a palette index, plus an optional user colour that wins over it. */
export interface ColorChoice {
  color: number;
  customColor?: string | null;
}

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Palette index folded into 0..PALETTE_SIZE-1 (a bad value never gives `var(--dg-repo-NaN)`). */
export function paletteIndex(index: number | undefined): number {
  const n = Number.isFinite(index) ? Math.trunc(index as number) : 0;
  return ((n % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
}

/** Fill colour (spine, square, tint source): the custom colour, else `var(--dg-repo-N)`. */
export function colorFill(c: ColorChoice | undefined): string {
  if (c?.customColor && HEX_COLOR.test(c.customColor)) return c.customColor;
  return `var(--dg-repo-${paletteIndex(c?.color)})`;
}

/** Text-safe colour (chip text, repo names): `var(--dg-repo-N-fg)`, or the custom colour made readable for `theme`. */
export function colorFg(c: ColorChoice | undefined, theme: "dark" | "light"): string {
  if (c?.customColor && HEX_COLOR.test(c.customColor)) return readableFg(c.customColor, theme);
  return `var(--dg-repo-${paletteIndex(c?.color)}-fg)`;
}

/**
 * The CSS custom properties an element needs to show a repo or project colour:
 *   `--rc` fill (spine, square, tint source), `--rc-fg` text colour, and `--rc-tint` only for a custom colour
 *   that is too light to tint in the dark theme.
 * Tint classes (`dg-tint*` in colors.css) and the chip read these.
 */
export function colorVars(c: ColorChoice | undefined, theme: "dark" | "light"): Record<string, string> {
  const vars: Record<string, string> = { "--rc": colorFill(c), "--rc-fg": colorFg(c, theme) };
  if (c?.customColor && HEX_COLOR.test(c.customColor)) {
    const tint = tintSource(c.customColor, theme);
    if (tint !== c.customColor) vars["--rc-tint"] = tint;
  }
  return vars;
}
