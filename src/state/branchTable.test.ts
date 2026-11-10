// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Refs } from "../api/types";
import { buildBranchTable } from "./branchTable";

const b = (name: string, isHead = false, ahead = 0) => ({ name, oid: "a".repeat(40), upstream: null, ahead, behind: 0, isHead, gone: false });
const r = (name: string) => ({ remote: "origin", name, fullName: `origin/${name}`, oid: "a".repeat(40) });
const refs = (local: Refs["local"], remote: Refs["remote"] = []): Refs => ({ local, remote, tags: [], stashes: [], remotes: [], submodules: [] });

describe("buildBranchTable", () => {
  const data: Record<string, Refs> = {
    a: refs([b("main"), b("feature/x", true, 3)], [r("main"), r("feature/x")]),
    b: refs([b("main", true)], [r("main"), r("feature/x"), r("HEAD")]),
    c: refs([b("main", true)]),
  };
  const table = buildBranchTable(["a", "b", "c"], (id) => data[id]);

  it("makes one column per name, widest first", () => {
    expect(table.map((c) => c.name)).toEqual(["main", "feature/x"]);
  });
  it("classifies every cell", () => {
    const main = table[0];
    expect(main.cells.a.state).toBe("local");
    expect(main.cells.b.state).toBe("current");
    expect([main.current, main.local, main.remoteOnly, main.missing, main.present]).toEqual([2, 1, 0, 0, 3]);
    const x = table[1];
    expect([x.cells.a.state, x.cells.b.state, x.cells.c.state]).toEqual(["current", "remote", "missing"]);
    expect(x.cells.a.ahead).toBe(3);
    expect([x.current, x.local, x.remoteOnly, x.missing]).toEqual([1, 0, 1, 1]);
  });
  it("ignores origin/HEAD and repos without refs", () => {
    const t = buildBranchTable(["a", "z"], (id) => data[id]);
    expect(t.some((c) => c.name === "HEAD")).toBe(false);
    expect(t[0].cells.z.state).toBe("missing");
  });
});
