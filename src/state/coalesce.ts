/**
 * Coalescing of background refreshes by id, free of the app stores so it can be tested on its own.
 *
 * `add(id)` queues an id without running anything; `run(ids?)` queues the given ids and runs the queue now. Calls
 * that arrive while a run is going are merged into it: the loop keeps fetching until nothing is queued, and every
 * caller gets the promise of that run.
 */
export interface BatchRefresher {
  add(id: string): void;
  run(ids?: readonly string[]): Promise<void>;
}

export function createBatchRefresher(fetch: (ids: string[]) => Promise<void>, onRun?: () => void): BatchRefresher {
  const pending = new Set<string>();
  let inflight: Promise<void> | null = null;

  async function loop(): Promise<void> {
    while (pending.size > 0) {
      const ids = [...pending];
      pending.clear();
      onRun?.();
      await fetch(ids);
    }
  }

  return {
    add: (id) => void pending.add(id),
    run(ids = []) {
      for (const id of ids) pending.add(id);
      if (inflight) return inflight;
      // Nothing queued (another run drained it): do not store a promise that is already settled.
      if (pending.size === 0) return Promise.resolve();
      const p = loop().finally(() => {
        if (inflight === p) inflight = null;
      });
      inflight = p;
      return p;
    },
  };
}
