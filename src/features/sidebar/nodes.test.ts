// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Refs, RepoInfo, RepoSummary } from "../../api/types";
import {
  ancestorIds, buildTree, expandableIds, filterTree, folderAbsPath, folderIds, repoDot, stateLabel, worstDot,
  type BuildContext, type SidebarNode,
} from "./nodes";

const repo = (id: string, path = `/w/${id}`): RepoInfo => ({ id, name: id, path });
const branch = (name: string, isHead = false) => ({ name, oid: "a".repeat(40), upstream: null, ahead: 0, behind: 0, isHead, gone: false });
const remote = (name: string) => ({ remote: "origin", name, fullName: `origin/${name}`, oid: "a".repeat(40) });
const refs = (over: Partial<Refs> = {}): Refs => ({ local: [], remote: [], tags: [], stashes: [], remotes: [{ name: "origin", url: "" }], submodules: [], ...over });

const ctx = (r: Refs | undefined, over: Partial<BuildContext> = {}): BuildContext => ({
  refsOf: () => r,
  summaryOf: () => undefined,
  expanded: new Set<string>(["repo:a"]),
  moreOpen: new Set<string>(),
  query: "",
  ...over,
});

describe("buildTree", () => {
  it("skips the repo level for a single repo and puts the current branch first", () => {
    const tree = buildTree([repo("a")], ctx(refs({ local: [branch("b"), branch("main", true)] })));
    expect(tree.map((n) => n.label)).toEqual(["Local"]);
    expect(tree[0].children?.map((n) => n.label)).toEqual(["main", "b"]);
  });

  it("shows a loading child for a collapsed repo and the groups once expanded", () => {
    const r = refs({ local: [branch("main", true)], tags: [{ name: "v1", oid: "b".repeat(40), annotated: false }] });
    const collapsed = buildTree([repo("a"), repo("b")], ctx(r, { expanded: new Set() }));
    expect(collapsed[0].children?.[0].kind).toBe("loading");
    const open = buildTree([repo("a"), repo("b")], ctx(r));
    expect(open[0].children?.map((n) => n.label)).toEqual(["Local", "Tags"]);
  });

  it("truncates long remote lists to 2 + a link and expands on request", () => {
    const many = Array.from({ length: 12 }, (_, i) => remote(`f${String(i).padStart(2, "0")}`));
    const r = refs({ remote: many });
    const t = buildTree([repo("a"), repo("b")], ctx(r))[0].children?.[0];
    expect(t?.children?.map((n) => n.label)).toEqual(["f00", "f01", "10 more…"]);
    const all = buildTree([repo("a"), repo("b")], ctx(r, { moreOpen: new Set(["rem:a:origin"]) }))[0].children?.[0];
    expect(all?.children).toHaveLength(12);
  });

  it("does not truncate while searching", () => {
    const many = Array.from({ length: 12 }, (_, i) => remote(`f${i}`));
    const t = buildTree([repo("a"), repo("b")], ctx(refs({ remote: many }), { query: "f" }))[0].children?.[0];
    expect(t?.children).toHaveLength(12);
  });
});

describe("filterTree", () => {
  it("keeps matching leaves with their ancestors", () => {
    const tree = buildTree([repo("a"), repo("b")], ctx(refs({ local: [branch("main", true), branch("feature/x")] }), { query: "feat" }));
    const out = filterTree(tree, "feat");
    expect(out[0].label).toBe("a");
    expect(out[0].children?.[0].children?.map((n) => n.label)).toEqual(["feature/x"]);
    expect(expandableIds(out).has("grp:a:local")).toBe(true);
  });
  it("keeps a matching repo without its non-matching children", () => {
    const tree = buildTree([repo("refunds"), repo("b")], ctx(refs({ local: [branch("main", true)] }), { expanded: new Set(["repo:refunds"]), query: "refund" }));
    const out = filterTree(tree, "refund");
    expect(out.map((n) => n.label)).toEqual(["refunds"]);
    expect(out[0].children).toEqual([]);
  });
  it("returns everything for an empty query", () => {
    const tree = buildTree([repo("a"), repo("b")], ctx(refs()));
    expect(filterTree(tree, " ")).toHaveLength(2);
  });
});

describe("repo state", () => {
  const s = (over: Partial<RepoSummary>): RepoSummary => ({ repoId: "a", branch: "main", headOid: null, upstream: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, state: "clean", stashCount: 0, ...over });
  it("maps operation, dirty and clean", () => {
    expect(repoDot(s({}))).toBe("clean");
    expect(repoDot(s({ untracked: 1 }))).toBe("dirty");
    expect(repoDot(s({ state: "rebasing" }))).toBe("conflict");
    expect(repoDot(s({ conflicted: 2 }))).toBe("conflict");
    expect(stateLabel("rebasing")).toBe("rebasing");
    expect(stateLabel("clean")).toBeNull();
  });
});

/** A repo as the backend gives it: `name` is the path relative to the project root. */
const at = (name: string): RepoInfo => ({ id: name, name, path: `/w/${name}` });
const reposAt = (...names: string[]) => names.map(at);

/** Compact text of a tree: folders as `dir:label(count)`, repos as their label, indented. */
function outline(nodes: readonly SidebarNode[], depth = 0): string[] {
  return nodes.flatMap((n) => {
    if (n.kind === "folder") return [`${"  ".repeat(depth)}${n.label} (${n.repoIds.length})`, ...outline(n.children, depth + 1)];
    if (n.kind === "repo") return [`${"  ".repeat(depth)}${n.label}`, ...outline(n.children.filter((c) => c.kind === "repo" || c.kind === "folder"), depth + 1)];
    return [];
  });
}

describe("buildTree with folders", () => {
  it("builds folder nodes with id dir:<path>, the count of repos below and repo rows with the name only", () => {
    const names = ["IRIS", "HAB", "gus"].flatMap((d) => ["core", "backend", "frontend"].map((r) => `${d}/${r}`));
    const tree = buildTree(reposAt(...names), ctx(undefined, { expanded: new Set() }));
    expect(tree.map((n) => [n.id, n.kind, n.label])).toEqual([
      ["dir:gus", "folder", "gus"],
      ["dir:HAB", "folder", "HAB"],
      ["dir:IRIS", "folder", "IRIS"],
    ]);
    expect(tree.map((n) => (n.kind === "folder" ? n.repoIds.length : 0))).toEqual([3, 3, 3]);
    expect(tree[0].children?.map((n) => n.label)).toEqual(["backend", "core", "frontend"]);
    expect(tree[0].children?.every((n) => n.kind === "repo")).toBe(true);
  });

  it("keeps nested repos under their repo, grouped by folder inside it, and counts them in the folder", () => {
    const repos = reposAt("app", "app/libs/x", "app/libs/y", "t/a", "t/b");
    const tree = buildTree(repos, ctx(undefined, { expanded: new Set() }));
    expect(outline(tree)).toEqual(["t (2)", "  a", "  b", "app", "  libs (2)", "    x", "    y"]);
    const folder = buildTree(reposAt("g/app", "g/app/sub", "g/other"), ctx(undefined, { expanded: new Set() }))[0];
    expect(folder).toMatchObject({ kind: "folder", label: "g" });
    expect(folder.kind === "folder" && folder.repoIds).toEqual(["g/app", "g/app/sub", "g/other"]);
  });

  it("groups the repos inside a repo by folder, with ids relative to the project root", () => {
    const repos = reposAt("platform", "platform/services/a", "platform/services/b", "platform/libs/x", "platform/libs/y", "platform/tool", "platform/solo/z");
    const tree = buildTree(repos, ctx(undefined, { expanded: new Set() }));
    expect(outline(tree)).toEqual(["platform", "  libs (2)", "    x", "    y", "  services (2)", "    a", "    b", "  tool", "  z"]);
    expect(folderIds(tree)).toEqual(["dir:platform/libs", "dir:platform/services"]);
    // a chain below the repo merges, and a repo nested in a repo that is nested keeps its own level
    const deep = buildTree(reposAt("p", "p/a/b/x", "p/a/b/y", "p/a/b/x/inner"), ctx(undefined, { expanded: new Set() }));
    expect(outline(deep)).toEqual(["p", "  a/b (3)", "    x", "      inner", "    y"]);
    expect(folderIds(deep)).toEqual(["dir:p/a/b"]);
  });

  it("groups nested repos of a repo at the project root and sorts them like the other levels", () => {
    const root: RepoInfo = { id: "root", name: "proj", path: "/w" };
    const kids: RepoInfo[] = ["s/b10", "s/B2", "s/a", "t/x", "t/y", "Z", "m"].map((n) => ({ id: n, name: n, path: `/w/${n}` }));
    const tree = buildTree([root, ...kids], ctx(undefined, { expanded: new Set() }));
    expect(outline(tree)).toEqual(["proj", "  s (3)", "    a", "    B2", "    b10", "  t (2)", "    x", "    y", "  m", "  Z"]);
    expect(folderIds(tree)).toEqual(["dir:s", "dir:t"]);
  });

  it("lists the ancestors of a node, outermost first", () => {
    const tree = buildTree(reposAt("g/a", "g/b", "p", "p/x/c", "p/x/d"), ctx(undefined, { expanded: new Set() }));
    expect(ancestorIds(tree, "repo:p/x/d")).toEqual(["repo:p", "dir:p/x"]);
    expect(ancestorIds(tree, "repo:g/a")).toEqual(["dir:g"]);
    expect(ancestorIds(tree, "repo:p")).toEqual([]);
    expect(ancestorIds(tree, "repo:nope")).toEqual([]);
  });

  it("shows a chain label and no folder for a project with one repo", () => {
    expect(outline(buildTree(reposAt("a/b/x", "a/b/y"), ctx(undefined)))).toEqual(["a/b (2)", "  x", "  y"]);
    expect(buildTree(reposAt("a/b/x"), ctx(refs({ local: [branch("main", true)] }))).map((n) => n.label)).toEqual(["Local"]);
  });

  it("lists the folder ids and filters folders by label", () => {
    const tree = buildTree(reposAt("a/b/x", "a/b/y", "c/d", "c/e/f", "c/e/g"), ctx(undefined, { expanded: new Set() }));
    expect(folderIds(tree)).toEqual(["dir:a/b", "dir:c", "dir:c/e"]);
    expect(outline(filterTree(tree, "e/f"))).toEqual([]);
    expect(outline(filterTree(tree, "f"))).toEqual(["c (3)", "  e (2)", "    f"]);
    expect(outline(filterTree(tree, "x"))).toEqual(["a/b (2)", "  x"]);
    expect(expandableIds(filterTree(tree, "x")).has("dir:a/b")).toBe(true);
  });
});

describe("folder helpers", () => {
  it("builds the absolute path of a folder from one repo", () => {
    expect(folderAbsPath("IRIS/services", { id: "x", name: "IRIS/services/api", path: "/w/p/IRIS/services/api" })).toBe("/w/p/IRIS/services");
    expect(folderAbsPath("IRIS", { id: "x", name: "IRIS/services/api", path: "C:\\w\\IRIS\\services\\api" })).toBe("C:\\w\\IRIS");
  });

  it("takes the worst state of the repos: conflict, then dirty, then clean", () => {
    const sum = (over: Partial<RepoSummary>) => ({ state: "clean", conflicted: 0, staged: 0, unstaged: 0, untracked: 0, ...over }) as RepoSummary;
    const map: Record<string, RepoSummary> = { a: sum({}), b: sum({ unstaged: 2 }), c: sum({ conflicted: 1 }) };
    const of = (id: string) => map[id];
    expect(worstDot(["a"], of)).toBe("clean");
    expect(worstDot(["a", "b"], of)).toBe("dirty");
    expect(worstDot(["a", "b", "c"], of)).toBe("conflict");
    expect(worstDot(["zz"], of)).toBe("clean");
  });
});
