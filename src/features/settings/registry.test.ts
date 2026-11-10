// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const component = () => null;

describe("settings registry", () => {
  it("sorts by order then title and replaces a section with the same id", async () => {
    vi.resetModules();
    const { registerSettingsSection, settingsSections } = await import("./registry");
    registerSettingsSection({ id: "log", title: "Log", order: 20, component });
    registerSettingsSection({ id: "appearance", title: "Appearance", order: 10, component });
    registerSettingsSection({ id: "b", title: "Beta", order: 20, component });
    expect(settingsSections().map((s) => s.id)).toEqual(["appearance", "b", "log"]);
    registerSettingsSection({ id: "log", title: "Log view", order: 5, component });
    expect(settingsSections().map((s) => s.title)).toEqual(["Log view", "Appearance", "Beta"]);
  });

  it("filters by title and keywords, every word must match", async () => {
    vi.resetModules();
    const { filterSections } = await import("./registry");
    const list = [
      { id: "a", title: "Appearance", order: 1, keywords: ["font", "zoom", "theme"], component },
      { id: "l", title: "Log", order: 2, keywords: ["graph", "lane"], component },
      { id: "c", title: "Console", order: 3, component },
    ];
    expect(filterSections(list, "").length).toBe(3);
    expect(filterSections(list, "  ").length).toBe(3);
    expect(filterSections(list, "ZOOM").map((s) => s.id)).toEqual(["a"]);
    expect(filterSections(list, "lo gra").map((s) => s.id)).toEqual(["l"]);
    expect(filterSections(list, "font graph")).toEqual([]);
    expect(filterSections(list, "con").map((s) => s.id)).toEqual(["c"]);
  });
});
