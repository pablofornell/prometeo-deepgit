// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_RECENT, cleanRecent } from "./recent";
import type { PaletteItem } from "./sources";

const action = (key: string, title: string): PaletteItem => ({ kind: "action", key, title, icon: "arrowRight", group: "Project" });
/** Like `actionExists` in sources.ts, with one palette-only action left. */
const exists = (key: string) => !key.startsWith("x.") || key === "x.clone";

describe("cleanRecent", () => {
  it("drops the retired colour actions and actions that are gone, keeps the rest in order", () => {
    const fetch = action("git.fetchAll", "Fetch all repositories");
    const clone = action("x.clone", "Clone repository…");
    const repo: PaletteItem = { kind: "repo", key: "r1", repoId: "r1" };
    const stored = [
      action("x.repoColor", "Set repository color…"),
      fetch,
      action("x.projectColor", "Set project color…"),
      action("x.gone", "Something removed"),
      repo,
      clone,
    ];
    expect(cleanRecent(stored, exists)).toEqual([fetch, repo, clone]);
  });

  it("drops what is not an item and keeps at most MAX_RECENT", () => {
    expect(cleanRecent("nope", exists)).toEqual([]);
    expect(cleanRecent([null, 3, {}, { kind: "action" }, { kind: "action", key: "git.pull" }], exists)).toEqual([]);
    const many = Array.from({ length: 15 }, (_, i) => action(`a${i}`, `A${i}`));
    expect(cleanRecent(many, exists)).toEqual(many.slice(0, MAX_RECENT));
  });
});
