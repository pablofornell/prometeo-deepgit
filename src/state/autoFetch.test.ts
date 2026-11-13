// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_RETRY_MS, RETURN_DELAY_MS, START_DELAY_MS, createAutoFetch, effectiveIntervalMs, type AutoFetchResult } from "./autoFetchCore";

const MIN = 60_000;

/** A scheduler on fake timers with settable inputs and a recording fetch. */
function harness(opts: { minutes?: number; repos?: string[] } = {}) {
  const h = {
    minutes: opts.minutes ?? 15,
    prune: true,
    visible: true,
    repos: opts.repos ?? ["a", "b"],
    busy: new Set<string>(),
    last: new Map<string, number>(),
    calls: [] as { ids: string[]; prune: boolean }[],
    /** What the next fetch does; default: everything ok. */
    outcome: (ids: string[]): AutoFetchResult => ({ ok: ids, failed: [] }),
    gate: null as null | Promise<void>,
  };
  const sched = createAutoFetch({
    now: () => Date.now(),
    minutes: () => h.minutes,
    prune: () => h.prune,
    visible: () => h.visible,
    repoIds: () => h.repos,
    isBusy: (id) => h.busy.has(id),
    lastFetchAt: (id) => h.last.get(id) ?? null,
    fetch: async (ids, prune) => {
      h.calls.push({ ids: [...ids], prune });
      if (h.gate) await h.gate;
      return h.outcome(ids);
    },
  });
  return { h, sched };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("auto-fetch scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("does nothing when it is off", async () => {
    const { h, sched } = harness({ minutes: 0 });
    sched.reschedule();
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * 60 * MIN);
    expect(h.calls).toHaveLength(0);
  });

  it("fetches never-fetched repos after the start delay, then every interval, with the prune setting", async () => {
    const { h, sched } = harness();
    sched.reschedule();
    await advance(START_DELAY_MS - 1);
    expect(h.calls).toHaveLength(0);
    await advance(1);
    expect(h.calls).toEqual([{ ids: ["a", "b"], prune: true }]);
    await advance(15 * MIN - 1000);
    expect(h.calls).toHaveLength(1);
    h.prune = false;
    await advance(1000 + 10);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].prune).toBe(false);
    await advance(15 * MIN);
    expect(h.calls).toHaveLength(3);
    sched.stop();
  });

  it("counts a fetch of the user (the fetch-age ring) and waits a full interval after it", async () => {
    const { h, sched } = harness();
    h.last.set("a", Date.now() - 5 * MIN);
    h.last.set("b", Date.now() - 5 * MIN);
    sched.reschedule();
    await advance(10 * MIN - 1000);
    expect(h.calls).toHaveLength(0);
    await advance(2000);
    expect(h.calls).toHaveLength(1);
    sched.stop();
  });

  it("fetches only the repos that are due", async () => {
    const { h, sched } = harness();
    h.last.set("a", Date.now() - 1 * MIN);
    sched.reschedule();
    await advance(START_DELAY_MS);
    expect(h.calls).toEqual([{ ids: ["b"], prune: true }]);
    sched.stop();
  });

  it("never stacks timers when it is planned again", async () => {
    const { h, sched } = harness();
    for (let i = 0; i < 6; i++) sched.reschedule();
    expect(vi.getTimerCount()).toBe(1);
    await advance(START_DELAY_MS);
    expect(h.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    // a project switch re-plans and the new repos are fetched once
    h.repos = ["c"];
    sched.reschedule();
    expect(vi.getTimerCount()).toBe(1);
    await advance(START_DELAY_MS);
    expect(h.calls.map((c) => c.ids)).toEqual([["a", "b"], ["c"]]);
    sched.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips a repo that is busy and tries it again soon", async () => {
    const { h, sched } = harness();
    h.busy.add("a");
    sched.reschedule();
    await advance(START_DELAY_MS);
    expect(h.calls).toEqual([{ ids: ["b"], prune: true }]);
    await advance(BUSY_RETRY_MS - 2000);
    expect(h.calls).toHaveLength(1);
    h.busy.clear();
    await advance(BUSY_RETRY_MS);
    expect(h.calls).toEqual([
      { ids: ["b"], prune: true },
      { ids: ["a"], prune: true },
    ]);
    sched.stop();
  });

  it("starts no second fetch while one is still running", async () => {
    const { h, sched } = harness();
    let release: () => void = () => undefined;
    h.gate = new Promise<void>((r) => (release = r));
    sched.reschedule();
    await advance(START_DELAY_MS);
    expect(h.calls).toHaveLength(1);
    expect(sched.status().running).toBe(true);
    sched.reschedule(); // a settings change in the middle of the fetch
    await advance(30 * MIN);
    expect(h.calls).toHaveLength(1);
    release();
    await advance(0);
    expect(sched.status().running).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    sched.stop();
  });

  it("waits while the window is hidden and catches up when it is shown again", async () => {
    const { h, sched } = harness();
    sched.reschedule();
    await advance(START_DELAY_MS);
    expect(h.calls).toHaveLength(1);
    h.visible = false;
    await advance(15 * MIN + 1000); // the timer fires hidden: nothing runs, nothing is planned
    expect(h.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await advance(40 * MIN);
    expect(h.calls).toHaveLength(1);
    h.visible = true;
    sched.onVisible();
    await advance(RETURN_DELAY_MS);
    expect(h.calls).toHaveLength(2);
    sched.stop();
  });

  it("does not fetch on return when nothing is overdue", async () => {
    const { h, sched } = harness();
    sched.reschedule();
    await advance(START_DELAY_MS);
    h.visible = false;
    await advance(2 * MIN);
    h.visible = true;
    sched.onVisible();
    await advance(RETURN_DELAY_MS + 1000);
    expect(h.calls).toHaveLength(1);
    // the regular run still comes, 15 min after the first
    await advance(15 * MIN);
    expect(h.calls).toHaveLength(2);
    sched.stop();
  });

  it("backs off a failing repo on its own, up to 60 minutes, and resets on success", async () => {
    expect(effectiveIntervalMs(5, 0) / MIN).toBe(5);
    expect(effectiveIntervalMs(5, 1) / MIN).toBe(10);
    expect(effectiveIntervalMs(5, 3) / MIN).toBe(40);
    expect(effectiveIntervalMs(5, 4) / MIN).toBe(60);
    expect(effectiveIntervalMs(5, 9) / MIN).toBe(60);
    expect(effectiveIntervalMs(60, 3) / MIN).toBe(60);

    const { h, sched } = harness({ minutes: 5 });
    h.outcome = (ids) => ({ ok: ids.filter((i) => i !== "a"), failed: ids.includes("a") ? [{ repoId: "a", message: "Could not resolve the host." }] : [] });
    sched.reschedule();
    await advance(START_DELAY_MS);
    expect(h.calls).toEqual([{ ids: ["a", "b"], prune: true }]);
    expect(sched.status().failing).toEqual([{ repoId: "a", message: "Could not resolve the host.", failures: 1 }]);

    // b is fetched again after 5 min, a only after 10 min
    await advance(5 * MIN);
    expect(h.calls.at(-1)).toEqual({ ids: ["b"], prune: true });
    await advance(5 * MIN);
    expect(h.calls.at(-1)?.ids).toContain("a");
    expect(sched.status().failing[0].failures).toBe(2);

    // the third wait is 20 min
    const n = h.calls.length;
    await advance(15 * MIN);
    expect(h.calls.slice(n).every((c) => !c.ids.includes("a"))).toBe(true);
    h.outcome = (ids) => ({ ok: ids, failed: [] });
    await advance(5 * MIN + 2000);
    expect(h.calls.at(-1)?.ids).toContain("a");
    expect(sched.status().failing).toEqual([]);
    // reset: the next wait is 5 min again
    const m = h.calls.length;
    await advance(5 * MIN + 2000);
    expect(h.calls.length).toBeGreaterThan(m);
    sched.stop();
  });

  it("treats a rejected fetch as a failure of every repo it ran for", async () => {
    const { h, sched } = harness();
    h.outcome = () => {
      throw new Error("boom");
    };
    sched.reschedule();
    await advance(START_DELAY_MS);
    expect(sched.status().failing.map((f) => [f.repoId, f.message])).toEqual([
      ["a", "boom"],
      ["b", "boom"],
    ]);
    sched.stop();
  });

  it("lists only the failures of the active project's repos, and brings the others back on return", async () => {
    const { h, sched } = harness({ repos: ["a", "b"] });
    h.outcome = (ids) => ({ ok: [], failed: ids.map((repoId) => ({ repoId, message: "auth" })) });
    sched.reschedule();
    await advance(START_DELAY_MS);
    expect(sched.status().failing.map((f) => f.repoId)).toEqual(["a", "b"]);
    expect(sched.status().checked).toEqual(["a", "b"]);
    h.repos = ["x"]; // another project
    expect(sched.status().failing).toEqual([]);
    expect(sched.status().checked).toEqual(["x"]);
    h.repos = ["b", "c"];
    expect(sched.status().failing.map((f) => f.repoId)).toEqual(["b"]);
    sched.stop();
  });

  it("reports the next run", async () => {
    const { sched } = harness();
    const seen: (number | null)[] = [];
    sched.reschedule();
    seen.push(sched.status().nextAt);
    expect(seen[0]).toBe(Date.now() + START_DELAY_MS);
    sched.stop();
    expect(sched.status().nextAt).toBeNull();
  });
});
