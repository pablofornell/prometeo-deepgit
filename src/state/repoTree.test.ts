// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RepoInfo } from "../api/types";
import { groupRepos, nestRepos, sidebarOrder, type RepoGroup } from "./repoTree";

const repo = (id: string, path = `/w/${id}`): RepoInfo => ({ id, name: id, path });
/** A repo as the backend gives it: `name` is the path relative to the project root. */
const at = (name: string): RepoInfo => ({ id: name, name, path: `/w/${name}` });
const reposAt = (...names: string[]) => names.map(at);

describe("nestRepos", () => {
  it("nests a repo under the repo that contains it", () => {
    const { roots, children } = nestRepos([repo("p", "/w/p"), repo("c", "/w/p/vendor/c"), repo("q", "/w/q")]);
    expect(roots.map((r) => r.id)).toEqual(["p", "q"]);
    expect(children.get("p")?.map((r) => r.id)).toEqual(["c"]);
  });
});

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

describe("groupRepos inside a repo", () => {
  const shape = (list: readonly RepoGroup[]): unknown[] => list.map((g) => (g.kind === "repo" ? g.repo.name : { [g.label]: shape(g.children) }));
  const parent = at("platform");

  it("groups the nested repos of a repo by the folders below it", () => {
    const kids = reposAt("platform/services/a", "platform/services/b", "platform/libs/x", "platform/libs/y", "platform/tool", "platform/solo/z");
    const g = groupRepos(kids, parent);
    expect(shape(g)).toEqual([{ libs: ["platform/libs/x", "platform/libs/y"] }, { services: ["platform/services/a", "platform/services/b"] }, "platform/tool", "platform/solo/z"]);
    expect(g.filter((x) => x.kind === "folder").map((x) => (x.kind === "folder" ? x.path : ""))).toEqual(["platform/libs", "platform/services"]);
  });

  it("merges a chain below the repo and sorts case-insensitive and numeric", () => {
    const g = groupRepos(reposAt("platform/a/b/x", "platform/a/b/y", "platform/R10", "platform/r2", "platform/Q"), parent);
    expect(shape(g)).toEqual([{ "a/b": ["platform/a/b/x", "platform/a/b/y"] }, "platform/Q", "platform/r2", "platform/R10"]);
    expect(g[0]).toMatchObject({ path: "platform/a/b", label: "a/b" });
  });

  it("uses the path below a parent repo that is the project root", () => {
    const root: RepoInfo = { id: "root", name: "proj", path: "/w" };
    const kids: RepoInfo[] = ["s/a", "s/b"].map((n) => ({ id: n, name: n, path: `/w/${n}` }));
    expect(groupRepos(kids, root)[0]).toMatchObject({ kind: "folder", path: "s", label: "s" });
  });

  it("puts the nested repos in the sidebar order after their parent", () => {
    const order = sidebarOrder(reposAt("platform", "platform/tool", "platform/services/b", "platform/services/a", "other")).map((r) => r.name);
    expect(order).toEqual(["other", "platform", "platform/services/a", "platform/services/b", "platform/tool"]);
  });
});

describe("sidebarOrder", () => {
  it("lists repos depth-first in sidebar order (folders first, nested repos after their parent)", () => {
    const order = sidebarOrder(reposAt("zeta", "b/two", "b/one", "alpha", "alpha/inner", "c/x/y/1", "c/x/y/2")).map((r) => r.name);
    expect(order).toEqual(["b/one", "b/two", "c/x/y/1", "c/x/y/2", "alpha", "alpha/inner", "zeta"]);
  });
});
