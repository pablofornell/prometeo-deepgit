/**
 * Status bar alerts (docs/design/ITERATION-3.md section 6). The rules are in `alertsCore.ts` (pure, tested); this file
 * keeps the lists in a signal and in localStorage (`deepgit.alerts.<projectId>`).
 *
 *   startAlerts();                    // once (the status bar does it)
 *   alerts()                          // alerts of the active project, newest first (reactive)
 *   raiseAlert({ severity: "error", text: "Push rejected.", repoId });   // the project of the repo
 *   dismiss(id); dismissAll(); dismissAutoFetchFor(repoIds);
 *   removeExpiredAlerts();
 *
 * Every warning and error `toast` becomes an alert: the status bar passes `raiseAlert` to `setToastAlertSink` (this file does not import
 * the toast component, so the workspace store can import it in tests without a DOM). The auto-fetch failures are raised
 * from `autoFetch.ts`. An alert goes to the project that started the action (`projectId`, or the project of `repoId`
 * or `repoName`), and only without those to the active project. An alert is removed after `settings.alertExpiryHours`: at start, every 60 s, and when the
 * popover opens.
 */
import { createEffect, createRoot, createSignal, on } from "solid-js";
import {
  type Alert, type AlertInput, type AlertStorage, type AlertTarget, addAlert, dismissAlert, dismissAutoFetchAlerts, expireAlerts, loadAlerts,
  projectsOfRepos, resolveAlertTarget, saveAlerts,
} from "./alertsCore";
import { settings } from "./settings";
import { activeProject, workspace } from "./workspace";

const EXPIRE_EVERY_MS = 60_000;

const storage: AlertStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
};

/** The lists of the projects seen in this session. A project that is not here is read from storage first. */
const [lists, setLists] = createSignal<Readonly<Record<string, readonly Alert[]>>>({});

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The list of a project; loads it (and drops what expired) the first time. Not reactive: for writes. */
function listOf(projectId: string): readonly Alert[] {
  const known = lists()[projectId];
  if (known) return known;
  const loaded = expireAlerts(loadAlerts(storage, projectId), Date.now(), settings.alertExpiryHours) as Alert[];
  setLists((m) => ({ ...m, [projectId]: loaded }));
  saveAlerts(storage, projectId, loaded);
  return loaded;
}

function store(projectId: string, list: readonly Alert[]): void {
  setLists((m) => ({ ...m, [projectId]: list }));
  saveAlerts(storage, projectId, list);
}

/** Alerts of the active project, newest first (reactive). */
export function alerts(): readonly Alert[] {
  const id = activeProject()?.id;
  return id ? (lists()[id] ?? []) : [];
}

/** Adds an alert to the project of `a` (see the header). Does nothing when there is no project. */
export function raiseAlert(a: Omit<AlertInput, "projectId"> & AlertTarget): void {
  const to = resolveAlertTarget(workspace.projects, a, activeProject()?.id);
  if (!to) return;
  const { projectId: _p, ...rest } = a;
  store(to.projectId, addAlert(listOf(to.projectId), { ...rest, projectId: to.projectId, repoId: to.repoId, repoName: to.repoName }, Date.now(), newId));
}

export function dismiss(id: string): void {
  const projectId = activeProject()?.id;
  if (projectId) store(projectId, dismissAlert(listOf(projectId), id));
}

export function dismissAll(): void {
  const projectId = activeProject()?.id;
  if (projectId) store(projectId, []);
}

/**
 * Removes the auto-fetch alerts of repos that fetched well, in whichever project they are. Called after every successful
 * fetch and pull (`actions.ts`), so an alert from an earlier session goes away too, not only one seen in this session.
 */
export function dismissAutoFetchFor(repoIds: readonly string[]): void {
  if (repoIds.length === 0) return;
  for (const projectId of projectsOfRepos(workspace.projects, repoIds)) listOf(projectId); // read the saved alerts of those projects
  for (const [projectId, list] of Object.entries(lists())) {
    const kept = dismissAutoFetchAlerts(list, repoIds);
    if (kept !== list) store(projectId, kept);
  }
}

/** Forgets every alert of a project (the project was removed). */
export function clearProjectAlerts(projectId: string): void {
  setLists((m) => {
    const { [projectId]: _gone, ...rest } = m;
    return rest;
  });
  saveAlerts(storage, projectId, []);
}

/** Removes the alerts older than `settings.alertExpiryHours` from every project of this session. */
export function removeExpiredAlerts(): void {
  const now = Date.now();
  const hours = settings.alertExpiryHours;
  const current = lists();
  for (const [projectId, list] of Object.entries(current)) {
    const kept = expireAlerts(list, now, hours);
    if (kept !== list) store(projectId, kept);
  }
}

let started = false;

/** Loads the alerts of the active project and starts the 60 s expiry sweep. Safe to call twice. */
export function startAlerts(): void {
  if (started) return;
  started = true;
  createRoot(() => {
    // load the list of a project when it becomes active, and sweep when the project or the expiry changes
    createEffect(
      on([() => activeProject()?.id, () => settings.alertExpiryHours], ([id]) => {
        if (id) listOf(id);
        removeExpiredAlerts();
      }),
    );
  });
  if (typeof window !== "undefined") window.setInterval(removeExpiredAlerts, EXPIRE_EVERY_MS);
}
