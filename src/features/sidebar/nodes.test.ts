// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Refs, RepoInfo, RepoSummary } from "../../api/types";
import {
  buildTree, expandableIds, filterTree, folderAbsPath, folderIds, groupRepos, nestRepos, repoDot, sidebarOrder, stateLabel, worstDot,
  type BuildContext, type RepoGroup, type SidebarNode,
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

describe("nestRepos", () => {
  it("nests a repo under the repo that contains it", () => {
    const { roots, children } = nestRepos([repo("p", "/w/p"), repo("c", "/w/p/vendor/c"), repo("q", "/w/q")]);
    expect(roots.map((r) => r.id)).toEqual(["p", "q"]);
    expect(children.get("p")?.map((r) => r.id)).toEqual(["c"]);
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
    if (n.kind === "repo") return [`${"  ".repeat(depth)}${n.label}`, ...outline(n.children.filter((c) => c.kind === "repo"), depth + 1)];
    return [];
  });
}

describe("groupRepos", () => {
  const shape = (list: readonly RepoGroup[]): unknown[] => list.map((g) => (g.kind === "repo" ? g.repo.name : { [g.label]: shape(g.children) }));

  it("groups the request example: 3 folders with 3 repos each", () => {
    const names = ["IRIS", "HAB", "gus"].flatMap((d) => ["core", "backend", "frontend"].map((r) => `${d}/${r}`));
    const g = groupRepos(reposAt(...names));
    expect(g.map((x) => x.kind)).toEqual(["folder", "folder", "folder"]);
    expect(shape(g)).toEqual([
      { gus: ["gus/backend", "gus/core", "gus/frontend"] },
      { HAB: ["HAB/backend", "HAB/core", "HAB/frontend"] },
      { IRIS: ["IRIS/backend", "IRIS/core", "IRIS/frontend"] },
    ]);
    expect(g.map((x) => (x.kind === "folder" ? x.count : 0))).toEqual([3, 3, 3]);
  });

  it("moves the repo of a folder with one repo up to the parent level", () => {
    expect(shape(groupRepos(reposAt("solo/api", "web", "tools/a", "tools/b")))).toEqual([{ tools: ["tools/a", "tools/b"] }, "solo/api", "web"]);
  });

  it("groups at every level and sorts folders first, then repos, case-insensitive and numeric", () => {
    const g = groupRepos(reposAt("zeta", "Alpha", "p/x10", "p/x9", "p/q/a", "p/q/b", "r10/a", "r10/b", "r2/a", "r2/b", "p/Beta"));
    expect(shape(g)).toEqual([
      { p: [{ q: ["p/q/a", "p/q/b"] }, "p/Beta", "p/x9", "p/x10"] },
      { r2: ["r2/a", "r2/b"] },
      { r10: ["r10/a", "r10/b"] },
      "Alpha",
      "zeta",
    ]);
  });

  it("merges a chain of single-child folders into one row and uses the deepest path as id", () => {
    const g = groupRepos(reposAt("a/b/c/x", "a/b/c/y", "a/b/c/z"));
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: "folder", label: "a/b/c", path: "a/b/c", count: 3 });
  });

  it("merges the chain only down to the first folder that has repos or several children", () => {
    const g = groupRepos(reposAt("HAB/api", "HAB/web", "HAB/tools/scripts/deploy", "HAB/tools/scripts/lint"));
    expect(shape(g)).toEqual([{ HAB: [{ "tools/scripts": ["HAB/tools/scripts/deploy", "HAB/tools/scripts/lint"] }, "HAB/api", "HAB/web"] }]);
    // two sibling folders with one repo each: both hoist, and the parent holds two repos
    expect(shape(groupRepos(reposAt("p/a/x", "p/b/y")))).toEqual([{ p: ["p/a/x", "p/b/y"] }]);
  });

  it("never merges a folder into a repo row", () => {
    // `deep/one` holds one repo: no folder, the row shows the repo name only
    const g = groupRepos(reposAt("deep/one/solo", "shared"));
    expect(g.map((x) => x.kind)).toEqual(["repo", "repo"]);
    expect(g.map((x) => x.label)).toEqual(["shared", "solo"]);
  });

  it("makes no folder for a single repo or for repos at the project root", () => {
    expect(groupRepos(reposAt("only"))).toMatchObject([{ kind: "repo", label: "only" }]);
    expect(groupRepos(reposAt("a/only"))).toMatchObject([{ kind: "repo", label: "only" }]);
    expect(shape(groupRepos(reposAt("b", "a")))).toEqual(["a", "b"]);
  });
});

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

  it("keeps nested repos under their repo, without folders, and counts them in the folder", () => {
    const repos = reposAt("app", "app/libs/x", "app/libs/y", "t/a", "t/b");
    const tree = buildTree(repos, ctx(undefined, { expanded: new Set() }));
    expect(outline(tree)).toEqual(["t (2)", "  a", "  b", "app", "  x", "  y"]);
    const folder = buildTree(reposAt("g/app", "g/app/sub", "g/other"), ctx(undefined, { expanded: new Set() }))[0];
    expect(folder).toMatchObject({ kind: "folder", label: "g" });
    expect(folder.kind === "folder" && folder.repoIds).toEqual(["g/app", "g/app/sub", "g/other"]);
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

describe("sidebarOrder", () => {
  it("lists repos depth-first in sidebar order (folders first, nested repos after their parent)", () => {
    const order = sidebarOrder(reposAt("zeta", "b/two", "b/one", "alpha", "alpha/inner", "c/x/y/1", "c/x/y/2")).map((r) => r.name);
    expect(order).toEqual(["b/one", "b/two", "c/x/y/1", "c/x/y/2", "alpha", "alpha/inner", "zeta"]);
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
