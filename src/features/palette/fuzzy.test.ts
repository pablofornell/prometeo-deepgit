// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyMatchPath, segments, substringPositions } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence case-insensitively and reports positions", () => {
    const r = fuzzyMatch("nwbr", "New branch");
    expect(r?.positions).toEqual([0, 2, 4, 5]);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "New branch")).toBeNull();
    expect(fuzzyMatch("hcnarb", "branch")).toBeNull();
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("   ", "anything")?.positions).toEqual([]);
  });

  it("scores a consecutive match above a scattered one", () => {
    const tight = fuzzyMatch("fet", "Fetch all repositories");
    const loose = fuzzyMatch("fet", "Fast forward everything");
    expect(tight && loose && tight.score > loose.score).toBe(true);
  });

  it("prefers word starts", () => {
    const a = fuzzyMatch("pr", "Pull request")!;
    const b = fuzzyMatch("pr", "Sharp rain")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("picks the best alignment, not the first one", () => {
    const r = fuzzyMatch("ab", "a xx ab")!;
    expect(r.positions).toEqual([5, 6]);
  });

  it("requires every word and ignores order", () => {
    expect(fuzzyMatch("branch new", "New branch")?.positions).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9]);
    expect(fuzzyMatch("new zzz", "New branch")).toBeNull();
  });

  it("rewards camelCase humps", () => {
    const camel = fuzzyMatch("fb", "fooBar")!;
    const flat = fuzzyMatch("fb", "foobar")!;
    expect(camel.score).toBeGreaterThan(flat.score);
  });

  it("is fast on a long target", () => {
    const long = "a".repeat(5000) + "needle";
    const t = performance.now();
    expect(fuzzyMatch("needle", long)).not.toBeNull();
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("fuzzyMatchPath", () => {
  it("prefers a file name match and shifts positions into the path", () => {
    const r = fuzzyMatchPath("ctrl", "src/ctrl/other.ts")!;
    const s = fuzzyMatchPath("ctrl", "src/features/log/LogController.ts")!;
    expect(r.positions).toEqual([4, 5, 6, 7]);
    expect(s.positions.every((p) => p > "src/features/log/".length)).toBe(true);
  });

  it("falls back to the whole path", () => {
    const r = fuzzyMatchPath("sflog", "src/features/log/index.ts");
    expect(r).not.toBeNull();
  });
});

describe("segments", () => {
  it("splits into matched and plain runs", () => {
    expect(segments("New branch", [0, 4, 5])).toEqual([
      { text: "N", match: true },
      { text: "ew ", match: false },
      { text: "br", match: true },
      { text: "anch", match: false },
    ]);
  });

  it("returns one plain run without positions", () => {
    expect(segments("abc", [])).toEqual([{ text: "abc", match: false }]);
  });

  it("handles an empty string", () => {
    expect(segments("", [])).toEqual([{ text: "", match: false }]);
  });
});

describe("substringPositions", () => {
  it("finds a case-insensitive substring", () => {
    expect(substringPositions("FIX", "Hotfix login")).toEqual([3, 4, 5]);
  });
  it("returns nothing when absent or empty", () => {
    expect(substringPositions("zz", "abc")).toEqual([]);
    expect(substringPositions("", "abc")).toEqual([]);
  });
});
