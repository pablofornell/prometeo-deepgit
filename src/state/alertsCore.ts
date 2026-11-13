/**
 * Status bar alerts (docs/design/ITERATION-3.md section 6): the pure rules, free of the app stores so they can be
 * tested with a fake clock and a fake storage. `alerts.ts` wires them to the stores.
 *
 * An alert is a warning or an error that needs the user. It belongs to one project; each project keeps at most
 * `MAX_ALERTS` of them, newest first, in `deepgit.alerts.<projectId>`. The same text for the same repo replaces the
 * old alert (new time), it never adds a duplicate. Alerts older than the chosen expiry are removed.
 */

export type AlertSeverity = "error" | "warning";

export interface Alert {
  id: string;
  projectId: string;
  severity: AlertSeverity;
  text: string;
  /** Name of the repository the alert is about. */
  repoName?: string;
  /** Id of that repository (lets the app dismiss the alert when the cause is gone). */
  repoId?: string;
  /** Who raised it, when the app dismisses it by itself: `autoFetch` goes away when the repo fetches well again. */
  source?: "autoFetch";
  /** Unix ms. */
  time: number;
}

/** What the caller gives; the store adds `id` and `time`. */
export type AlertInput = Pick<Alert, "projectId" | "severity" | "text" | "repoName" | "repoId" | "source">;

/** The parts of a project that decide where an alert goes. */
export interface AlertProject {
  id: string;
  repos: readonly { id: string; name: string }[];
}

/** What a caller knows about where an alert belongs. Nothing known: the active project. */
export interface AlertTarget {
  projectId?: string;
  repoId?: string;
  repoName?: string;
}

/**
 * The project (and repo) of an alert. A project id wins; then the project that owns the repo id; then the project that
 * has a repo of that name (the active one first); else the active project. Returns undefined when there is none.
 * The alert belongs to the project that started the action, not to the one that is active when the result arrives.
 */
export function resolveAlertTarget(
  projects: readonly AlertProject[],
  target: AlertTarget,
  activeId: string | undefined,
): { projectId: string; repoId?: string; repoName?: string } | undefined {
  const byId = (id: string | undefined) => projects.find((p) => p.id === id);
  const owner = target.repoId ? projects.find((p) => p.repos.some((r) => r.id === target.repoId)) : undefined;
  const byName = target.repoName
    ? [byId(activeId), ...projects].find((p) => p?.repos.some((r) => r.name === target.repoName))
    : undefined;
  const project = (target.projectId ? byId(target.projectId) : undefined) ?? owner ?? byName ?? byId(activeId);
  if (!project) return target.projectId ? { projectId: target.projectId, repoId: target.repoId, repoName: target.repoName } : undefined;
  const repo = project.repos.find((r) => r.id === target.repoId) ?? (target.repoName ? project.repos.find((r) => r.name === target.repoName) : undefined);
  return { projectId: project.id, repoId: repo?.id ?? target.repoId, repoName: target.repoName ?? repo?.name };
}

/** The part of `Storage` that the alerts use. */
export interface AlertStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MAX_ALERTS = 100;

/** Expiry choices in hours, in the order of the Settings control (0 = never). */
export const ALERT_EXPIRY_CHOICES = [1, 4, 24, 72, 168, 0] as const;
export const ALERT_EXPIRY_DEFAULT = 24;

/** "1 hour", "24 hours", "3 days", "Never". */
export function alertExpiryLabel(hours: number): string {
  if (hours <= 0) return "Never";
  if (hours <= 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = hours / 24;
  return days === 1 ? "1 day" : `${days} days`;
}

/** The footer of the popover. */
export function alertExpiryFooter(hours: number): string {
  return hours <= 0 ? "Alerts stay until you dismiss them." : `Alerts expire after ${alertExpiryLabel(hours)}.`;
}

export const alertsKey = (projectId: string): string => `deepgit.alerts.${projectId}`;

/** Title and body of a toast as one sentence: "Push rejected by origin. Pull, then push again." */
export function alertText(title: string, body?: string): string {
  const t = title.trim();
  const b = body?.trim();
  if (!b) return t;
  return /[.!?:]$/.test(t) ? `${t} ${b}` : `${t}. ${b}`;
}

function isAlert(v: unknown): v is Alert {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.projectId === "string" &&
    (a.severity === "error" || a.severity === "warning") &&
    typeof a.text === "string" &&
    (a.repoName === undefined || typeof a.repoName === "string") &&
    (a.repoId === undefined || typeof a.repoId === "string") &&
    (a.source === undefined || a.source === "autoFetch") &&
    typeof a.time === "number" &&
    Number.isFinite(a.time)
  );
}

const newestFirst = (a: Alert, b: Alert): number => b.time - a.time;

/** Reads the alerts of a project: valid entries only, newest first, at most `MAX_ALERTS`. Never throws. */
export function loadAlerts(storage: AlertStorage, projectId: string): Alert[] {
  try {
    const raw = storage.getItem(alertsKey(projectId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAlert).filter((a) => a.projectId === projectId).sort(newestFirst).slice(0, MAX_ALERTS);
  } catch {
    return [];
  }
}

/** Writes the alerts of a project; an empty list removes the key. Never throws. */
export function saveAlerts(storage: AlertStorage, projectId: string, list: readonly Alert[]): void {
  try {
    if (list.length > 0) storage.setItem(alertsKey(projectId), JSON.stringify(list));
    else storage.removeItem(alertsKey(projectId));
  } catch {
    /* ignore */
  }
}

/** Adds an alert at the top. An alert with the same text and repo is replaced (it keeps its id, gets the new time and severity). */
export function addAlert(list: readonly Alert[], input: AlertInput, now: number, newId: () => string): Alert[] {
  const same = list.find((a) => a.text === input.text && a.repoName === input.repoName);
  const alert: Alert = { id: same?.id ?? newId(), projectId: input.projectId, severity: input.severity, text: input.text, time: now };
  if (input.repoName !== undefined) alert.repoName = input.repoName;
  if (input.repoId !== undefined) alert.repoId = input.repoId;
  if (input.source !== undefined) alert.source = input.source;
  return [alert, ...list.filter((a) => a !== same)].sort(newestFirst).slice(0, MAX_ALERTS);
}

export function dismissAlert(list: readonly Alert[], id: string): Alert[] {
  return list.filter((a) => a.id !== id);
}

/** Removes the auto-fetch alerts of repos (the repos fetch well again). Returns the same array when none matched. */
export function dismissAutoFetchAlerts(list: readonly Alert[], repoIds: readonly string[]): readonly Alert[] {
  if (repoIds.length === 0) return list;
  const kept = list.filter((a) => !(a.source === "autoFetch" && a.repoId !== undefined && repoIds.includes(a.repoId)));
  return kept.length === list.length ? list : kept;
}

/** Removes the alerts older than `hours` (0 or less = never). Returns the same array when nothing expired. */
export function expireAlerts(list: readonly Alert[], now: number, hours: number): readonly Alert[] {
  if (hours <= 0) return list;
  const limit = now - hours * 3_600_000;
  const kept = list.filter((a) => a.time > limit);
  return kept.length === list.length ? list : kept;
}

/** "No alerts" or "2 errors, 1 warning in IRIS". */
export function describeAlerts(list: readonly Alert[], projectName: string | undefined): string {
  if (list.length === 0) return "No alerts";
  const errors = list.filter((a) => a.severity === "error").length;
  const warnings = list.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  return `${parts.join(", ")}${projectName ? ` in ${projectName}` : ""}`;
}

/** The badge text: the count, or "99+". */
export const alertBadge = (count: number): string => (count > 99 ? "99+" : String(count));

/** The widget state: no alerts, warnings only, or one or more errors. */
export function alertLevel(list: readonly Alert[]): "none" | "warning" | "error" {
  if (list.length === 0) return "none";
  return list.some((a) => a.severity === "error") ? "error" : "warning";
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `dd-mm-yyyy HH:mm` in the local time zone. */
export function formatAlertTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Which failures of the auto-fetch need a new alert, and which repos recovered. `reported` maps a repo to the failure
 * count that was already raised; a failure is raised once per attempt, so a dismissed alert does not come back at
 * every status update. `checked` is every repo of the active project: one that is in `reported`, in `checked` and not
 * failing has recovered. Repos of other projects keep their entry in `reported`.
 */
export function newAutoFetchFailures(
  reported: ReadonlyMap<string, number>,
  failing: readonly { repoId: string; message: string; failures: number }[],
  checked: readonly string[],
): { raise: { repoId: string; message: string }[]; recovered: string[]; reported: Map<string, number> } {
  const next = new Map<string, number>();
  const raise: { repoId: string; message: string }[] = [];
  const recovered: string[] = [];
  const failingIds = new Set(failing.map((f) => f.repoId));
  for (const [repoId, count] of reported) {
    if (failingIds.has(repoId)) continue;
    if (checked.includes(repoId)) recovered.push(repoId);
    else next.set(repoId, count);
  }
  for (const f of failing) {
    next.set(f.repoId, f.failures);
    if (f.failures > (reported.get(f.repoId) ?? 0)) raise.push({ repoId: f.repoId, message: f.message });
  }
  return { raise, recovered, reported: next };
}

/** "Auto-fetch failed: authentication required." */
export function autoFetchAlertText(message: string): string {
  const m = message.trim().replace(/\s+/g, " ");
  if (!m) return "Auto-fetch failed.";
  return /[.!?]$/.test(m) ? `Auto-fetch failed: ${m}` : `Auto-fetch failed: ${m}.`;
}
