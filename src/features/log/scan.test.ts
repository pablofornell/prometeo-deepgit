// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CommitRow, RefLabel } from "../../api/types";
import { assembleScan, markOf, scanPage } from "./scan";

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime();
const at = (d: number) => new Date(2026, 10, d, 9, 0, 0).getTime() / 1000;

const row = (repoId: string, t: number, refs: RefLabel[] = [], author = "a@x", lane = 0): CommitRow => ({
  repoId, oid: "a".repeat(40), parents: [], authorName: author, authorEmail: author, authorTime: t, committerTime: t, subject: "s", refs,
  graph: { node: lane, color: 0, width: lane + 1, segments: [] },
});

describe("markOf", () => {
  it("prefers HEAD over branches over tags", () => {
    const tag: RefLabel = { kind: "tag", name: "v1", isCurrent: false };
    const br: RefLabel = { kind: "remote", name: "origin/x", isCurrent: false };
    const cur: RefLabel = { kind: "local", name: "main", isCurrent: true };
    expect(markOf(row("r", 0, [tag, br]), 3)).toMatchObject({ kind: "branch", label: "origin/x", row: 3 });
    expect(markOf(row("r", 0, [tag]), 3)?.kind).toBe("tag");
    expect(markOf(row("r", 0, [tag, br, cur]), 3)).toMatchObject({ kind: "head", label: "HEAD -> main" });
    expect(markOf(row("r", 0), 3)).toBeNull();
  });
});

describe("scan", () => {
  it("builds groups, marks, heads and authors across pages", () => {
    const head: RefLabel = { kind: "local", name: "main", isCurrent: true };
    const p0 = scanPage([row("r1", at(12), [head], "x@y", 2), row("r1", at(11)), row("r2", at(11), [], "z@y")], 0, NOW);
    const p1 = scanPage([row("r1", at(11), [{ kind: "tag", name: "v1", isCurrent: false }], "x@y"), row("r1", at(3))], 3, NOW);
    const s = assembleScan([p0, p1]);
    expect(s.groupLabels).toEqual(["Today", "Yesterday", "Last week"]);
    expect(s.groupStarts).toEqual([0, 1, 4]);
    expect(s.marks.map((m) => [m.row, m.kind])).toEqual([[0, "head"], [3, "tag"]]);
    expect(s.heads.get("r1")).toEqual({ row: 0, lane: 2 });
    expect(s.authors.get("x@y")?.count).toBe(2);
    expect(s.authors.size).toBe(3);
    expect(s.complete).toBe(true);
  });
});
