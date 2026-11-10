/**
 * Contrast guarantee of colour system v2 (docs/design/DESIGN.md 4.4).
 *
 * The test reads the real stylesheets (`tokens.css`, `extra.css`, `colors.css`: no copy of the values), resolves the
 * tokens the way the browser does (`var()`, `color-mix`) and checks, for the dark and the light theme:
 *   - every `--dg-<family>-fg` on every surface it is used on, plain and under each wash (>= 4.5:1),
 *   - body text and muted text on every wash and on the selected-row backgrounds (>= 4.5:1),
 *   - non-text indicators: family solids, graph lanes, diff markers, icons also on a selected row (>= 3:1),
 *   - text on filled controls: primary button, danger button, HEAD pill (>= 4.5:1),
 *   - diff, merge, toasts, the title bar and status bar glow.
 * It also checks that every token a stylesheet uses is defined in both themes, and that feature CSS has no hex colour.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Rgb, type Rgba, type TokenMap, contrast, expandVars, flatten, resolveColor } from "./contrast";

type Theme = "dark" | "light";

// Vitest turns CSS imports (even `?raw`) into empty strings, so the glob only lists the files and fs reads them.
const sheets: Record<string, string> = Object.fromEntries(
  Object.keys(import.meta.glob("../**/*.css")).map((key) => [key, readFileSync(new URL(key, import.meta.url), "utf8")]),
);
const sources = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
/** Keys are relative to this folder: `./tokens.css` is a theme file, `../features/log/log.css` is not. */
const sheet = (key: string): string => {
  if (sheets[key] === undefined) throw new Error(`stylesheet not found: ${key}`);
  return sheets[key];
};
const isThemeFile = (key: string): boolean => key.startsWith("./");

const noComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Custom properties declared in the blocks of `css` whose selector is exactly `selector`. */
function declarations(css: string, selector: string): TokenMap {
  const out: TokenMap = {};
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`, "g");
  for (const m of noComments(css).matchAll(re)) {
    for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}

/** The theme files in load order (src/index.tsx). */
const THEME_FILES = ["./tokens.css", "./extra.css", "./colors.css"].map(sheet);

/** Tokens of a theme: the `:root` blocks, then the `:root[data-theme]` blocks (which win, as in the browser). */
function themeTokens(theme: Theme): TokenMap {
  const out: TokenMap = {};
  for (const css of THEME_FILES) Object.assign(out, declarations(css, ":root"));
  for (const css of THEME_FILES) Object.assign(out, declarations(css, `:root[data-theme="${theme}"]`));
  return out;
}

const FAMILIES = ["accent", "success", "warning", "danger", "info", "special", "neutral"] as const;
const WASHES = ["wash-soft", "wash", "wash-strong"] as const;
/** Opaque surfaces that hold coloured text, badges and rows. */
const SURFACES = ["--dg-window-bg", "--dg-island-bg", "--dg-panel-bg", "--dg-layer-1-bg", "--dg-popup-bg", "--dg-dialog-bg", "--dg-console-bg", "--dg-editor-bg"];
/** Surfaces that hold selectable rows (log, trees, lists, menus, palette, dialogs). */
const ROW_SURFACES = ["--dg-island-bg", "--dg-panel-bg", "--dg-layer-1-bg", "--dg-popup-bg", "--dg-dialog-bg"];
const AA = 4.5;
const GRAPHIC = 3;

describe.each(["dark", "light"] as Theme[])("%s theme", (theme) => {
  const vars = themeTokens(theme);
  const color = (name: string): Rgba => {
    if (vars[name] === undefined) throw new Error(`${name} is not defined in the ${theme} theme`);
    return resolveColor(vars[name], vars);
  };
  /** An opaque token as RGB. */
  const solid = (name: string): Rgb => {
    const c = color(name);
    if (c.a < 0.999) throw new Error(`${name} is not opaque: ${vars[name]}`);
    return c.rgb;
  };
  /** Token `name` (opaque or a wash) over the opaque surface token `surface`, with more layers on top. */
  const on = (surface: string, ...layers: string[]): Rgb => flatten(solid(surface), ...layers.map(color));
  const fails: string[] = [];
  const check = (label: string, fg: Rgb, bg: Rgb, min: number): void => {
    const ratio = contrast(fg, bg);
    if (ratio < min) fails.push(`${label}: ${ratio.toFixed(2)} < ${min}`);
  };
  const done = (): void => {
    const copy = fails.splice(0);
    expect(copy.join("\n")).toBe("");
  };

  it("defines the seven families with every token, and the washes come from the family solid", () => {
    for (const f of FAMILIES) {
      for (const part of ["", "-fill", "-fg"]) expect(solid(`--dg-${f}${part}`), `--dg-${f}${part}`).toHaveLength(3);
      for (const w of [...WASHES, "border"]) {
        const raw = vars[`--dg-${f}-${w}`];
        expect(raw, `--dg-${f}-${w}`).toMatch(new RegExp(`^color-mix\\(in srgb, var\\(--dg-${f}\\) var\\(--dg-wash-[\\w-]+\\), transparent\\)$`));
        const c = color(`--dg-${f}-${w}`);
        expect(c.rgb.map(Math.round), `--dg-${f}-${w}`).toEqual(solid(`--dg-${f}`).map(Math.round));
        expect(c.a).toBeGreaterThan(0);
        expect(c.a).toBeLessThan(0.6);
      }
      // the three washes get stronger in this order
      const [soft, mid, strong] = WASHES.map((w) => color(`--dg-${f}-${w}`).a);
      expect(soft).toBeLessThan(mid);
      expect(mid).toBeLessThan(strong);
    }
  });

  it("family text reads on every surface, plain and under each wash of its family", () => {
    for (const f of FAMILIES) {
      const fg = solid(`--dg-${f}-fg`);
      for (const s of SURFACES) {
        check(`--dg-${f}-fg on ${s}`, fg, solid(s), AA);
        for (const w of WASHES) check(`--dg-${f}-fg on --dg-${f}-${w} over ${s}`, fg, on(s, `--dg-${f}-${w}`), AA);
      }
    }
    done();
  });

  it("family text reads on a selected row, a hovered row, and as a badge on a selected row", () => {
    for (const f of FAMILIES) {
      const fg = solid(`--dg-${f}-fg`);
      for (const s of ROW_SURFACES) {
        for (const sel of ["--dg-row-hover-bg", "--dg-selection-inactive-bg", "--dg-selection-bg"]) {
          check(`--dg-${f}-fg on ${sel} over ${s}`, fg, on(s, sel), AA);
          // a pill, a counter or a status letter: its own wash on top of the row
          check(`--dg-${f}-fg on --dg-${f}-wash on ${sel} over ${s}`, fg, on(s, sel, `--dg-${f}-wash`), AA);
        }
      }
      // the current-branch pill (strong wash) sits in log rows and sidebar rows
      for (const s of ["--dg-island-bg", "--dg-panel-bg"]) {
        check(`--dg-${f}-fg on --dg-${f}-wash-strong on a selected row over ${s}`, fg, on(s, "--dg-selection-bg", `--dg-${f}-wash-strong`), AA);
      }
    }
    done();
  });

  it("body text and on-wash text read on every wash of every family", () => {
    for (const t of ["--dg-text", "--dg-text-muted-on-wash"]) {
      for (const f of FAMILIES) {
        for (const s of SURFACES) {
          for (const w of WASHES) check(`${t} on --dg-${f}-${w} over ${s}`, solid(t), on(s, `--dg-${f}-${w}`), AA);
        }
      }
    }
    done();
  });

  it("muted and secondary text read on the surfaces and on a hovered row", () => {
    for (const t of ["--dg-text-muted", "--dg-text-secondary"]) {
      for (const s of SURFACES) {
        check(`${t} on ${s}`, solid(t), solid(s), AA);
        check(`${t} on --dg-row-hover-bg over ${s}`, solid(t), on(s, "--dg-row-hover-bg"), AA);
      }
    }
    // every other line of a selected row uses the on-wash value (colors.css section 4)
    for (const s of ROW_SURFACES) {
      for (const sel of ["--dg-selection-inactive-bg", "--dg-selection-bg", "--dg-matrix-column-selected-bg"]) {
        check(`--dg-text-muted-on-wash on ${sel} over ${s}`, solid("--dg-text-muted-on-wash"), on(s, sel), AA);
        check(`--dg-selection-fg on ${sel} over ${s}`, solid("--dg-selection-fg"), on(s, sel), AA);
      }
    }
    done();
  });

  it("non-text indicators are visible: family solids, lanes, focus ring (3:1)", () => {
    for (const f of FAMILIES) {
      for (const s of SURFACES) check(`--dg-${f} on ${s}`, solid(`--dg-${f}`), solid(s), GRAPHIC);
      // a dot, an icon or an edge on a selected row
      for (const s of ["--dg-island-bg", "--dg-panel-bg"]) check(`--dg-${f} on a selected row over ${s}`, solid(`--dg-${f}`), on(s, "--dg-selection-bg"), GRAPHIC);
    }
    for (let i = 0; i < 10; i++) {
      check(`--dg-lane-${i} on the island`, solid(`--dg-lane-${i}`), solid("--dg-island-bg"), GRAPHIC);
      check(`--dg-lane-${i} on a selected log row`, solid(`--dg-lane-${i}`), on("--dg-island-bg", "--dg-selection-bg"), GRAPHIC);
    }
    for (const s of SURFACES) check(`--dg-focus-ring on ${s}`, solid("--dg-focus-ring"), solid(s), GRAPHIC);
    for (const s of ["--dg-island-bg", "--dg-panel-bg", "--dg-popup-bg"]) check(`--dg-selection-edge on a selected row over ${s}`, solid("--dg-selection-edge"), on(s, "--dg-selection-bg"), GRAPHIC);
    done();
  });

  it("icons are visible on the surfaces, on a hovered row and on a selected row (3:1)", () => {
    for (const t of ["--dg-icon", "--dg-icon-secondary"]) {
      for (const s of SURFACES) {
        check(`${t} on ${s}`, solid(t), solid(s), GRAPHIC);
        check(`${t} on --dg-row-hover-bg over ${s}`, solid(t), on(s, "--dg-row-hover-bg"), GRAPHIC);
      }
      // file, branch and folder icons stay in their colour on a selected row
      for (const s of ROW_SURFACES) {
        for (const sel of ["--dg-selection-inactive-bg", "--dg-selection-bg", "--dg-matrix-column-selected-bg"]) {
          check(`${t} on ${sel} over ${s}`, solid(t), on(s, sel), GRAPHIC);
        }
      }
    }
    done();
  });

  it("white text reads on every fill: primary and danger buttons, Push, the HEAD pill, counters", () => {
    const white = solid("--dg-text-over-accent");
    for (const f of FAMILIES) check(`white on --dg-${f}-fill`, white, solid(`--dg-${f}-fill`), AA);
    for (const t of ["--dg-button-primary-bg", "--dg-accent-hover", "--dg-accent-pressed", "--dg-button-danger-bg", "--dg-button-danger-hover-bg", "--dg-push-bg", "--dg-push-hover-bg", "--dg-checkbox-selected-bg", "--dg-project-badge-from", "--dg-project-badge-to"]) {
      check(`white on ${t}`, white, solid(t), AA);
    }
    check("--dg-button-primary-fg on --dg-button-primary-bg", solid("--dg-button-primary-fg"), solid("--dg-button-primary-bg"), AA);
    check("--dg-ref-head-fg on --dg-ref-head-bg", solid("--dg-ref-head-fg"), solid("--dg-ref-head-bg"), AA);
    done();
  });

  it("ref pills, ahead/behind and file status read where they are drawn", () => {
    const rows = ["--dg-island-bg", "--dg-panel-bg", "--dg-popup-bg"];
    const pairs: [string, string][] = [
      ["--dg-ref-local-fg", "--dg-ref-local-bg"], ["--dg-ref-local-fg", "--dg-ref-local-current-bg"], ["--dg-ref-remote-fg", "--dg-ref-remote-bg"],
      ["--dg-ref-tag-fg", "--dg-ref-tag-bg"], ["--dg-ref-stash-fg", "--dg-ref-stash-bg"], ["--dg-ref-overflow-fg", "--dg-ref-overflow-bg"],
      ["--dg-ahead-fg", "--dg-ahead-bg"], ["--dg-behind-fg", "--dg-behind-bg"], ["--dg-banner-operation-fg", "--dg-banner-operation-bg"],
      ["--dg-log-match-fg", "--dg-log-match-bg"], ["--dg-diverged-fg", "--dg-diverged-bg"], ["--dg-ahead-fg", "--dg-diverged-bg"], ["--dg-behind-fg", "--dg-diverged-bg"],
      ["--dg-tab-active-fg", "--dg-tab-active-bg"], ["--dg-console-prompt", "--dg-command-bg"],
    ];
    for (const [fg, bg] of pairs) {
      for (const s of [...rows, "--dg-window-bg"]) check(`${fg} on ${bg} over ${s}`, solid(fg), on(s, bg), AA);
      for (const s of rows) check(`${fg} on ${bg} on a selected row over ${s}`, solid(fg), on(s, "--dg-selection-bg", bg), AA);
    }
    for (const st of ["added", "modified", "deleted", "renamed", "copied", "conflict", "untracked", "ignored", "typechange"]) {
      for (const s of rows) {
        check(`--dg-status-${st} on ${s}`, solid(`--dg-status-${st}`), solid(s), AA);
        check(`--dg-status-${st} on a hovered row over ${s}`, solid(`--dg-status-${st}`), on(s, "--dg-row-hover-bg"), AA);
        check(`--dg-status-${st} on a selected row over ${s}`, solid(`--dg-status-${st}`), on(s, "--dg-selection-bg"), AA);
      }
    }
    // a conflicted row has a danger wash; its name and letter are the conflict colour
    for (const s of rows) check(`--dg-status-conflict on the conflict row over ${s}`, solid("--dg-status-conflict"), on(s, "--dg-danger-wash"), AA);
    done();
  });

  it("diff and merge: code reads on line and word highlights, markers are visible", () => {
    const code = solid("--dg-editor-fg");
    for (const kind of ["added", "removed", "modified"]) {
      check(`code on --dg-diff-${kind}-bg`, code, solid(`--dg-diff-${kind}-bg`), AA);
      check(`code on --dg-diff-${kind}-word-bg`, code, solid(`--dg-diff-${kind}-word-bg`), AA);
      check(`--dg-diff-${kind}-marker on its line`, solid(`--dg-diff-${kind}-marker`), solid(`--dg-diff-${kind}-bg`), GRAPHIC);
      // the word highlight is stronger than the line
      expect(contrast(solid(`--dg-diff-${kind}-word-bg`), solid("--dg-editor-bg"))).toBeGreaterThan(contrast(solid(`--dg-diff-${kind}-bg`), solid("--dg-editor-bg")));
    }
    for (const kind of ["added", "removed"]) check(`code on --dg-diff-${kind}-gutter-bg`, code, solid(`--dg-diff-${kind}-gutter-bg`), AA);
    check("code on --dg-diff-conflict-bg", code, solid("--dg-diff-conflict-bg"), AA);
    check("--dg-diff-hunk-header-fg on --dg-diff-hunk-header-bg", solid("--dg-diff-hunk-header-fg"), solid("--dg-diff-hunk-header-bg"), AA);
    check("--dg-text-link on --dg-diff-hunk-header-bg", solid("--dg-text-link"), solid("--dg-diff-hunk-header-bg"), AA);
    const wordA = parseFloat(expandVars(vars["--dg-merge-word-a"], vars)) / 100;
    expect(wordA).toBeGreaterThan(0);
    for (const kind of ["conflict", "modified", "inserted", "deleted"]) {
      const line = solid(`--dg-merge-${kind}-bg`);
      const marker = solid(`--dg-merge-${kind}-marker`);
      check(`code on --dg-merge-${kind}-bg`, code, line, AA);
      check(`code on a changed word in a ${kind} chunk`, code, flatten(line, { rgb: marker, a: wordA }), AA);
      check(`--dg-merge-${kind}-marker on its chunk`, marker, line, GRAPHIC);
    }
    done();
  });

  it("toasts, banners and the console read", () => {
    for (const [kind, fam] of [["info", "info"], ["success", "success"], ["warning", "warning"], ["error", "danger"]] as const) {
      const bg = solid(`--dg-toast-${kind}-bg`);
      check(`--dg-notification-fg on --dg-toast-${kind}-bg`, solid("--dg-notification-fg"), bg, AA);
      check(`--dg-text-muted-on-wash on --dg-toast-${kind}-bg`, solid("--dg-text-muted-on-wash"), bg, AA);
      check(`--dg-${fam}-fg on --dg-toast-${kind}-bg`, solid(`--dg-${fam}-fg`), bg, AA);
      check(`--dg-text-link on --dg-toast-${kind}-bg`, solid("--dg-text-link"), bg, AA);
      for (const s of ["--dg-island-bg", "--dg-panel-bg", "--dg-dialog-bg"]) {
        check(`--dg-text on --dg-banner-${kind}-bg over ${s}`, solid("--dg-text"), on(s, `--dg-banner-${kind}-bg`), AA);
        check(`--dg-${fam}-fg on --dg-banner-${kind}-bg over ${s}`, solid(`--dg-${fam}-fg`), on(s, `--dg-banner-${kind}-bg`), AA);
      }
    }
    for (const s of ["--dg-island-bg", "--dg-panel-bg"]) {
      check(`--dg-text on --dg-banner-operation-bg over ${s}`, solid("--dg-text"), on(s, "--dg-banner-operation-bg"), AA);
    }
    for (const t of ["--dg-console-fg", "--dg-console-prompt", "--dg-console-ok", "--dg-console-stderr", "--dg-console-error", "--dg-console-duration", "--dg-console-repo"]) {
      check(`${t} on the console`, solid(t), solid("--dg-console-bg"), AA);
    }
    for (const t of ["--dg-console-fg", "--dg-console-prompt", "--dg-console-error", "--dg-text-muted-on-wash"]) {
      check(`${t} on the line of a failed command`, solid(t), on("--dg-console-bg", "--dg-console-error-bg"), AA);
      check(`${t} on an open console entry`, solid(t), on("--dg-console-bg", "--dg-selection-muted-bg"), AA);
    }
    // the command preview of a dialog
    for (const s of ["--dg-dialog-bg", "--dg-panel-bg"]) check(`--dg-console-prompt on the command preview over ${s}`, solid("--dg-console-prompt"), on(s, "--dg-info-wash"), AA);
    done();
  });

  it("the title bar and status bar glow keep their text readable", () => {
    for (const tint of ["--dg-toolbar-tint", "--dg-toolbar-tint-2", "--dg-toolbar-bg"]) {
      for (const t of ["--dg-toolbar-fg", "--dg-text-muted-on-wash", "--dg-ahead-fg", "--dg-behind-fg", "--dg-accent-fg"]) check(`${t} on ${tint}`, solid(t), solid(tint), AA);
      for (const t of ["--dg-accent", "--dg-fetch-fresh", "--dg-fetch-aging", "--dg-fetch-stale"]) check(`${t} on ${tint}`, solid(t), solid(tint), GRAPHIC);
    }
    // the Push button with commits to push: a success wash on the bar
    for (const tint of ["--dg-toolbar-tint", "--dg-toolbar-tint-2", "--dg-toolbar-bg"]) {
      for (const t of ["--dg-ahead-fg", "--dg-behind-fg", "--dg-toolbar-fg"]) check(`${t} on the hot Push button over ${tint}`, solid(t), flatten(solid(tint), color("--dg-success-wash")), AA);
      check(`--dg-toolbar-selected-fg on a toggled button over ${tint}`, solid("--dg-toolbar-selected-fg"), flatten(solid(tint), color("--dg-toolbar-selected-bg")), AA);
    }
    for (const tint of ["--dg-statusbar-tint", "--dg-statusbar-bg"]) {
      for (const t of ["--dg-statusbar-fg", "--dg-statusbar-hover-fg", "--dg-text-success", "--dg-text-error", "--dg-ahead-fg", "--dg-behind-fg"]) check(`${t} on ${tint}`, solid(t), solid(tint), AA);
    }
    done();
  });

  it("defines every token the stylesheets and components use", () => {
    const used = new Map<string, string>();
    for (const [file, css] of Object.entries(sheets)) {
      for (const m of noComments(css).matchAll(/var\(\s*(--dg-[\w-]+)\s*([,)])/g)) {
        // `var(--x, fallback)` may name an optional token
        if (m[2] === ")" && !used.has(m[1])) used.set(m[1], file);
      }
    }
    for (const [file, src] of Object.entries(sources)) {
      if (file.includes(".test.")) continue;
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/var\(\s*(--dg-[\w-]+)\s*\)/g)) if (!used.has(m[1])) used.set(m[1], file);
    }
    /** Set at run time: by a component as an inline style, by `settings.ts`, or as a registered `@property`. */
    const RUNTIME = new Set(["--dg-i", "--dg-fill", "--dg-titlebar-age", "--dg-statusbar-age", "--dg-toast-width"]);
    const missing = [...used].filter(([name]) => vars[name] === undefined && !RUNTIME.has(name)).map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
    // and each of them resolves: no var() that points nowhere
    for (const [name, value] of Object.entries(vars)) expect(() => expandVars(value, vars), name).not.toThrow();
  });
});

describe("feature stylesheets", () => {
  it("use tokens only: no hex colour outside src/theme", () => {
    const bad: string[] = [];
    for (const [file, css] of Object.entries(sheets)) {
      if (isThemeFile(file)) continue;
      for (const m of noComments(css).matchAll(/#[0-9a-fA-F]{3,8}\b/g)) bad.push(`${file}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("the old per-repository colour tokens are gone", () => {
    const all = Object.values(sheets).join("\n");
    expect(all).not.toMatch(/--dg-repo-\d|--rc\b|dg-tint/);
  });
});

describe("resolveColor", () => {
  it("reads hex, var() and color-mix like the browser", () => {
    const vars = { "--a": "#FF0000", "--b": "var(--a)", "--p": "25%", "--w": "color-mix(in srgb, var(--b) var(--p), transparent)", "--o": "color-mix(in srgb, var(--a) 50%, #0000FF)" };
    expect(resolveColor("#0F0")).toEqual({ rgb: [0, 255, 0], a: 1 });
    expect(resolveColor("#00FF0080").a).toBeCloseTo(0.5, 2);
    expect(resolveColor("var(--b)", vars)).toEqual({ rgb: [255, 0, 0], a: 1 });
    expect(resolveColor("var(--w)", vars)).toEqual({ rgb: [255, 0, 0], a: 0.25 });
    expect(resolveColor("var(--o)", vars)).toEqual({ rgb: [127.5, 0, 127.5], a: 1 });
    expect(flatten([0, 0, 0], resolveColor("var(--w)", vars))).toEqual([63.75, 0, 0]);
    expect(() => resolveColor("var(--nope)", vars)).toThrow();
    expect(() => resolveColor("rgb(1 2 3)")).toThrow();
  });
});
