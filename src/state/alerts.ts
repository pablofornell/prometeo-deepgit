/**
 * Status bar alerts (docs/design/ITERATION-3.md section 6). The rules are in `alertsCore.ts` (pure, tested); this file
 * keeps the lists in a signal and in localStorage (`deepgit.alerts.<projectId>`).
 *
 *   startAlerts();                    // once (the status bar does it)
 *   alerts()                          // alerts of the active project, newest first (reactive)
 *   raiseAlert({ severity: "error", text: "Push rejected.", repoName: "api" });   // active project
 *   dismiss(id); dismissAll();
 *   removeExpiredAlerts();
 *
 * Every warning and error `toast` becomes an alert (through `setToastAlertSink`). The auto-fetch failures are raised
 * from `autoFetch.ts`. An alert is removed after `settings.alertExpiryHours`: at start, every 60 s, and when the
 * popover opens.
 */
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { setToastAlertSink } from "../components/ui/Toast";
import {
  type Alert, type AlertInput, type AlertStorage, addAlert, dismissAlert, expireAlerts, loadAlerts, saveAlerts,
} from "./alertsCore";
import { settings } from "./settings";
import { activeProject } from "./workspace";

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

/** Adds an alert to the active project. Does nothing without a project. */
export function raiseAlert(a: Omit<AlertInput, "projectId">): void {
  const projectId = activeProject()?.id;
  if (!projectId) return;
  store(projectId, addAlert(listOf(projectId), { ...a, projectId }, Date.now(), newId));
}

export function dismiss(id: string): void {
  const projectId = activeProject()?.id;
  if (projectId) store(projectId, dismissAlert(listOf(projectId), id));
}

export function dismissAll(): void {
  const projectId = activeProject()?.id;
  if (projectId) store(projectId, []);
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

/** Connects the toasts, loads the alerts of the active project and starts the 60 s expiry sweep. Safe to call twice. */
export function startAlerts(): void {
  if (started) return;
  started = true;
  setToastAlertSink((a) => raiseAlert(a));
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
