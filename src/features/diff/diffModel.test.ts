// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiff, Hunk } from "../../api/types";
import { buildHunks } from "../../api/mockDiff";
import { buildItems, cellWords, countLines, isWhitespaceOnly, statusOf, toSideBySide, toUnified, usableFull, type Item } from "./diffModel";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const diffOf = (a: string[], b: string[], context = 3): FileDiff => ({ path: "f.rs", oldPath: null, binary: false, hunks: buildHunks(a, b, context), tooLarge: false });
const opts = { expanded: new Set<string>(), expandAll: false };

function fixture() {
  const a = lines(100);
  const b = [...a];
  b[9] = "line ten changed";
  b.splice(50, 0, "inserted one", "inserted two");
  b.splice(95, 1);
  return { a, b };
}

describe("buildItems", () => {
  it("puts folds between hunks and counts hidden lines", () => {
    const { a, b } = fixture();
    const d = diffOf(a, b);
    expect(d.hunks.length).toBe(3);
    const items = buildItems(d, null, opts);
    const folds = items.filter((i) => i.t === "fold");
    expect(folds.map((f) => (f.t === "fold" ? f.count : 0))).toEqual([6, 34, 37, null]);
    expect(items.filter((i) => i.t === "hunk").length).toBe(3);
  });

  it("with the full diff, folds the same regions and keeps hunk headers", () => {
    const { a, b } = fixture();
    const short = diffOf(a, b);
    const full = diffOf(a, b, 1_000_000);
    const items = buildItems(short, full, opts);
    const shownLines = items.filter((i) => i.t === "line").length;
    const shortLines = buildItems(short, null, opts).filter((i) => i.t === "line").length;
    expect(shownLines).toBe(shortLines);
    expect(items.filter((i) => i.t === "hunk").map((i) => (i.t === "hunk" ? i.hunk : -1))).toEqual([0, 1, 2]);
  });

  it("opens a fold and expands everything", () => {
    const { a, b } = fixture();
    const short = diffOf(a, b);
    const full = diffOf(a, b, 1_000_000);
    const items = buildItems(short, full, opts);
    const first = items.find((i) => i.t === "fold") as Extract<Item, { t: "fold" }>;
    const opened = buildItems(short, full, { expanded: new Set([first.id]), expandAll: false });
    expect(opened.filter((i) => i.t === "line").length).toBe(items.filter((i) => i.t === "line").length + (first.count ?? 0));
    const all = buildItems(short, full, { expanded: new Set(), expandAll: true });
    expect(all.some((i) => i.t === "fold")).toBe(false);
    expect(all.filter((i) => i.t === "line").length).toBe(full.hunks[0].lines.length);
  });

  it("has no trailing fold when the last hunk reaches the end of the file", () => {
    const a = lines(10);
    const b = [...a];
    b[8] = "changed";
    const items = buildItems(diffOf(a, b), null, opts);
    expect(items[items.length - 1].t).toBe("line");
  });

  it("returns nothing for an empty diff", () => {
    expect(buildItems({ path: "x", oldPath: null, binary: false, hunks: [], tooLarge: false }, null, opts)).toEqual([]);
  });
});

describe("toSideBySide", () => {
  it("pairs deletions with additions and fills the shorter side", () => {
    const d = diffOf(["a", "b", "c", "d"], ["a", "B", "C", "x", "y", "d"]);
    const m = toSideBySide(buildItems(d, null, opts));
    const pairs = m.rows.filter((r) => r.t === "pair" && r.change >= 0);
    expect(pairs.length).toBe(4);
    expect(m.changes.length).toBe(1);
    expect(m.changes[0].kind).toBe("mod");
    expect(pairs.map((p) => (p.t === "pair" ? [p.l?.text ?? null, p.r?.text ?? null] : []))).toEqual([["b", "B"], ["c", "C"], [null, "x"], [null, "y"]]);
  });

  it("links word-diff partners and computes highlights lazily", () => {
    const d = diffOf(["let total = price;"], ["let total = price2;"]);
    const m = toSideBySide(buildItems(d, null, opts));
    const row = m.rows.find((r) => r.t === "pair" && r.change >= 0);
    if (row?.t !== "pair" || !row.l || !row.r) throw new Error("no pair");
    expect(row.l.words).toBeUndefined();
    expect(cellWords(row.l).length).toBeGreaterThan(0);
    expect(row.r.words).toBeDefined();
  });

  it("ignores whitespace-only changes when asked", () => {
    const d = diffOf(["a", "b  c", "d"], ["a", "b c", "d"]);
    expect(toSideBySide(buildItems(d, null, opts), "off").changes.length).toBe(1);
    expect(toSideBySide(buildItems(d, null, opts), "all").changes.length).toBe(0);
    const off = toSideBySide(buildItems(d, null, opts), "off");
    const row = off.rows.find((r) => r.t === "pair" && r.change === 0);
    expect(row?.t === "pair" && row.ws).toBe(true);
  });
});

describe("toUnified", () => {
  it("lists deletions then additions and marks changes", () => {
    const d = diffOf(["a", "b", "c"], ["a", "B", "c"]);
    const m = toUnified(buildItems(d, null, opts));
    const kinds = m.rows.filter((r) => r.t === "line").map((r) => (r.t === "line" ? r.c.kind : ""));
    expect(kinds).toEqual(["context", "del", "add", "context"]);
    expect(m.changes).toEqual([{ row: 2, end: 3, kind: "mod", hunk: 0 }]);
  });
  it("marks pure additions and deletions", () => {
    expect(toUnified(buildItems(diffOf(["a"], ["a", "b"]), null, opts)).changes[0].kind).toBe("add");
    expect(toUnified(buildItems(diffOf(["a", "b"], ["a"]), null, opts)).changes[0].kind).toBe("del");
  });
  it("handles 20 000 lines quickly", () => {
    const hunk: Hunk = {
      oldStart: 1, oldLines: 20000, newStart: 1, newLines: 20000, header: "",
      lines: Array.from({ length: 20000 }, (_, i): DiffLine => (i % 7 === 0 ? { kind: "add", oldNo: null, newNo: i, text: "x" + i } : { kind: "context", oldNo: i, newNo: i, text: "y" + i })),
    };
    const d: FileDiff = { path: "big.rs", oldPath: null, binary: false, hunks: [hunk], tooLarge: false };
    const t = performance.now();
    const m = toUnified(buildItems(d, null, opts));
    expect(m.rows.length).toBeGreaterThan(20000);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("tooLarge full-context reload", () => {
  const { a, b } = fixture();
  const tooLarge: FileDiff = { path: "f.rs", oldPath: null, binary: false, hunks: [], tooLarge: true };
  it("is not usable, so the hunk view stays", () => {
    expect(usableFull(tooLarge)).toBeNull();
    expect(usableFull(null)).toBeNull();
    expect(usableFull(diffOf(a, b, 1_000_000))).not.toBeNull();
  });
  it("buildItems ignores it and keeps the hunks", () => {
    const short = diffOf(a, b);
    expect(buildItems(short, tooLarge, opts)).toEqual(buildItems(short, null, opts));
    expect(buildItems(short, tooLarge, { expanded: new Set(), expandAll: true }).some((i) => i.t === "line")).toBe(true);
  });
});

describe("helpers", () => {
  it("counts and classifies", () => {
    const d = diffOf(["a", "b"], ["a", "c", "d"]);
    expect(countLines(d)).toEqual({ additions: 2, deletions: 1 });
    expect(statusOf(d, "f.rs")).toBe("modified");
    expect(statusOf(diffOf([], ["a"]), "f.rs")).toBe("added");
    expect(statusOf(diffOf(["a"], []), "f.rs")).toBe("deleted");
    expect(statusOf(d, "new.rs", "old.rs")).toBe("renamed");
  });
  it("detects whitespace-only diffs", () => {
    expect(isWhitespaceOnly(diffOf(["a  b"], ["a b"]))).toBe(true);
    expect(isWhitespaceOnly(diffOf(["a b"], ["a c"]))).toBe(false);
    expect(isWhitespaceOnly(diffOf(["a"], ["a"]))).toBe(false);
  });
});
