/**
 * Colour maths for the repo palette: WCAG contrast, compositing a tint over a surface, and the
 * text-safe version of a custom repo colour. Pure functions, no DOM.
 */

export type Rgb = readonly [number, number, number];

/** Parses `#RGB`, `#RRGGBB` or `#RRGGBBAA` (the alpha is ignored). Returns null when it is not a hex colour. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex(c: Rgb): string {
  return "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** WCAG relative luminance. */
export function luminance(c: Rgb): number {
  const lin = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` painted at `alpha` (0..1) over `bg`, like `color-mix(in srgb, fg alpha%, transparent)` on `bg`. */
export function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const a = Math.min(1, Math.max(0, alpha));
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}

/** Largest tint multiplier (`--dg-repo-tint-k`) the contrast guarantee covers. */
export const TINT_K_MAX = 2;

/**
 * Surfaces a repo colour can be drawn on, per theme: the lightest (dark theme) or darkest (light theme)
 * one is the worst case for text. Keep in sync with tokens.css (a test checks it).
 */
export const SURFACES = {
  dark: { worst: "#26282C", text: "#D1D3D9", extreme: "#FFFFFF" },
  light: { worst: "#E9EAEE", text: "#000000", extreme: "#000000" },
} as const;

/** Tint alphas at k = 1, per theme. Keep in sync with `--dg-repo-tint-strong` and `--dg-repo-chip-tint` in colors.css (a test checks it). */
export const TINT_ALPHA = {
  dark: { strong: 0.14, chip: 0.16 },
  light: { strong: 0.16, chip: 0.14 },
} as const;

/**
 * The colour a user-chosen hex colour is tinted with. In the dark theme a very light colour is dimmed to
 * luminance 0.45, so that light text can still read on its tint; every other colour is returned as it is.
 */
export function tintSource(hex: string, theme: "dark" | "light"): string {
  const rgb = parseHex(hex);
  if (!rgb || theme === "light" || luminance(rgb) <= 0.45) return hex;
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const c = over([0, 0, 0], rgb, t);
    if (luminance(c) <= 0.45) return toHex(c);
  }
  return "#000000";
}

/**
 * Text colour for a user-chosen hex colour: the colour itself when it reads at 4.6:1 in the worst case
 * (a chip on the strongest tint at k = 2 over the worst surface), otherwise mixed toward the theme text
 * colour (white in the dark theme, black in the light one) in 4% steps.
 */
export function readableFg(hex: string, theme: "dark" | "light"): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const { worst, extreme } = SURFACES[theme];
  const { strong, chip } = TINT_ALPHA[theme];
  const towards = parseHex(extreme) as Rgb;
  const tint = parseHex(tintSource(hex, theme)) as Rgb;
  const surface = over(tint, over(tint, parseHex(worst) as Rgb, strong * TINT_K_MAX), chip);
  for (let t = 0; t <= 1.0001; t += 0.04) {
    const c = over(towards, rgb, t);
    if (contrast(c, surface) >= 4.6) return toHex(c);
  }
  return extreme;
}
