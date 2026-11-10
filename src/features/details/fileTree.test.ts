// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FileChange } from "../../api/types";
import { buildFileTree, dirIds, flatFiles, totals, type DirNode } from "./fileTree";

const f = (path: string, add = 1, del = 0): FileChange => ({ path, oldPath: null, status: "modified", additions: add, deletions: del, binary: false });

describe("buildFileTree", () => {
  it("compacts single-child folder chains", () => {
    const t = buildFileTree([f("a/b/c/x.rs"), f("a/b/c/y.rs")]);
    expect(t).toHaveLength(1);
    const d = t[0] as DirNode;
    expect(d.name).toBe("a/b/c");
    expect(d.id).toBe("d:a/b/c");
    expect(d.children.map((c) => c.name)).toEqual(["x.rs", "y.rs"]);
  });
  it("does not compact a folder that also holds files or several folders", () => {
    const t = buildFileTree([f("src/main.rs"), f("src/a/x.rs"), f("src/b/y.rs")]);
    const src = t[0] as DirNode;
    expect(src.name).toBe("src");
    expect(src.children.map((c) => c.name)).toEqual(["a", "b", "main.rs"]);
  });
  it("lists folders first and sorts names naturally", () => {
    const t = buildFileTree([f("z.md"), f("b/x"), f("file10.rs"), f("file2.rs")]);
    expect(t.map((n) => n.name)).toEqual(["b", "file2.rs", "file10.rs", "z.md"]);
  });
  it("sums counts per folder", () => {
    const t = buildFileTree([f("d/a.rs", 3, 1), f("d/e/b.rs", 2, 2), f("c.rs", 5, 0)]);
    const d = t.find((n) => n.name === "d") as DirNode;
    expect(d.additions).toBe(5);
    expect(d.deletions).toBe(3);
    expect(d.files).toBe(2);
  });
  it("handles null counts and an empty list", () => {
    expect(buildFileTree([])).toEqual([]);
    const t = buildFileTree([{ ...f("a/x.bin"), additions: null, deletions: null, binary: true }]);
    expect((t[0] as DirNode).additions).toBe(0);
  });
});

describe("helpers", () => {
  it("collects directory ids", () => {
    expect(dirIds(buildFileTree([f("a/x"), f("a/b/y"), f("a/b/z"), f("q/w")]))).toEqual(["d:a", "d:a/b", "d:q"]);
  });
  it("totals", () => {
    expect(totals([f("a", 2, 1), f("b", 3, 4)])).toEqual({ additions: 5, deletions: 5 });
  });
  it("flat list is sorted by path", () => {
    expect(flatFiles([f("b/z"), f("a/y"), f("a/x")]).map((n) => n.change.path)).toEqual(["a/x", "a/y", "b/z"]);
  });
});
