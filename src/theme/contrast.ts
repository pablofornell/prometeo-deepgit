/**
 * Colour maths for the contrast test (`colors.test.ts`): WCAG contrast, compositing a translucent colour over a
 * surface, and a small resolver for the token values of `tokens.css` and `colors.css` (hex, `var()`, `color-mix`).
 * Pure functions, no DOM.
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

/** A colour with an alpha, 0..1. */
export interface Rgba {
  rgb: Rgb;
  a: number;
}

export type TokenMap = Record<string, string>;

/** Replaces every `var(--x)` of `value` with the value of `--x` in `vars`, as deep as it goes. Throws on an unknown token. */
export function expandVars(value: string, vars: TokenMap, depth = 0): string {
  if (depth > 12) throw new Error(`var() cycle in: ${value}`);
  const out = value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`${name} is not defined`);
    return v;
  });
  return out === value ? out : expandVars(out, vars, depth + 1);
}

/** Splits `a, b, c` at the top-level commas (commas inside brackets stay). */
function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/**
 * Resolves a token value to a colour. Understands what the theme files use:
 *   `#RGB`, `#RRGGBB`, `#RRGGBBAA`, `transparent`, `var(--x)` and
 *   `color-mix(in srgb, <colour> <N>%, <colour>)` (the second colour is often `transparent`).
 */
export function resolveColor(value: string, vars: TokenMap = {}): Rgba {
  const v = expandVars(value, vars).trim();
  if (v === "transparent") return { rgb: [0, 0, 0], a: 0 };
  if (v.startsWith("#")) {
    const rgb = parseHex(v);
    if (!rgb) throw new Error(`not a colour: ${value}`);
    const h = v.slice(1);
    return { rgb, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  const mix = /^color-mix\(\s*in srgb\s*,([\s\S]*)\)$/.exec(v);
  if (mix) {
    const [first, second] = splitArgs(mix[1]);
    const m = /^([\s\S]*?)\s+([\d.]+)%$/.exec(first);
    if (!m || second === undefined) throw new Error(`unsupported color-mix: ${value}`);
    const p = parseFloat(m[2]) / 100;
    const a = resolveColor(m[1]);
    const b = resolveColor(second);
    // premultiplied mix, like CSS does
    const alpha = a.a * p + b.a * (1 - p);
    if (alpha === 0) return { rgb: [0, 0, 0], a: 0 };
    const ch = (i: number) => (a.rgb[i] * a.a * p + b.rgb[i] * b.a * (1 - p)) / alpha;
    return { rgb: [ch(0), ch(1), ch(2)], a: alpha };
  }
  throw new Error(`not a colour: ${value}`);
}

/** `layers` painted one after the other over the opaque `base` (first layer is the lowest). */
export function flatten(base: Rgb, ...layers: Rgba[]): Rgb {
  return layers.reduce<Rgb>((bg, l) => over(l.rgb, bg, l.a), base);
}
