// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Candidates } from "./results";
import { PER_GROUP, buildRows, rankItems } from "./results";
import type { PaletteItem } from "./sources";

const action = (key: string, title: string): PaletteItem => ({ kind: "action", key, title, icon: "gear", group: "Git" });
const branch = (name: string, isCurrent = false): PaletteItem => ({ kind: "branch", key: "l:" + name, name, remote: false, repoIds: ["r1"], isCurrent, ahead: 0, behind: 0 });
const commit = (oid: string, subject: string): PaletteItem => ({ kind: "commit", key: "r1:" + oid, repoId: "r1", oid, subject, authorName: "A" });

const label = (i: PaletteItem): string => (i.kind === "action" ? i.title : i.kind === "branch" ? i.name : i.kind === "commit" ? i.subject : i.key);
const empty: Candidates = { actions: [], branches: [], repos: [], files: [], commits: [], recent: [] };

describe("rankItems", () => {
  it("filters and orders by score", () => {
    const hits = rankItems([action("a", "Pull all"), action("b", "Push"), action("c", "Fetch")], "pu", label);
    expect(hits.map((h) => h.item.key)).toEqual(expect.arrayContaining(["a", "b"]));
    expect(hits.some((h) => h.item.key === "c")).toBe(false);
  });

  it("keeps the order for an empty query", () => {
    const hits = rankItems([action("a", "Zed"), action("b", "Alpha")], "", label);
    expect(hits.map((h) => h.item.key)).toEqual(["a", "b"]);
  });

  it("puts the current branch first among equal matches", () => {
    const hits = rankItems([branch("main-old"), branch("main", true)], "main", label);
    expect(hits[0].item.key).toBe("l:main");
  });
});

describe("buildRows", () => {
  it("shows recents for an empty All query", () => {
    const rows = buildRows("all", "", { ...empty, recent: [action("a", "Fetch")], actions: [action("b", "Push")] }, label);
    expect(rows.map((r) => r.t)).toEqual(["group", "hit"]);
    expect(rows[0]).toMatchObject({ label: "Recent" });
  });

  it("groups and caps hits in All, with a more link", () => {
    const actions = Array.from({ length: 7 }, (_, i) => action("a" + i, "Push " + i));
    const rows = buildRows("all", "push", { ...empty, actions, branches: [branch("push-fix")] }, label);
    const groups = rows.filter((r) => r.t === "group").map((r) => (r as { label: string }).label);
    expect(groups).toHaveLength(2);
    expect(rows.filter((r) => r.t === "hit")).toHaveLength(PER_GROUP + 1);
    expect(rows.find((r) => r.t === "more")).toMatchObject({ scope: "actions", count: 3 });
  });

  it("keeps commits last", () => {
    const rows = buildRows("all", "fix", { ...empty, commits: [commit("1", "Fix login")], branches: [branch("hotfix")] }, label);
    const groups = rows.filter((r) => r.t === "group").map((r) => (r as { label: string }).label);
    expect(groups).toEqual(["Branches", "Commits"]);
  });

  it("does not list commits for an empty All query", () => {
    const rows = buildRows("all", "", { ...empty, commits: [commit("1", "Fix login")], branches: [branch("main")] }, label);
    expect(rows.some((r) => r.t === "hit" && r.hit.item.kind === "commit")).toBe(false);
  });

  it("lists a single scope flat", () => {
    const rows = buildRows("actions", "", { ...empty, actions: [action("a", "Fetch"), action("b", "Push")] }, label);
    expect(rows.every((r) => r.t === "hit")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("highlights commit subjects by the text", () => {
    const rows = buildRows("commits", "login", { ...empty, commits: [commit("1", "Fix login")] }, label);
    expect(rows[0]).toMatchObject({ t: "hit", hit: { positions: [4, 5, 6, 7, 8] } });
  });
});
