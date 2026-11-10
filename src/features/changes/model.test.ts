// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FileChange, WorkingTree } from "../../api/types";
import {
  buildRows, buildTree, commitLabel, fileKey, groupByRepo, nearestSurvivor, rangeKeys, repoKey, rowItems, sectionKey,
  selectedItems, subjectLength, type Row,
} from "./model";

const file = (path: string, status: FileChange["status"] = "modified"): FileChange => ({
  path, oldPath: null, status, additions: 1, deletions: 0, binary: false,
});
const wt = (staged: string[], unstaged: string[], conflicted: string[] = []): WorkingTree => ({
  repoId: "r1", staged: staged.map((p) => file(p)), unstaged: unstaged.map((p) => file(p)), conflicted: conflicted.map((p) => file(p, "conflicted")),
});

describe("buildTree", () => {
  it("compresses single-child chains and sorts directories first", () => {
    const tree = buildTree([file("src/refunds/a.rs"), file("src/refunds/b.rs"), file("README.md"), file("docs/x/y/z.md")]);
    expect(tree.map((n) => (n.kind === "dir" ? `dir:${n.name}` : `file:${n.file.path}`))).toEqual(["dir:docs/x/y", "dir:src/refunds", "file:README.md"]);
    const refunds = tree[1];
    expect(refunds.kind === "dir" && refunds.path).toBe("src/refunds");
    expect(refunds.kind === "dir" && refunds.files.length).toBe(2);
  });

  it("does not merge a directory that also has files", () => {
    const tree = buildTree([file("src/main.rs"), file("src/util/mod.rs")]);
    expect(tree).toHaveLength(1);
    const src = tree[0];
    expect(src.kind === "dir" && src.name).toBe("src");
    expect(src.kind === "dir" && src.children.map((c) => (c.kind === "dir" ? c.name : c.file.path))).toEqual(["util", "src/main.rs"]);
  });
});

describe("buildRows", () => {
  const base = { grouped: true, mode: "tree" as const, collapsed: new Set<string>() };

  it("emits repo, section, dir and file rows in order, conflicts first", () => {
    const rows = buildRows({ ...base, repos: [{ repoId: "r1", wt: wt(["a/x.ts"], ["b.ts"], ["c.ts"]) }] });
    expect(rows.map((r) => r.kind)).toEqual(["repo", "section", "file", "section", "dir", "file", "section", "file"]);
    expect(rows.filter((r) => r.kind === "section").map((r) => (r.kind === "section" ? r.section : ""))).toEqual(["conflicts", "staged", "unstaged"]);
  });

  it("flat mode lists files without directories and skips empty sections", () => {
    const rows = buildRows({ ...base, mode: "flat", grouped: false, repos: [{ repoId: "r1", wt: wt([], ["z/b.ts", "a.ts"]) }] });
    expect(rows.map((r) => r.key)).toEqual([sectionKey("r1", "unstaged"), fileKey("r1", "unstaged", "a.ts"), fileKey("r1", "unstaged", "z/b.ts")]);
  });

  it("hides the children of collapsed repos and sections", () => {
    const repos = [{ repoId: "r1", wt: wt(["a.ts"], ["b.ts"]) }];
    expect(buildRows({ ...base, repos, collapsed: new Set([repoKey("r1")]) }).map((r) => r.kind)).toEqual(["repo"]);
    const rows = buildRows({ ...base, repos, collapsed: new Set([sectionKey("r1", "staged")]) });
    expect(rows.map((r) => r.kind)).toEqual(["repo", "section", "section", "file"]);
  });
});

describe("selection helpers", () => {
  const rows: Row[] = buildRows({ grouped: false, mode: "tree", collapsed: new Set(), repos: [{ repoId: "r1", wt: wt([], ["a/1.ts", "a/2.ts", "b.ts"]) }] });

  it("rowItems of a directory are all its files; selectedItems deduplicates", () => {
    const dir = rows.find((r) => r.kind === "dir") as Row;
    expect(rowItems(dir).map((i) => i.file.path)).toEqual(["a/1.ts", "a/2.ts"]);
    const sel = new Set([dir.key, fileKey("r1", "unstaged", "a/1.ts"), fileKey("r1", "unstaged", "b.ts")]);
    expect(selectedItems(rows, sel).map((i) => i.file.path)).toEqual(["a/1.ts", "a/2.ts", "b.ts"]);
  });

  it("rangeKeys skips header rows and works backwards", () => {
    const first = fileKey("r1", "unstaged", "a/1.ts");
    const last = fileKey("r1", "unstaged", "b.ts");
    expect(rangeKeys(rows, last, first)).toEqual([first, fileKey("r1", "unstaged", "a/2.ts"), last]);
    expect(rangeKeys(rows, "nope", first)).toEqual([]);
  });

  it("nearestSurvivor prefers the row below, then above", () => {
    const keys = ["f:1", "f:2", "f:3", "f:4"];
    expect(nearestSurvivor(keys, "f:2", new Set(["f:1", "f:3", "f:4"]))).toBe("f:3");
    expect(nearestSurvivor(keys, "f:4", new Set(["f:1", "f:2"]))).toBe("f:2");
    expect(nearestSurvivor(keys, "f:2", new Set())).toBeNull();
    expect(nearestSurvivor(keys, "gone", new Set(keys))).toBeNull();
    expect(nearestSurvivor(keys, "f:2", new Set(keys), (k) => k !== "f:3")).toBe("f:4");
  });

  it("groupByRepo keeps order", () => {
    const items = [
      { repoId: "a", section: "staged" as const, file: file("1") },
      { repoId: "b", section: "staged" as const, file: file("2") },
      { repoId: "a", section: "staged" as const, file: file("3") },
    ];
    const g = groupByRepo(items);
    expect([...g.keys()]).toEqual(["a", "b"]);
    expect(g.get("a")?.map((i) => i.file.path)).toEqual(["1", "3"]);
  });
});

describe("commit message helpers", () => {
  it("measures the subject line only", () => {
    expect(subjectLength("Fix it\n\nlong body ".repeat(10))).toBe(6);
    expect(subjectLength("")).toBe(0);
    expect(subjectLength("héllo")).toBe(5);
  });
  it("labels the primary button", () => {
    expect(commitLabel(1, false)).toBe("Commit");
    expect(commitLabel(3, false)).toBe("Commit in 3 repos");
    expect(commitLabel(1, true)).toBe("Amend commit");
    expect(commitLabel(2, true)).toBe("Amend commit in 2 repos");
  });
});
