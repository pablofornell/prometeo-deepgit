/**
 * The scheduling rules of the auto-fetch (see `autoFetch.ts` for the list), free of the app stores so they can be
 * tested with fake timers: `createAutoFetch(deps)` gets everything it needs from `deps`.
 */

const MIN = 60_000;
/** Wait after start, a project switch or a settings change before the first fetch (the UI settles first). */
export const START_DELAY_MS = 5_000;
/** Wait before fetching what became overdue while the window was hidden. */
export const RETURN_DELAY_MS = 1_000;
/** Shortest gap between two timer runs. */
const MIN_GAP_MS = 1_000;
/** A repo that was busy is looked at again after this long. */
export const BUSY_RETRY_MS = 30_000;
/** The doubling stops at this interval (or at the chosen interval when that is longer). */
export const MAX_BACKOFF_MIN = 60;

export interface AutoFetchResult {
  ok: string[];
  failed: { repoId: string; message: string }[];
}

export interface AutoFetchStatus {
  /** Repos of the active project whose last auto-fetch failed, with the reason. Repos of other projects are not listed. */
  failing: { repoId: string; message: string; failures: number }[];
  /** The repos of the active project: a repo in here that is not in `failing` has no failure now. */
  checked: string[];
  /** Unix ms of the next planned run, or null (off, hidden, nothing to do). */
  nextAt: number | null;
  /** A fetch is running now. */
  running: boolean;
}

export interface AutoFetchDeps {
  now(): number;
  /** The chosen interval in minutes; 0 or less = off. */
  minutes(): number;
  prune(): boolean;
  /** False while the window is hidden or minimised. */
  visible(): boolean;
  /** Repos of the active project. */
  repoIds(): string[];
  isBusy(repoId: string): boolean;
  /** Unix ms of the last successful fetch seen for the repo (any source), or null. */
  lastFetchAt(repoId: string): number | null;
  /** Fetches these repos in the background. Must not reject. */
  fetch(repoIds: string[], prune: boolean): Promise<AutoFetchResult>;
  onStatus?(status: AutoFetchStatus): void;
}

export interface AutoFetch {
  /** Plans the timer again (project switch, settings change, start). `delay` is the wait before an overdue first run. */
  reschedule(delay?: number): void;
  /** The window became visible: fetch what is overdue. */
  onVisible(): void;
  /** Stops the timer. */
  stop(): void;
  status(): AutoFetchStatus;
}

interface RepoState {
  /** Unix ms of the last attempt that this scheduler made. */
  lastAttempt: number;
  failures: number;
  message: string;
  /** Not before this time (busy retry). */
  deferUntil: number;
}

/** The wait between fetches of a repo that has failed `failures` times in a row. */
export function effectiveIntervalMs(minutes: number, failures: number): number {
  const cap = Math.max(minutes, MAX_BACKOFF_MIN);
  return Math.min(minutes * 2 ** failures, cap) * MIN;
}

export function createAutoFetch(deps: AutoFetchDeps): AutoFetch {
  const states = new Map<string, RepoState>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let nextAt: number | null = null;
  /** The generation of the plan: a timer from an older plan does nothing. */
  let plan = 0;

  const status = (): AutoFetchStatus => {
    const checked = deps.repoIds();
    const inProject = new Set(checked);
    return {
      failing: [...states.entries()]
        .filter(([repoId, s]) => s.failures > 0 && inProject.has(repoId))
        .map(([repoId, s]) => ({ repoId, message: s.message, failures: s.failures })),
      checked: [...checked],
      nextAt,
      running,
    };
  };
  const publish = () => deps.onStatus?.(status());

  const dueAt = (repoId: string): number => {
    const s = states.get(repoId);
    const last = Math.max(deps.lastFetchAt(repoId) ?? 0, s?.lastAttempt ?? 0);
    return Math.max(last + effectiveIntervalMs(deps.minutes(), s?.failures ?? 0), s?.deferUntil ?? 0);
  };

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    nextAt = null;
  };

  const arm = (minDelay: number) => {
    clear();
    const myPlan = ++plan;
    if (deps.minutes() <= 0 || !deps.visible() || running) return publish();
    const ids = deps.repoIds();
    if (ids.length === 0) return publish();
    const now = deps.now();
    const soonest = Math.min(...ids.map(dueAt));
    const delay = Math.max(soonest - now, minDelay);
    nextAt = now + delay;
    timer = setTimeout(() => void tick(myPlan), delay);
    publish();
  };

  const tick = async (myPlan: number) => {
    if (myPlan !== plan) return;
    timer = undefined;
    nextAt = null;
    if (deps.minutes() <= 0 || !deps.visible() || running) return arm(MIN_GAP_MS);
    const now = deps.now();
    const due = deps.repoIds().filter((id) => dueAt(id) <= now);
    const runnable: string[] = [];
    for (const id of due) {
      if (deps.isBusy(id)) {
        const s = states.get(id) ?? { lastAttempt: 0, failures: 0, message: "", deferUntil: 0 };
        s.deferUntil = now + BUSY_RETRY_MS;
        states.set(id, s);
      } else runnable.push(id);
    }
    if (runnable.length === 0) return arm(MIN_GAP_MS);
    running = true;
    publish();
    let result: AutoFetchResult;
    try {
      result = await deps.fetch(runnable, deps.prune());
    } catch (e) {
      result = { ok: [], failed: runnable.map((repoId) => ({ repoId, message: e instanceof Error ? e.message : String(e) })) };
    }
    running = false;
    const done = deps.now();
    for (const id of runnable) {
      const failure = result.failed.find((f) => f.repoId === id);
      const s = states.get(id) ?? { lastAttempt: 0, failures: 0, message: "", deferUntil: 0 };
      s.lastAttempt = done;
      s.deferUntil = 0;
      s.failures = failure ? s.failures + 1 : 0;
      s.message = failure?.message ?? "";
      states.set(id, s);
    }
    arm(MIN_GAP_MS);
  };

  return {
    reschedule: (delay = START_DELAY_MS) => arm(delay),
    onVisible: () => arm(RETURN_DELAY_MS),
    stop: () => {
      clear();
      plan++;
      publish();
    },
    status,
  };
}
