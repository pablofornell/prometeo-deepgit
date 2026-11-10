/**
 * Per-repo `Refs` cache (branches, remote branches, tags, stashes, remotes, submodules).
 *
 *   const r = repoRefs(repoId);           // reactive; undefined until loaded (loading starts on first read)
 *   <For each={r()?.local}>…</For>
 *   await refreshRefs(repoId);            // force reload
 *
 * Cached entries are reloaded automatically (debounced) when the repo changes. `refsVersion(repoId)` is a
 * reactive counter that increases after each load.
 */
import { batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import * as api from "../api/tauri";
import type { Refs } from "../api/types";
import { subscribeRepoChanged } from "./events";

const [cache, setCache] = createStore<Record<string, Refs>>({});
/** Bumped after every successful load: nested store changes do not re-run readers of `cache[id]` itself. */
const [versions, setVersions] = createStore<Record<string, number>>({});
/** The load (plus its queued re-run) in progress per repo. */
const inflight = new Map<string, Promise<Refs | undefined>>();
/** Repos that asked for a refresh while a load was running: they get exactly one more run. */
const queued = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

async function loadLoop(repoId: string): Promise<Refs | undefined> {
  let latest = cache[repoId];
  do {
    queued.delete(repoId);
    try {
      const r = await api.refs(repoId);
      batch(() => {
        setCache(repoId, reconcile(r));
        setVersions(repoId, (v) => (v ?? 0) + 1);
      });
      latest = cache[repoId];
    } catch {
      /* a failed refresh keeps the old value */
    }
  } while (queued.has(repoId));
  return latest;
}

/**
 * Loads (or reloads) the refs of one repo. A call that arrives while a load is running queues exactly one more
 * run (its data may predate the change that triggered the call) and resolves after it, with fresh data.
 * Errors are swallowed; the old value stays.
 */
export function refreshRefs(repoId: string): Promise<Refs | undefined> {
  const running = inflight.get(repoId);
  if (running) {
    queued.add(repoId);
    return running;
  }
  const p = loadLoop(repoId).finally(() => {
    if (inflight.get(repoId) === p) inflight.delete(repoId);
  });
  inflight.set(repoId, p);
  return p;
}

/** Loads the refs of every listed repo that is not cached yet; waits for loads already running. */
export async function ensureRefs(repoIds: string[]): Promise<void> {
  await Promise.all(
    repoIds.map((id) => inflight.get(id) ?? (cache[id] ? undefined : refreshRefs(id))),
  );
}

/** Reactive counter of the loads of a repo's refs; read it in an effect to re-run when fresh refs arrive. */
export function refsVersion(repoId: string): number {
  return versions[repoId] ?? 0;
}

/**
 * Reactive accessor for the refs of a repo. The first read triggers a load.
 * Returns an accessor so it composes with `createMemo`.
 */
export function repoRefs(repoId: string): () => Refs | undefined {
  return () => {
    const r = cache[repoId];
    if (!r && !inflight.has(repoId)) void refreshRefs(repoId);
    return r;
  };
}

/** Non-reactive snapshot of the cache (for actions). */
export function cachedRefs(repoId: string): Refs | undefined {
  return cache[repoId];
}

/** True when the repo has this local branch. */
export function hasLocalBranch(repoId: string, name: string): boolean {
  return cache[repoId]?.local.some((b) => b.name === name) ?? false;
}

/** True when the repo has `origin/<name>`-style remote branch with this short name. */
export function hasRemoteBranch(repoId: string, name: string): boolean {
  return cache[repoId]?.remote.some((b) => b.name === name || b.fullName === name) ?? false;
}

subscribeRepoChanged((repoId) => {
  if (!cache[repoId]) return;
  const t = timers.get(repoId);
  if (t) clearTimeout(t);
  timers.set(
    repoId,
    setTimeout(() => {
      timers.delete(repoId);
      void refreshRefs(repoId);
    }, 150),
  );
});
