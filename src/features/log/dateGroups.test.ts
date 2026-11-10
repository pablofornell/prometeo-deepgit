// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DisplayMap, dateGroup, dateGroupLabel, groupStartsOf } from "./dateGroups";

// Thursday 12 Nov 2026, 12:00 local time
const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h, 0, 0).getTime() / 1000;

describe("dateGroup", () => {
  it("names the calendar groups", () => {
    expect(dateGroup(at(2026, 10, 12), NOW).label).toBe("Today");
    expect(dateGroup(at(2026, 10, 11, 23), NOW).label).toBe("Yesterday");
    expect(dateGroup(at(2026, 10, 11, 0), NOW).label).toBe("Yesterday");
    expect(dateGroup(at(2026, 10, 9), NOW).label).toBe("This week");
    expect(dateGroup(at(2026, 10, 3), NOW).label).toBe("Last week");
    expect(dateGroup(at(2026, 10, 1), NOW).label).toBe("Earlier this month");
    expect(dateGroup(at(2026, 9, 20), NOW).label).toBe("October 2026");
    expect(dateGroup(at(2025, 8, 5), NOW).label).toBe("September 2025");
  });

  it("treats future times as today", () => {
    expect(dateGroup(NOW / 1000 + 86400 * 3, NOW).key).toBe("today");
  });
});

describe("dateGroupLabel", () => {
  it("is the relative label in the relative format", () => {
    expect(dateGroupLabel("today", "relative", NOW)).toBe("Today");
    expect(dateGroupLabel("2026-9", "relative", NOW)).toBe("October 2026");
  });
  it("adds the day to Today and Yesterday and writes months in the format", () => {
    expect(dateGroupLabel("today", "iso", NOW)).toBe("Today, 2026-11-12");
    expect(dateGroupLabel("yesterday", "absolute", NOW, "en-GB")).toBe("Yesterday, 11 Nov 2026");
    expect(dateGroupLabel("2026-9", "iso", NOW)).toBe("2026-10");
    expect(dateGroupLabel("2025-8", "absolute", NOW, "en-GB")).toBe("September 2025");
  });
  it("keeps the ranges as words", () => {
    for (const f of ["relative", "absolute", "iso"] as const) {
      expect([dateGroupLabel("week", f, NOW), dateGroupLabel("lastweek", f, NOW), dateGroupLabel("month", f, NOW)]).toEqual(["This week", "Last week", "Earlier this month"]);
    }
  });
});

describe("groupStartsOf", () => {
  it("starts a group where the key changes", () => {
    expect(groupStartsOf(["a", "a", "b", "b", "b", "c"], (k) => k.toUpperCase())).toEqual({ starts: [0, 2, 5], labels: ["A", "B", "C"] });
  });
});

describe("DisplayMap", () => {
  const map = new DisplayMap(5, false, [0, 3], ["Today", "Earlier"]);

  it("counts commits plus group rows", () => {
    expect(map.count).toBe(7);
    expect(new DisplayMap(5, true, [0, 3], ["a", "b"]).count).toBe(8);
  });

  it("maps display rows to items", () => {
    const kinds = Array.from({ length: map.count }, (_, d) => {
      const it = map.itemAt(d);
      return it.kind === "commit" ? it.ci : it.kind === "date" ? it.label : "wip";
    });
    expect(kinds).toEqual(["Today", 0, 1, 2, "Earlier", 3, 4]);
  });

  it("maps commits to display rows", () => {
    expect([0, 1, 2, 3, 4].map((ci) => map.displayOf(ci))).toEqual([1, 2, 3, 5, 6]);
    expect(map.headerOf(0)).toBe(0);
    expect(map.headerOf(1)).toBe(-1);
    expect(map.headerOf(3)).toBe(4);
  });

  it("round-trips with a wip row", () => {
    const m = new DisplayMap(1000, true, [0, 10, 500], ["a", "b", "c"]);
    for (const ci of [0, 1, 9, 10, 11, 499, 500, 999]) {
      const it = m.itemAt(m.displayOf(ci));
      expect(it).toEqual({ kind: "commit", ci });
    }
    expect(m.itemAt(0)).toEqual({ kind: "wip" });
    expect(m.itemAt(1)).toEqual({ kind: "date", group: 0, label: "a" });
  });

  it("finds the sticky group", () => {
    expect(map.stickyAt(3)).toEqual({ index: 0, label: "Today" });
    expect(map.stickyAt(5)).toEqual({ index: 4, label: "Earlier" });
    expect(new DisplayMap(5, true, [0], ["x"]).stickyAt(0)).toBeNull();
  });

  it("works without groups", () => {
    const m = new DisplayMap(3, true);
    expect(m.count).toBe(4);
    expect(m.itemAt(2)).toEqual({ kind: "commit", ci: 1 });
    expect(m.displayOf(2)).toBe(3);
  });
});
