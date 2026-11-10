/**
 * Fetch age (DESIGN.md 11.4): when each repo was last fetched, and the project-level state shown by the title bar
 * fetch ring and the status bar age dot.
 *
 * The backend has no "FETCH_HEAD mtime" call yet, so the time of the last successful `git fetch` seen in the
 * console stream is stored per repo in localStorage (`deepgit.ui.fetchedAt`).
 *
 *   const a = fetchAge();   // reactive: { fraction, level, text, tooltip }
 *   <span style={{ "--age": a().fraction }} />
 */
import { createEffect, createMemo, createRoot, createSignal, untrack } from "solid-js";
import { consoleEntries } from "./console";
import { loadPersisted, savePersisted } from "./persist";
import { projectRepos, repoById } from "./workspace";

export type FetchLevel = "fresh" | "aging" | "stale";

export interface FetchAgeInfo {
  /** 0..1 of the 2 hour scale (1 = 2 h or never). */
  fraction: number;
  level: FetchLevel;
  /** "Fetched 4 min ago", "Not fetched yet". */
  text: string;
  /** "Last fetch 4 min ago. Oldest: docs-site, 4 min ago." */
  tooltip: string;
}

const FRESH_MIN = 15;
const SCALE_MIN = 120;

/** Ring fill: `min(ageMinutes / 120, 1)`; never fetched (null) is full. */
export function ageFraction(ageMinutes: number | null): number {
  return ageMinutes === null ? 1 : Math.min(Math.max(ageMinutes, 0) / SCALE_MIN, 1);
}

/** fresh under 15 min, aging up to 2 h, stale above or never. */
export function ageLevel(ageMinutes: number | null): FetchLevel {
  if (ageMinutes === null || ageMinutes > SCALE_MIN) return "stale";
  return ageMinutes < FRESH_MIN ? "fresh" : "aging";
}

/** "now", "4 min ago", "3 h ago", "2 d ago". */
export function formatAge(ageMinutes: number): string {
  if (ageMinutes < 1) return "just now";
  if (ageMinutes < 60) return `${Math.round(ageMinutes)} min ago`;
  const h = ageMinutes / 60;
  if (h < 24) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Project-level state from the per-repo fetch times (null = never fetched). */
export function describeFetchAge(times: { name: string; at: number | null }[], now: number): FetchAgeInfo {
  if (times.length === 0) return { fraction: 1, level: "stale", text: "Not fetched yet", tooltip: "No repositories." };
  const oldest = times.reduce((a, b) => ((a.at ?? -Infinity) <= (b.at ?? -Infinity) ? a : b));
  const newest = times.reduce((a, b) => ((a.at ?? -Infinity) >= (b.at ?? -Infinity) ? a : b));
  const age = (at: number | null) => (at === null ? null : Math.max(0, (now - at) / 60000));
  const oldestAge = age(oldest.at);
  const newestAge = age(newest.at);
  const text = oldestAge === null ? "Not fetched yet" : `Fetched ${formatAge(oldestAge)}`;
  const last = newestAge === null ? "never" : formatAge(newestAge);
  const old = oldestAge === null ? "never" : formatAge(oldestAge);
  return {
    fraction: ageFraction(oldestAge),
    level: ageLevel(oldestAge),
    text,
    tooltip: times.length > 1 ? `Last fetch ${last}. Oldest: ${oldest.name}, ${old}.` : `Last fetch ${last}.`,
  };
}

const KEY = "fetchedAt";
const [fetched, setFetched] = createSignal<Record<string, number>>(loadPersisted<Record<string, number>>(KEY, {}));
const [now, setNow] = createSignal(Date.now());

/** Records a successful fetch of these repos (called by the console stream below; also usable directly). */
export function markFetched(repoIds: string[], at: number = Date.now()): void {
  if (repoIds.length === 0) return;
  const next = { ...fetched() };
  for (const id of repoIds) next[id] = at;
  setFetched(next);
  savePersisted(KEY, next);
  setNow(Date.now());
}

/** Unix ms of the last fetch of a repo, or null. Reactive. */
export function lastFetchAt(repoId: string): number | null {
  return fetched()[repoId] ?? null;
}

/** Fetch age of the active project. Reactive; re-evaluated every 30 s. */
export const fetchAge = createRoot(() => {
  setInterval(() => setNow(Date.now()), 30_000);

  // `git fetch` entries of the console stream that exited 0 count as a fetch of that repo.
  let lastSeen = 0;
  createEffect(() => {
    const entries = consoleEntries();
    const done: Record<string, number> = {};
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.id <= lastSeen) break;
      if (e.repoId && e.args[0] === "fetch" && e.exitCode === 0 && repoById(e.repoId)) done[e.repoId] = Math.max(done[e.repoId] ?? 0, e.startedAt + e.durationMs);
    }
    const last = entries[entries.length - 1];
    if (last) lastSeen = Math.max(lastSeen, last.id);
    untrack(() => {
      for (const [id, at] of Object.entries(done)) markFetched([id], at);
    });
  });

  return createMemo<FetchAgeInfo>(() => {
    const times = projectRepos().map((r) => ({ name: r.name, at: fetched()[r.id] ?? null }));
    return describeFetchAge(times, now());
  });
});
