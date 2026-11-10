// @vitest-environment node
import { describe, expect, it } from "vitest";
import { generateRepo, repoId, type MockRepo, type Scenario } from "../api/mockData";
import type { RepoInfo, RepoSummary } from "../api/types";
import { changesCount, changesScope, dirtyCount } from "./changesScope";

/** Three mock repos with different amounts of local changes: 3 (api), 6 (web) and 0 (docs). */
const SCENARIOS: Scenario[] = [
  { name: "api", commits: 40, head: "main", dirty: { staged: 1, unstaged: 1, untracked: 1 } },
  { name: "web", commits: 40, head: "main", dirty: { staged: 2, unstaged: 3, untracked: 1 } },
  { name: "docs", commits: 40, head: "main" },
];
const NOW = 1_800_000_000;
const mocks: MockRepo[] = SCENARIOS.map((sc) => {
  const path = `/work/${sc.name}`;
  const info: RepoInfo = { id: repoId(path), name: sc.name, path };
  return generateRepo(info, `https://example.test/${sc.name}`, sc, NOW);
});
const repos = mocks.map((m) => m.info);
const [api, web, docs] = repos;

/** What the mock backend reports for a repo: the counts of its working tree. */
function summaryOf(id: string): RepoSummary | undefined {
  const m = mocks.find((x) => x.info.id === id);
  if (!m) return undefined;
  return {
    repoId: id, branch: "main", headOid: null, upstream: null, ahead: 0, behind: 0,
    staged: m.wt.staged.length,
    unstaged: m.wt.unstaged.filter((f) => f.status !== "untracked").length,
    untracked: m.wt.unstaged.filter((f) => f.status === "untracked").length,
    conflicted: m.wt.conflicted.length,
    state: "clean", stashCount: 0,
  };
}

const ids = (list: readonly { id: string }[]) => list.map((r) => r.id);

describe("changesScope", () => {
  it("fixture: the three mock repos have 3, 6 and 0 changed files", () => {
    expect(repos.map((r) => dirtyCount(summaryOf(r.id)))).toEqual([3, 6, 0]);
  });

  it("project level: shows every repo that passes the repo filter", () => {
    expect(ids(changesScope(repos, repos, null))).toEqual(ids(repos));
    expect(ids(changesScope(repos, [api, docs], null))).toEqual(ids([api, docs]));
  });

  it("a single repo picked shows only that repo, not the filter", () => {
    expect(ids(changesScope(repos, repos, web.id))).toEqual([web.id]);
    expect(ids(changesScope(repos, [api], web.id))).toEqual([web.id]);
  });

  it("an id that is not in the project falls back to the filter", () => {
    expect(ids(changesScope(repos, repos, "gone"))).toEqual(ids(repos));
  });

  it("a project with one repo has nothing to narrow", () => {
    expect(ids(changesScope([api], [api], api.id))).toEqual([api.id]);
  });

  it("does not return the caller's array", () => {
    expect(changesScope(repos, repos, null)).not.toBe(repos);
  });
});

describe("changesCount (badges and totals)", () => {
  it("counts only the repos of the scope", () => {
    expect(changesCount(changesScope(repos, repos, null), summaryOf)).toBe(9);
    expect(changesCount(changesScope(repos, repos, api.id), summaryOf)).toBe(3);
    expect(changesCount(changesScope(repos, repos, web.id), summaryOf)).toBe(6);
    expect(changesCount(changesScope(repos, repos, docs.id), summaryOf)).toBe(0);
  });

  it("follows the repo filter at project level", () => {
    expect(changesCount(changesScope(repos, [web, docs], null), summaryOf)).toBe(6);
  });

  it("counts a repo without a summary as 0", () => {
    expect(changesCount(repos, () => undefined)).toBe(0);
    expect(dirtyCount(undefined)).toBe(0);
  });

  it("counts conflicted files too", () => {
    const s = summaryOf(api.id)!;
    expect(dirtyCount({ ...s, conflicted: 2 })).toBe(5);
  });
});
