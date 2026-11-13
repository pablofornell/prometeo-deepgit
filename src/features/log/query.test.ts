// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, branchChipLabel, buildQuery, dateChipLabel, parseDay, parseTextFilter, presetSince, splitMatches } from "./query";

describe("parseTextFilter", () => {
  it("keeps plain text", () => {
    expect(parseTextFilter("fix refund")).toEqual({ text: "fix refund" });
  });

  it("extracts prefixes, with quotes", () => {
    const p = parseTextFilter('refund author:"Lucía Martín" path:src/api after:2026-10-01 before:2026-11-01');
    expect(p.text).toBe("refund");
    expect(p.author).toBe("Lucía Martín");
    expect(p.path).toBe("src/api");
    expect(p.after).toBe(parseDay("2026-10-01"));
    expect(p.before).toBe(parseDay("2026-11-01"));
  });

  it("reads a day as dd-mm-yyyy or yyyy-mm-dd", () => {
    expect(parseDay("01-10-2026")).toBe(parseDay("2026-10-01"));
    expect(parseDay("01-10-2026")).toBe(new Date(2026, 9, 1).getTime() / 1000);
    expect(parseDay("1/10/2026")).toBeNull();
  });

  it("leaves an invalid date in the text", () => {
    expect(parseTextFilter("after:soon x")).toEqual({ text: "after:soon x" });
  });
});

describe("buildQuery", () => {
  it("returns nulls for an empty filter", () => {
    expect(buildQuery(["a"], EMPTY_FILTERS)).toEqual({ repoIds: ["a"], refs: [], text: null, author: null, path: null, since: null, until: null, maxCount: 0 });
  });

  it("lets the chips win over the prefixes", () => {
    const q = buildQuery(["a", "b"], { ...EMPTY_FILTERS, text: "x author:bob", author: "alice@x", refs: ["main"], since: 100 });
    expect(q.text).toBe("x");
    expect(q.author).toBe("alice@x");
    expect(q.refs).toEqual(["main"]);
    expect(q.since).toBe(100);
  });
});

describe("labels", () => {
  it("names the date presets", () => {
    const now = Date.UTC(2026, 10, 10);
    expect(presetSince("7d", now)).toBe(now / 1000 - 7 * 86400);
    expect(dateChipLabel(null, null, null)).toBe("Date");
    expect(dateChipLabel("7d", 1, null)).toBe("Last 7 days");
    expect(dateChipLabel("custom", parseDay("2026-11-03"), parseDay("2026-11-09"))).toBe("03-11-2026 - 09-11-2026");
  });

  it("labels an open range", () => {
    expect(dateChipLabel("custom", parseDay("03-11-2026"), null)).toBe("Since 03-11-2026");
    expect(dateChipLabel("custom", null, parseDay("09-11-2026"))).toBe("Until 09-11-2026");
  });

  it("names the branch chip", () => {
    expect(branchChipLabel([])).toBe("Branch: all");
    expect(branchChipLabel(["HEAD"])).toBe("Branch: HEAD");
    expect(branchChipLabel(["main", "dev", "x"])).toBe("Branch: main +2");
  });
});

describe("splitMatches", () => {
  it("splits around case-insensitive matches", () => {
    expect(splitMatches("Fix the Refund flow, refund again", "refund")).toEqual([
      { text: "Fix the ", match: false },
      { text: "Refund", match: true },
      { text: " flow, ", match: false },
      { text: "refund", match: true },
      { text: " again", match: false },
    ]);
    expect(splitMatches("abc", "")).toEqual([{ text: "abc", match: false }]);
  });
});
