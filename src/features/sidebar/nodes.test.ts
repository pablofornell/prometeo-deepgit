// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Refs, RepoInfo, RepoSummary } from "../../api/types";
import { buildTree, expandableIds, filterTree, nestRepos, repoDot, stateLabel, type BuildContext } from "./nodes";

const repo = (id: string, path = `/w/${id}`): RepoInfo => ({ id, name: id, path, color: 0, customColor: null });
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
