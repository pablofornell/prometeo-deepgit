// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createBatchRefresher } from "./coalesce";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createBatchRefresher", () => {
  it("does not stall after a call with nothing queued", async () => {
    const fetched: string[][] = [];
    const r = createBatchRefresher(async (ids) => void fetched.push(ids));
    await r.run([]); // e.g. the throttle timer fires after another run drained the queue
    expect(fetched).toEqual([]);
    await r.run(["a"]);
    expect(fetched).toEqual([["a"]]);
    await r.run(["b"]);
    expect(fetched).toEqual([["a"], ["b"]]);
  });

  it("merges calls made during a run into one more run", async () => {
    const fetched: string[][] = [];
    const gates: (() => void)[] = [];
    const r = createBatchRefresher(
      (ids) =>
        new Promise<void>((resolve) => {
          fetched.push(ids);
          gates.push(resolve);
        }),
    );
    const first = r.run(["a"]);
    await tick();
    const second = r.run(["b"]);
    const third = r.run(["c", "b"]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(fetched).toEqual([["a"]]);
    gates[0]();
    await tick();
    expect(fetched).toEqual([["a"], ["b", "c"]]);
    gates[1]();
    await first;
    // and it still works afterwards
    const next = r.run(["d"]);
    await tick();
    expect(fetched).toHaveLength(3);
    gates[2]();
    await next;
  });

  it("runs ids queued with add() on the next run and reports each run", async () => {
    const fetched: string[][] = [];
    let runs = 0;
    const r = createBatchRefresher(
      async (ids) => void fetched.push(ids),
      () => runs++,
    );
    r.add("a");
    await r.run([]);
    expect(fetched).toEqual([["a"]]);
    expect(runs).toBe(1);
  });

  it("recovers when a fetch throws", async () => {
    let fail = true;
    const fetched: string[][] = [];
    const r = createBatchRefresher(async (ids) => {
      fetched.push(ids);
      if (fail) throw new Error("boom");
    });
    await expect(r.run(["a"])).rejects.toThrow("boom");
    fail = false;
    await r.run(["b"]);
    expect(fetched).toEqual([["a"], ["b"]]);
  });
});

describe("createBatchRefresher: late callers", () => {
  it("fetches an id that arrives one microtask after the last fetch", async () => {
    const calls: string[][] = [];
    const r = createBatchRefresher(async (ids) => {
      calls.push(ids);
    });
    const first = r.run(["a"]);
    let late: Promise<void> | undefined;
    // Schedule calls at several microtask depths after the start.
    for (let hops = 0; hops < 6; hops++) {
      let q: Promise<unknown> = Promise.resolve();
      for (let i = 0; i < hops; i++) q = q.then(() => undefined);
      void q.then(() => {
        late = r.run([`b${hops}`]);
      });
    }
    await first;
    await new Promise((res) => setTimeout(res, 0));
    await late;
    const fetched = calls.flat();
    for (let hops = 0; hops < 6; hops++) expect(fetched).toContain(`b${hops}`);
  });
});
