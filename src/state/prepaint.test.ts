// @vitest-environment node
import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";
import { appearanceVars } from "./appearance";

/** index.html sets the size variables before first paint with its own copy of the maths. This keeps both in sync. */
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

function runPrepaint(stored: Record<string, unknown>, tauri = false, attrs = new Map<string, string>()): Map<string, string> {
  const props = new Map<string, string>();
  const name = (k: string) => k.replace("deepgit.ui.", "");
  const run = new Function("localStorage", "matchMedia", "document", "window", script);
  run(
    { getItem: (k: string) => (name(k) in stored ? JSON.stringify(stored[name(k)]) : null) },
    () => ({ matches: true }),
    { documentElement: { setAttribute: (k: string, v: string) => void attrs.set(k, v), style: { setProperty: (k: string, v: string) => void props.set(k, v) } } },
    tauri ? { __TAURI_INTERNALS__: {} } : {},
  );
  return props;
}

const CASES: Record<string, unknown>[] = [
  {},
  { fontSize: 18 },
  { fontSize: 10, uiScale: 80 },
  { fontSize: 20, editorFontSize: 11, uiScale: 200 },
  { fontSize: 17, uiScale: 150 },
  { fontSize: 999, editorFontSize: -4, uiScale: 3 },
  { fontSize: "big", editorFontSize: "x", uiScale: null },
  { uiScale: 105 },
  { repoTintStrength: 0 },
  { repoTintStrength: 50 },
  { fontSize: 15, repoTintStrength: 200 },
  { repoTintStrength: 113 },
  { repoTintStrength: 900 },
  { repoTintStrength: -20 },
  { repoTintStrength: "max" },
  { repoTintStrength: null },
];

describe("index.html pre-paint script", () => {
  it("found the script", () => expect(script).toContain("--dg-font-base"));
  for (const stored of CASES) {
    it(`writes the same variables as appearanceVars() for ${JSON.stringify(stored)}`, () => {
      const got = runPrepaint(stored);
      const want = appearanceVars({
        fontSize: stored.fontSize as number,
        editorFontSize: (stored.editorFontSize ?? null) as number | null,
        uiScale: stored.uiScale as number,
        repoTintStrength: stored.repoTintStrength as number,
      });
      for (const [k, v] of Object.entries(want)) expect(got.get(k), k).toBe(v);
    });
  }
  it("turns the repo tints off (like applyAppearance) only at strength 0", () => {
    const attrs = new Map<string, string>();
    runPrepaint({ repoTintStrength: 0 }, false, attrs);
    expect(attrs.get("data-repo-tints")).toBe("off");
    const other = new Map<string, string>();
    runPrepaint({ repoTintStrength: 25 }, false, other);
    runPrepaint({}, false, other);
    expect(other.has("data-repo-tints")).toBe(false);
  });
  it("uses CSS zoom only outside the desktop app", () => {
    expect(runPrepaint({ uiScale: 150 }).get("zoom")).toBe("1.5");
    expect(runPrepaint({ uiScale: 150 }, true).has("zoom")).toBe(false);
    expect(runPrepaint({}).has("zoom")).toBe(false);
  });
});
