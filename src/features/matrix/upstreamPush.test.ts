// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Refs } from "../../api/types";
import { buildBranchTable, type BranchCell } from "../../state/branchTable";
import {
  columnLacksUpstream, commitsText, countUnpushed, defaultRemote, firstLine, lacksUpstream, planUpstreamRows, remoteNames, runUpstreamPushes,
  summarizeRun, type RowStatus,
} from "./upstreamPush";

const cell = (state: BranchCell["state"], upstream: string | null = null, gone = false): BranchCell => ({ state, ahead: 0, behind: 0, gone, upstream });
const lb = (name: string, upstream: string | null, gone = false, isHead = false) => ({ name, oid: "a".repeat(40), upstream, ahead: 0, behind: 0, isHead, gone });
const refs = (local: Refs["local"], remote: Refs["remote"] = []): Refs => ({ local, remote, tags: [], stashes: [], remotes: [], submodules: [] });

describe("lacksUpstream", () => {
  it("is true for a local or checked-out branch without upstream", () => {
    expect(lacksUpstream(cell("local"))).toBe(true);
    expect(lacksUpstream(cell("current"))).toBe(true);
  });
  it("is false with an upstream, even a deleted one", () => {
    expect(lacksUpstream(cell("local", "origin/x"))).toBe(false);
    expect(lacksUpstream(cell("local", "origin/x", true))).toBe(false);
    expect(lacksUpstream(cell("current", null, true))).toBe(false);
  });
  it("is false for remote-only and missing cells", () => {
    expect(lacksUpstream(cell("remote"))).toBe(false);
    expect(lacksUpstream(cell("missing"))).toBe(false);
  });
});

describe("columnLacksUpstream", () => {
  const data: Record<string, Refs> = {
    a: refs([lb("feat", null), lb("tracked", "origin/tracked"), lb("gone", "origin/gone", true)]),
    b: refs([lb("tracked", "origin/tracked"), lb("gone", "origin/gone", true)], [{ remote: "origin", name: "feat", fullName: "origin/feat", oid: "a".repeat(40) }]),
  };
  const table = buildBranchTable(["a", "b"], (id) => data[id]);
  const pass = (n: string) => columnLacksUpstream(table.find((c) => c.name === n)!);
  it("passes when one repo has the branch locally without upstream", () => {
    expect(pass("feat")).toBe(true);
  });
  it("does not pass for tracked or gone branches", () => {
    expect(pass("tracked")).toBe(false);
    expect(pass("gone")).toBe(false);
  });
});

describe("remotes", () => {
  it("lists every remote once, in order of appearance", () => {
    expect(remoteNames([["origin", "fork"], [], ["fork", "up"]])).toEqual(["origin", "fork", "up"]);
  });
  it("defaults to origin, else the first remote, else origin", () => {
    expect(defaultRemote(["fork", "origin"])).toBe("origin");
    expect(defaultRemote(["fork", "up"])).toBe("fork");
    expect(defaultRemote([])).toBe("origin");
  });
  it("disables the repos without the chosen remote", () => {
    const rows = planUpstreamRows([{ repoId: "a", remotes: ["origin"] }, { repoId: "b", remotes: [] }, { repoId: "c", remotes: ["fork"] }], "origin");
    expect(rows).toEqual([
      { repoId: "a", enabled: true, reason: null },
      { repoId: "b", enabled: false, reason: "No remote named origin" },
      { repoId: "c", enabled: false, reason: "No remote named origin" },
    ]);
  });
});

describe("countUnpushed", () => {
  const row = (oid: string, parents: string[], remote = false) => ({ oid, parents, refs: remote ? [{ kind: "remote" as const, name: "origin/main", isCurrent: false }] : [] });
  it("counts the commits above the first remote commit", () => {
    const rows = [row("c", ["b"]), row("b", ["a"]), row("a", ["z"], true), row("z", [])];
    expect(countUnpushed(rows, false)).toEqual({ count: 2, complete: true });
  });
  it("passes the remote label down to the parents of a merge", () => {
    const rows = [row("m", ["x", "y"]), row("x", ["r"], true), row("y", ["r"]), row("r", [])];
    expect(countUnpushed(rows, false)).toEqual({ count: 2, complete: true });
  });
  it("counts everything when no remote has the history", () => {
    const rows = [row("b", ["a"]), row("a", [])];
    expect(countUnpushed(rows, false)).toEqual({ count: 2, complete: true });
  });
  it("is incomplete when the log was capped before a remote commit", () => {
    expect(countUnpushed([row("b", ["a"]), row("a", ["z"])], true)).toEqual({ count: 2, complete: false });
  });
  it("is zero when the tip is on a remote", () => {
    expect(countUnpushed([row("a", [], true)], true)).toEqual({ count: 0, complete: true });
  });
  it("writes the count", () => {
    expect(commitsText({ count: 1, complete: true })).toBe("1 commit");
    expect(commitsText({ count: 3, complete: true })).toBe("3 commits");
    expect(commitsText({ count: 0, complete: true })).toBe("0 commits");
    expect(commitsText({ count: 300, complete: false })).toBe("300+ commits");
  });
});

describe("runUpstreamPushes", () => {
  it("runs at most the limit at once and keeps going after a failure", async () => {
    let active = 0;
    let peak = 0;
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const seen: string[] = [];
    const res = await runUpstreamPushes(
      ids,
      async (id) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (id === "c") throw { message: "fatal: auth failed\nmore", detail: "extra" };
        if (id === "e") return { ok: false, message: "rejected\nsecond" };
        return { ok: true, message: "" };
      },
      (id, s) => seen.push(`${id}:${s.kind}`),
      4,
    );
    expect(peak).toBe(4);
    expect(res.c).toEqual({ kind: "failed", message: "fatal: auth failed", full: "fatal: auth failed\nmore\nextra" });
    expect(res.e).toEqual({ kind: "failed", message: "rejected", full: "rejected\nsecond" });
    expect(ids.filter((i) => res[i].kind === "done")).toEqual(["a", "b", "d", "f", "g"]);
    expect(seen.slice(0, 7)).toEqual(ids.map((i) => `${i}:queued`));
    expect(seen.filter((s) => s.endsWith(":running"))).toHaveLength(7);
  });
  it("takes a non-object rejection", async () => {
    const res = await runUpstreamPushes(["a"], () => Promise.reject("boom"), () => undefined);
    expect(res.a).toEqual({ kind: "failed", message: "boom", full: "boom" });
  });
  it("handles an empty list", async () => {
    expect(await runUpstreamPushes([], () => Promise.reject(new Error("never")), () => undefined)).toEqual({});
  });
  it("takes the first line", () => {
    expect(firstLine("\n  \n hi \nthere")).toBe("hi");
  });
});

describe("summarizeRun", () => {
  const name = (id: string) => `repo-${id}`;
  const done: RowStatus = { kind: "done" };
  const bad: RowStatus = { kind: "failed", message: "x", full: "x" };
  it("reports success", () => {
    expect(summarizeRun("feat", "origin", { a: done, b: done }, name)).toEqual({ kind: "success", title: "Pushed feat to 2 repos", body: "Upstream set to origin/feat.", console: false });
    expect(summarizeRun("feat", "origin", { a: done }, name).title).toBe("Pushed feat to 1 repo");
  });
  it("reports the failed repos with the console action", () => {
    expect(summarizeRun("feat", "origin", { a: done, b: bad, c: bad }, name)).toEqual({ kind: "error", title: "Push failed in 2 of 3 repos", body: "repo-b, repo-c", console: true });
  });
});
