// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FileChange, WorkingTree } from "../../api/types";
import {
  SEP, buildTree, closeTab, columnOffset, errorText, folderStatus, folderStatuses, groupHits, isStaleVersion, lineSeparatorOf,
  matchRange, openTab, rankFiles, repoNode, scopeId, statusMap, tabLabels, type DirNode,
} from "./model";

const change = (path: string, status: FileChange["status"]): FileChange => ({ path, oldPath: null, status, additions: 0, deletions: 0, binary: false });

const wt = (o: Partial<Omit<WorkingTree, "repoId">>): WorkingTree => ({ repoId: "r", staged: [], unstaged: [], conflicted: [], ...o });

describe("buildTree", () => {
  it("nests files under their folders and keeps the full path as the id", () => {
    const t = buildTree(["src/app/main.ts", "README.md"]);
    expect(t.map((n) => n.name)).toEqual(["src", "README.md"]);
    const src = t[0] as DirNode;
    expect(src.id).toBe("src/");
    expect(src.path).toBe("src/");
    const app = src.children[0] as DirNode;
    expect(app.id).toBe("src/app/");
    expect(app.children[0]).toMatchObject({ kind: "file", id: "src/app/main.ts", path: "src/app/main.ts", name: "main.ts" });
  });

  it("lists folders first, then names case-insensitively in natural order", () => {
    const t = buildTree(["z.md", "B/x", "a.rs", "A/y", "file10.rs", "file2.rs", "Zeta/q"]);
    expect(t.map((n) => n.name)).toEqual(["A", "B", "Zeta", "a.rs", "file2.rs", "file10.rs", "z.md"]);
  });

  it("sorts the children of a folder too", () => {
    const t = buildTree(["d/b.txt", "d/A.txt", "d/sub/x"]);
    const d = t[0] as DirNode;
    expect(d.children.map((n) => n.name)).toEqual(["sub", "A.txt", "b.txt"]);
  });

  it("scopes the ids with the repo id and gives the same path two ids in two repos", () => {
    const a = buildTree(["README.md", "src/x.ts"], "repoA");
    const b = buildTree(["README.md"], "repoB");
    // folders first: src/ is the first node, README.md the second
    expect(a[0].id).toBe("repoA" + SEP + "src/");
    expect(a[1].id).toBe("repoA" + SEP + "README.md");
    expect(a[1].repoId).toBe("repoA");
    expect(b[0].id).not.toBe(a[1].id);
    expect((a[0] as DirNode).children[0].id).toBe("repoA" + SEP + "src/x.ts");
  });

  it("returns nothing for an empty list", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("wraps one repo in a repo node", () => {
    const r = repoNode("r1", "api", ["a.ts"]);
    expect(r).toMatchObject({ kind: "repo", id: "r1" + SEP, repoId: "r1", name: "api" });
    expect(r.children[0]).toMatchObject({ kind: "file", id: scopeId("r1", "a.ts") });
  });

  it("scopes ids only when a repo id is given", () => {
    expect(scopeId("", "a/b")).toBe("a/b");
    expect(scopeId("r", "a/b")).toBe("r" + SEP + "a/b");
  });
});

describe("statusMap", () => {
  it("takes conflicted over unstaged over staged", () => {
    const m = statusMap(
      wt({
        staged: [change("a.ts", "added"), change("b.ts", "modified"), change("c.ts", "modified")],
        unstaged: [change("b.ts", "deleted"), change("d.ts", "untracked")],
        conflicted: [change("c.ts", "conflicted")],
      }),
    );
    expect(m.get("a.ts")).toBe("added");
    expect(m.get("b.ts")).toBe("deleted");
    expect(m.get("c.ts")).toBe("conflicted");
    expect(m.get("d.ts")).toBe("untracked");
    expect(m.size).toBe(4);
  });

  it("is empty for a clean tree", () => {
    expect(statusMap(wt({})).size).toBe(0);
  });
});

describe("folderStatuses and folderStatus", () => {
  const folders = (files: [string, Parameters<typeof change>[1]][]) => folderStatuses(new Map(files));

  it("marks every ancestor folder of a changed file", () => {
    const f = folders([["a/b/c.ts", "modified"]]);
    expect([...f.keys()].sort()).toEqual(["a/", "a/b/"]);
  });

  it("shows conflicted when any file below is conflicted", () => {
    const f = folders([["a/x.ts", "modified"], ["a/y.ts", "conflicted"]]);
    expect(folderStatus("a/", f)).toBe("conflicted");
  });

  it("shows modified when a tracked file below changed", () => {
    const f = folders([["a/x.ts", "untracked"], ["a/b/y.ts", "deleted"]]);
    expect(folderStatus("a/", f)).toBe("modified");
    expect(folderStatus("a/b/", f)).toBe("modified");
  });

  it("shows untracked when every changed file below is untracked", () => {
    const f = folders([["a/x.ts", "untracked"], ["a/b/y.ts", "untracked"]]);
    expect(folderStatus("a/", f)).toBe("untracked");
    expect(folderStatus("a/b", f)).toBe("untracked");
  });

  it("is null for a folder without changes", () => {
    const f = folders([["a/x.ts", "modified"]]);
    expect(folderStatus("z/", f)).toBeNull();
    expect(folderStatus("a", f)).toBe("modified");
  });

  it("gives no folder for a file at the root", () => {
    expect(folders([["README.md", "modified"]]).size).toBe(0);
  });
});

describe("groupHits", () => {
  it("groups by file in path order and keeps the hit order", () => {
    const hits = [
      { path: "src/b.ts", line: 1 },
      { path: "docs/a.md", line: 9 },
      { path: "src/b.ts", line: 4 },
      { path: "src/a.ts", line: 2 },
    ];
    const groups = groupHits(hits);
    expect(groups.map((g) => g.path)).toEqual(["docs/a.md", "src/a.ts", "src/b.ts"]);
    expect(groups[2].hits.map((h) => h.line)).toEqual([1, 4]);
  });

  it("returns nothing for no hits", () => {
    expect(groupHits([])).toEqual([]);
  });
});

describe("lineSeparatorOf", () => {
  it("is CRLF only when the content has a CRLF", () => {
    expect(lineSeparatorOf("a\r\nb")).toBe("\r\n");
    expect(lineSeparatorOf("a\nb")).toBe("\n");
    expect(lineSeparatorOf("a\rb")).toBe("\n");
    expect(lineSeparatorOf("")).toBe("\n");
  });
});

describe("tab helpers", () => {
  it("opens a key once and returns it as the active key", () => {
    const tabs = ["a"];
    expect(openTab(tabs, "b")).toBe("b");
    expect(openTab(tabs, "a")).toBe("a");
    expect(tabs).toEqual(["a", "b"]);
  });

  it("activates the right neighbour when the active tab closes", () => {
    const tabs = ["a", "b", "c"];
    expect(closeTab(tabs, "b", "b")).toBe("c");
    expect(tabs).toEqual(["a", "c"]);
  });

  it("falls back to the left neighbour when the last tab closes", () => {
    const tabs = ["a", "b", "c"];
    expect(closeTab(tabs, "c", "c")).toBe("b");
    expect(tabs).toEqual(["a", "b"]);
  });

  it("returns null when the only tab closes", () => {
    const tabs = ["a"];
    expect(closeTab(tabs, "a", "a")).toBeNull();
    expect(tabs).toEqual([]);
  });

  it("keeps the active tab when another tab closes", () => {
    const tabs = ["a", "b", "c"];
    expect(closeTab(tabs, "a", "c")).toBe("c");
    expect(tabs).toEqual(["b", "c"]);
  });

  it("keeps the active tab when a key that is not open closes", () => {
    const tabs = ["a"];
    expect(closeTab(tabs, "zz", "a")).toBe("a");
    expect(tabs).toEqual(["a"]);
  });

  it("adds the parent folder only to tabs with the same file name", () => {
    expect(tabLabels(["src/a/index.ts", "src/b/index.ts", "README.md"])).toEqual([
      { name: "index.ts", hint: "a" },
      { name: "index.ts", hint: "b" },
      { name: "README.md", hint: "" },
    ]);
  });

  it("gives no hint for a root file with a clashing name", () => {
    expect(tabLabels(["x.ts", "dir/x.ts"])).toEqual([
      { name: "x.ts", hint: "" },
      { name: "x.ts", hint: "dir" },
    ]);
  });

  it("uses the root hint (the repo name) for root files with a clashing name, and the folder when there is one", () => {
    expect(tabLabels(["README.md", "README.md", "docs/README.md"], ["api", "ledger", "ignored"])).toEqual([
      { name: "README.md", hint: "api" },
      { name: "README.md", hint: "ledger" },
      { name: "README.md", hint: "docs" },
    ]);
  });
});

describe("columnOffset and matchRange", () => {
  it("counts characters, not UTF-16 units", () => {
    // "😀" takes two UTF-16 units but one character
    expect(columnOffset("😀a", 2)).toBe(2);
    expect(columnOffset("abc", 1)).toBe(0);
    expect(columnOffset("abc", 99)).toBe(3);
  });

  it("finds a plain match, case-insensitively unless asked", () => {
    expect(matchRange("say Hello", 5, "hello", { caseSensitive: false, regex: false })).toEqual({ from: 4, to: 9 });
    expect(matchRange("say Hello", 5, "hello", { caseSensitive: true, regex: false })).toEqual({ from: 4, to: 4 });
  });

  it("finds a regex match at the column", () => {
    expect(matchRange("x = 12 + 345", 5, "\\d+", { caseSensitive: false, regex: true })).toEqual({ from: 4, to: 6 });
  });

  it("gives an empty range when the match cannot be checked", () => {
    expect(matchRange("abc", 1, "[", { caseSensitive: false, regex: true })).toEqual({ from: 0, to: 0 });
    expect(matchRange("abc", 1, "zzz", { caseSensitive: false, regex: false })).toEqual({ from: 0, to: 0 });
    expect(matchRange("abc", 1, "", { caseSensitive: false, regex: false })).toEqual({ from: 0, to: 0 });
  });
});

describe("rankFiles", () => {
  const paths = ["src/main.rs", "src/features/log/LogView.tsx", "README.md", "docs/guide.md"];

  it("keeps the order and caps the rows for an empty query", () => {
    expect(rankFiles("", paths, (p) => p, 2).map((r) => r.item)).toEqual(["src/main.rs", "src/features/log/LogView.tsx"]);
  });

  it("drops the files that do not match and puts file-name matches first", () => {
    const out = rankFiles("guide", paths, (p) => p);
    expect(out.map((r) => r.item)).toEqual(["docs/guide.md"]);
    const logs = rankFiles("logview", paths, (p) => p);
    expect(logs[0].item).toBe("src/features/log/LogView.tsx");
    expect(logs[0].positions.length).toBeGreaterThan(0);
  });

  it("uses the item's path through pathOf", () => {
    const items = [{ path: "a/zeta.ts" }, { path: "b/alpha.ts" }];
    expect(rankFiles("alpha", items, (i) => i.path).map((r) => r.item.path)).toEqual(["b/alpha.ts"]);
  });
});

describe("error and stale-version helpers", () => {
  it("reads the message of a rejection object or a plain value", () => {
    expect(errorText({ message: "boom" })).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(new Error("bad"))).toBe("bad");
  });

  it("recognises the changed-on-disk message", () => {
    expect(isStaleVersion("The file changed on disk. Reload it before you save.")).toBe(true);
    expect(isStaleVersion("Permission denied")).toBe(false);
  });
});
