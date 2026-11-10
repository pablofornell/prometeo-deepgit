// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildFileDiff, buildHunks, countChanges } from "./mockDiff";

describe("mock diff", () => {
  it("builds hunks whose line counts match their headers", () => {
    const d = buildFileDiff("src/refunds/controller.rs", null, "seed-1", "modified", 3);
    expect(d.hunks.length).toBeGreaterThan(0);
    for (const h of d.hunks) {
      expect(h.lines.filter((l) => l.kind !== "add").length).toBe(h.oldLines);
      expect(h.lines.filter((l) => l.kind !== "del").length).toBe(h.newLines);
    }
  });

  it("shows an added file as one all-add hunk starting at line 1", () => {
    const d = buildFileDiff("migrations/0042.sql", null, "x", "added", 3);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].oldLines).toBe(0);
    expect(d.hunks[0].newStart).toBe(1);
    expect(d.hunks[0].lines.every((l) => l.kind === "add")).toBe(true);
  });

  it("is deterministic and merges close changes into one hunk", () => {
    const a = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const b = ["a", "B", "c", "d", "e", "f", "G", "h"];
    expect(buildHunks(a, b, 3)).toHaveLength(1);
    expect(buildHunks(a, b, 0)).toHaveLength(2);
    expect(countChanges("x.rs", "s", "modified")).toEqual(countChanges("x.rs", "s", "modified"));
  });
});
