/**
 * Auto-fetch (DESIGN.md 11.4): every N minutes (`settings.autoFetchMinutes`, 0 = off) fetch the repos of the active
 * project in the background, with `--all` and `--prune` (`settings.autoFetchPrune`).
 *
 *   startAutoFetch();                 // once, from App
 *   autoFetchStatus().failing         // repos whose last auto-fetch failed (the status bar shows one quiet indicator)
 *
 * Rules (all in `autoFetchCore.ts`, which is pure and tested with fake timers):
 *  - one timer; a project switch or a settings change re-plans it, timers never stack;
 *  - a repo is due `interval` after its last fetch (any fetch counts: the fetch-age ring) or last failed attempt;
 *  - a repo with a write operation running (a fetch included) is skipped and tried again soon;
 *  - nothing runs while the window is hidden; on return, overdue repos are fetched at once;
 *  - no toast, no progress activity; the console marks these fetches as background commands;
 *  - no login dialog: the backend runs them with `AuthMode::Silent` (`background`), saved credentials only;
 *  - a repo that fails backs off on its own: its interval doubles up to 60 min and resets on its first success.
 */
import { createEffect, createRoot, createSignal, on, untrack } from "solid-js";
import * as actions from "./actions";
import { type AutoFetchStatus, createAutoFetch } from "./autoFetchCore";
import { markBackgroundFetch } from "./console";
import { lastFetchAt } from "./fetchAge";
import { isRepoBusy } from "./repoBusy";
import { settings } from "./settings";
import { activeProject, projectRepos, repoById } from "./workspace";

// ---------------------------------------------------------------- app wiring

const [autoFetchStatus, setAutoFetchStatus] = createSignal<AutoFetchStatus>({ failing: [], nextAt: null, running: false });

/** State of the auto-fetch for the status bar (reactive). */
export { autoFetchStatus };

/** One line for tooltips: "Auto-fetch every 15 min." / "Auto-fetch is off." / the failure. */
export function autoFetchLine(): string {
  const minutes = settings.autoFetchMinutes;
  if (minutes <= 0) return "Auto-fetch is off.";
  const failing = autoFetchStatus().failing;
  if (failing.length === 0) return `Auto-fetch every ${minutes} min.`;
  const first = failing[0];
  const name = repoById(first.repoId)?.name ?? first.repoId;
  return `Auto-fetch failed in ${failing.length === 1 ? name : `${failing.length} repositories`}: ${first.message}`;
}

let started = false;

/** Starts the scheduler: follows the settings, the active project and the window visibility. Safe to call twice. */
export function startAutoFetch(): void {
  if (started) return;
  started = true;
  const sched = createAutoFetch({
    now: () => Date.now(),
    minutes: () => settings.autoFetchMinutes,
    prune: () => settings.autoFetchPrune,
    visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    repoIds: () => untrack(() => projectRepos().map((r) => r.id)),
    isBusy: isRepoBusy,
    lastFetchAt: (id) => untrack(() => lastFetchAt(id)),
    fetch: async (ids, prune) => {
      const release = markBackgroundFetch(ids);
      try {
        const r = await actions.fetch(ids, { prune, silent: true, background: true });
        return { ok: r.ok, failed: r.failed.map((f) => ({ repoId: f.repoId, message: f.error.message })) };
      } finally {
        release();
      }
    },
    onStatus: setAutoFetchStatus,
  });
  createRoot(() => {
    // a new project, a changed interval or a changed repo list plans the timer again
    createEffect(on([() => activeProject()?.id, () => settings.autoFetchMinutes, () => projectRepos().length], () => sched.reschedule()));
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") sched.onVisible();
    });
  }
}
