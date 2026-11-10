// @vitest-environment node
import { describe, expect, it } from "vitest";
import { followFile } from "./fileFollow";
import type { SelectedFile } from "./selection";

const commit = (oid: string, paths: string[], repoId = "r1") => ({ repoId, oid, parents: ["p0", "p1"], files: paths.map((path) => ({ path })) });
const open = (path: string, oid = "aaa", repoId = "r1"): SelectedFile => ({ repoId, spec: { kind: "commit", oid, parent: null }, path });

describe("followFile", () => {
  it("keeps a file that the new commit also changes, pointed at the new commit", () => {
    const next = followFile(open("src/a.ts"), commit("bbb", ["src/a.ts", "x"]));
    expect(next).toEqual({ repoId: "r1", spec: { kind: "commit", oid: "bbb", parent: null }, path: "src/a.ts", oldPath: undefined });
  });
  it("drops a file that the new commit does not change", () => {
    expect(followFile(open("src/a.ts"), commit("bbb", ["other"]))).toBeNull();
  });
  it("drops a file of another repository", () => {
    expect(followFile(open("src/a.ts", "aaa", "r2"), commit("bbb", ["src/a.ts"]))).toBeNull();
  });
  it("returns the same object when the file already belongs to the commit", () => {
    const f = open("src/a.ts", "bbb");
    expect(followFile(f, commit("bbb", ["src/a.ts"]))).toBe(f);
  });
  it("uses the chosen parent and the old path of a rename", () => {
    const d = { repoId: "r1", oid: "bbb", parents: ["p0", "p1"], files: [{ path: "n.ts", oldPath: "o.ts" }] };
    expect(followFile(open("n.ts"), d, 1)).toMatchObject({ spec: { kind: "commit", oid: "bbb", parent: "p1" }, oldPath: "o.ts" });
  });
  it("does not follow a Local changes file", () => {
    const f: SelectedFile = { repoId: "r1", spec: { kind: "unstaged" }, path: "src/a.ts" };
    expect(followFile(f, commit("bbb", ["src/a.ts"]))).toBeNull();
  });
  it("has nothing to follow without an open file", () => {
    expect(followFile(null, commit("bbb", ["a"]))).toBeNull();
  });
});
