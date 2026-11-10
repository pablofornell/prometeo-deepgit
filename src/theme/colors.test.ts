/**
 * Contrast guarantee of the colour layer. Reads `colors.css` and `tokens.css` (the real values, no copy)
 * and checks WCAG AA for every palette colour on every tinted surface, in both themes, at tint k = 1 and k = 2.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURFACES, TINT_ALPHA, TINT_K_MAX, contrast, luminance, over, parseHex, readableFg, tintSource, type Rgb } from "./contrast";
import { HEX_COLOR, PALETTE_SIZE, REPO_COLOR_NAMES, REPO_COLOR_ORDER, colorFg, colorFill, paletteIndex } from "./palette";

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

const pct = (v: Vars, name: string): number => {
  const m = /^([\d.]+)%$/.exec(v[name] ?? "");
  if (!m) throw new Error(`${name} is not a percentage: ${v[name]}`);
  return parseFloat(m[1]) / 100;
};

const SURFACE_VARS = ["--dg-island-bg", "--dg-panel-bg", "--dg-layer-1-bg", "--dg-window-bg"];
// where tinted rows are drawn: sidebar, log, changes (island/panel), matrix cells, console lines, menu rows (popup)
// chips sit in log rows and console lines
const CHIP_SURFACES = ["--dg-island-bg", "--dg-panel-bg", "--dg-console-bg"];
const ROW_SURFACES = ["--dg-island-bg", "--dg-panel-bg", "--dg-matrix-cell-bg", "--dg-console-bg", "--dg-popup-bg"];
const AA = 4.5;

describe.each(["dark", "light"] as Theme[])("%s theme", (theme) => {
  const v = vars(theme);

  it("defines every palette colour", () => {
    for (let i = 0; i < PALETTE_SIZE; i++) {
      expect(HEX_COLOR.test(v[`--dg-repo-${i}`]), `--dg-repo-${i}`).toBe(true);
      expect(HEX_COLOR.test(v[`--dg-repo-${i}-fg`]), `--dg-repo-${i}-fg`).toBe(true);
    }
  });

  it("keeps all 12 fill colours distinct", () => {
    const fills = new Set(Array.from({ length: PALETTE_SIZE }, (_, i) => v[`--dg-repo-${i}`].toUpperCase()));
    expect(fills.size).toBe(PALETTE_SIZE);
  });

  it("uses the surface the helper treats as worst case", () => {
    const lums = SURFACE_VARS.map((n) => luminance(rgb(v, n)));
    const worst = theme === "dark" ? Math.max(...lums) : Math.min(...lums);
    expect(luminance(rgb(v, "--dg-window-bg"))).toBeCloseTo(worst, 6);
    expect(SURFACES[theme].worst.toUpperCase()).toBe(v["--dg-window-bg"].toUpperCase());
    expect(SURFACES[theme].text.toUpperCase()).toBe(v["--dg-text"].toUpperCase());
    expect(pct(v, "--dg-repo-chip-tint")).toBeCloseTo(TINT_ALPHA[theme].chip, 6);
    expect(pct(v, "--dg-repo-tint-strong")).toBeCloseTo(TINT_ALPHA[theme].strong, 6);
  });

  // Every tint class at k = 1 and the maximum. Rows live on the island and panel surfaces; headers
  // (the strong tint) may also sit on the raised layer and the window colour.
  for (const k of [1, TINT_K_MAX]) {
    for (const tint of ["--dg-repo-tint-row", "--dg-repo-tint-strong", "--dg-repo-tint-soft"]) {
      it(`text and repo colours read at ${AA}:1 on ${tint} at k=${k}`, () => {
        const fails: string[] = [];
        const surfaces = tint === "--dg-repo-tint-strong" ? SURFACE_VARS : ROW_SURFACES;
        for (const surfaceVar of surfaces) {
          const surface = rgb(v, surfaceVar);
          const onRow = ROW_SURFACES.includes(surfaceVar);
          for (let i = 0; i < PALETTE_SIZE; i++) {
            const fill = rgb(v, `--dg-repo-${i}`);
            const row = over(fill, surface, pct(v, tint) * k);
            const chip = over(fill, row, pct(v, "--dg-repo-chip-tint"));
            const fg = rgb(v, `--dg-repo-${i}-fg`);
            const checks: [string, Rgb, Rgb][] = [
              ["--dg-text", rgb(v, "--dg-text"), row],
              ["repo text on tint", fg, row],
            ];
            // a chip sits on rows, and a header drops its chip background (colors.css), so chips are checked on rows only
            if (CHIP_SURFACES.includes(surfaceVar) && tint !== "--dg-repo-tint-strong") checks.push(["repo text on chip", fg, chip], ["--dg-text on chip", rgb(v, "--dg-text"), chip]);
            if (onRow) {
              checks.push(["--dg-text-muted-on-tint", rgb(v, "--dg-text-muted-on-tint"), row]);
              checks.push(["--dg-text-secondary-on-tint", rgb(v, "--dg-text-secondary-on-tint"), row]);
            }
            for (const [label, f, bg] of checks) {
              const ratio = contrast(f, bg);
              if (ratio < AA) fails.push(`${label}, ${surfaceVar}, ${REPO_COLOR_NAMES[i]}: ${ratio.toFixed(2)}`);
            }
          }
        }
        expect(fails).toEqual([]);
      });
    }
  }

  it("keeps console text readable on a tinted console line", () => {
    const fails: string[] = [];
    for (const k of [1, TINT_K_MAX]) {
      for (let i = 0; i < PALETTE_SIZE; i++) {
        const row = over(rgb(v, `--dg-repo-${i}`), rgb(v, "--dg-console-bg"), pct(v, "--dg-repo-tint-row") * k);
        for (const t of ["--dg-console-fg", "--dg-console-prompt-on-tint", "--dg-text-muted-on-tint"]) {
          const ratio = contrast(rgb(v, t), row);
          if (ratio < AA) fails.push(`${t} on ${REPO_COLOR_NAMES[i]} at k=${k}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(fails).toEqual([]);
  });

  it("keeps a chip readable on a plain surface", () => {
    for (const surfaceVar of SURFACE_VARS) {
      for (let i = 0; i < PALETTE_SIZE; i++) {
        const chip = over(rgb(v, `--dg-repo-${i}`), rgb(v, surfaceVar), pct(v, "--dg-repo-chip-tint"));
        expect(contrast(rgb(v, `--dg-repo-${i}-fg`), chip), `${i} on ${surfaceVar}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("keeps repo text readable on a plain surface", () => {
    for (const surfaceVar of SURFACE_VARS) {
      for (let i = 0; i < PALETTE_SIZE; i++) {
        expect(contrast(rgb(v, `--dg-repo-${i}-fg`), rgb(v, surfaceVar)), `${i} on ${surfaceVar}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

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

  it("makes any custom colour readable", () => {
    const surface = rgb(v, "--dg-window-bg");
    // a sweep over the colour cube, including the hard cases (pure yellow, white, black)
    const steps = [0, 64, 128, 192, 255];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
          const fg = parseHex(readableFg(hex, theme)) as Rgb;
          const fill = parseHex(tintSource(hex, theme)) as Rgb;
          const bg = over(fill, over(fill, surface, TINT_ALPHA[theme].strong * TINT_K_MAX), TINT_ALPHA[theme].chip);
          expect(contrast(fg, bg), `${hex} -> ${readableFg(hex, theme)}`).toBeGreaterThanOrEqual(AA);
        }
      }
    }
  });
});

describe("palette helpers", () => {
  it("has a name and a menu slot for every colour", () => {
    expect(REPO_COLOR_NAMES).toHaveLength(PALETTE_SIZE);
    expect([...REPO_COLOR_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: PALETTE_SIZE }, (_, i) => i));
  });

  it("folds bad indexes into the palette", () => {
    expect(paletteIndex(13)).toBe(1);
    expect(paletteIndex(-1)).toBe(11);
    expect(paletteIndex(Number.NaN)).toBe(0);
    expect(paletteIndex(undefined)).toBe(0);
  });

  it("prefers a valid custom colour and ignores a broken one", () => {
    expect(colorFill({ color: 3, customColor: "#12AB34" })).toBe("#12AB34");
    expect(colorFill({ color: 3, customColor: "red" })).toBe("var(--dg-repo-3)");
    expect(colorFill({ color: 3, customColor: null })).toBe("var(--dg-repo-3)");
    expect(colorFg({ color: 3 }, "dark")).toBe("var(--dg-repo-3-fg)");
    expect(colorFg({ color: 3, customColor: "#FFFF00" }, "light")).not.toBe("#FFFF00");
  });
});
