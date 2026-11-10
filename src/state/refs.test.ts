// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Refs } from "../api/types";

const calls: { id: string; resolve: (r: Refs) => void; reject: (e: unknown) => void }[] = [];
vi.mock("../api/tauri", () => ({
  refs: (id: string) => new Promise<Refs>((resolve, reject) => calls.push({ id, resolve, reject })),
  onGitConsole: async () => () => {},
  onRepoChanged: async () => () => {},
}));

const refsOf = (tag: string): Refs => ({
  local: [{ name: tag, oid: "a".repeat(40), upstream: null, ahead: 0, behind: 0, isHead: false, gone: false }],
  remote: [], tags: [], stashes: [], remotes: [], submodules: [],
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("refs cache", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.resetModules();
  });

  it("shares one in-flight load per repo", async () => {
    const m = await import("./refs");
    const a = m.refreshRefs("r1");
    expect(calls).toHaveLength(1);
    calls[0].resolve(refsOf("v1"));
    expect((await a)?.local[0].name).toBe("v1");
    expect(m.cachedRefs("r1")?.local[0].name).toBe("v1");
    expect(m.refsVersion("r1")).toBe(1);
  });

  it("queues exactly one more run for refreshes requested during a load, and resolves with fresh data", async () => {
    const m = await import("./refs");
    const first = m.refreshRefs("r1");
    const second = m.refreshRefs("r1");
    const third = m.refreshRefs("r1");
    expect(calls).toHaveLength(1);
    calls[0].resolve(refsOf("stale"));
    await tick();
    expect(calls).toHaveLength(2); // exactly one extra run, not two
    calls[1].resolve(refsOf("fresh"));
    for (const p of [first, second, third]) expect((await p)?.local[0].name).toBe("fresh");
    await tick();
    expect(calls).toHaveLength(2);
    expect(m.refsVersion("r1")).toBe(2);
    // idle again: the next refresh starts a new load
    void m.refreshRefs("r1");
    expect(calls).toHaveLength(3);
  });

  it("ensureRefs waits for the load in flight and keeps old data when a run fails", async () => {
    const m = await import("./refs");
    const load = m.refreshRefs("r1");
    let done = false;
    const ensured = m.ensureRefs(["r1"]).then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    calls[0].resolve(refsOf("v1"));
    await ensured;
    await load;
    expect(done).toBe(true);
    expect(m.cachedRefs("r1")?.local[0].name).toBe("v1");

    const again = m.refreshRefs("r1");
    calls[1].reject(new Error("boom"));
    expect((await again)?.local[0].name).toBe("v1");
    expect(m.refsVersion("r1")).toBe(1);
  });

  it("ensureRefs loads uncached repos and skips cached idle ones", async () => {
    const m = await import("./refs");
    const p = m.ensureRefs(["a", "b"]);
    expect(calls.map((c) => c.id)).toEqual(["a", "b"]);
    calls.forEach((c) => c.resolve(refsOf(c.id)));
    await p;
    await m.ensureRefs(["a", "b"]);
    expect(calls).toHaveLength(2);
  });
});
