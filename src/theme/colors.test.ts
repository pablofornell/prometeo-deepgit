/**
 * Contrast guarantee of the colour layer. Reads `colors.css` and `tokens.css` (the real values, no copy)
 * and checks WCAG AA in both themes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, parseHex, type Rgb } from "./contrast";

type Theme = "dark" | "light";
type Vars = Record<string, string>;

/** Custom properties of the `:root[data-theme="..."]` rule(s) of a stylesheet. */
function themeVars(css: string, theme: Theme): Vars {
  const out: Vars = {};
  const re = new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`, "g");
  for (const m of css.matchAll(re)) {
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const tokens = read("tokens.css");
const colors = read("colors.css");
const vars = (theme: Theme): Vars => ({ ...themeVars(tokens, theme), ...themeVars(colors, theme) });

function rgb(v: Vars, name: string): Rgb {
  const raw = v[name];
  const c = raw ? parseHex(raw.slice(0, 7)) : null;
  if (!c) throw new Error(`${name} is not a hex colour: ${raw}`);
  return c;
}

const AA = 4.5;

describe.each(["dark", "light"] as Theme[])("%s theme", (theme) => {
  const v = vars(theme);

  it("keeps lane colours visible on the island (3:1 for graphics)", () => {
    for (let i = 0; i < 10; i++) {
      expect(contrast(rgb(v, `--dg-lane-${i}`), rgb(v, "--dg-island-bg")), `lane ${i}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps white text on the accent and the HEAD pill", () => {
    expect(contrast(rgb(v, "--dg-text-over-accent"), rgb(v, "--dg-accent"))).toBeGreaterThanOrEqual(AA);
    expect(contrast(rgb(v, "--dg-text-over-accent"), rgb(v, "--dg-accent-hover"))).toBeGreaterThanOrEqual(AA);
    expect(contrast(rgb(v, "--dg-ref-head-fg"), rgb(v, "--dg-ref-head-bg"))).toBeGreaterThanOrEqual(AA);
  });

  it("keeps ref pill text readable", () => {
    for (const kind of ["local", "remote"]) {
      expect(contrast(rgb(v, `--dg-ref-${kind}-fg`), rgb(v, `--dg-ref-${kind}-bg`)), kind).toBeGreaterThanOrEqual(AA);
    }
    expect(contrast(rgb(v, "--dg-ref-local-fg"), rgb(v, "--dg-ref-local-current-bg"))).toBeGreaterThanOrEqual(AA);
  });

  it("keeps selected text readable on the selection colour", () => {
    expect(contrast(rgb(v, "--dg-selection-fg"), rgb(v, "--dg-selection-bg"))).toBeGreaterThanOrEqual(AA);
    expect(contrast(rgb(v, "--dg-text"), rgb(v, "--dg-selection-muted-bg"))).toBeGreaterThanOrEqual(AA);
  });
});
