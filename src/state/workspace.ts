/**
 * Projects, the active project, its repos, the repo filter of the log and the per-repo summaries.
 *
 *   const repos = () => workspace.projects.find(...)   // use the helpers below instead:
 *   <For each={projectRepos()}>{(r) => <span>{r.name} {summary(r.id)?.branch}</span>}</For>
 *   selectOnlyRepo(repoId)           // log filter
 *   void refreshSummaries();         // all repos of the active project, throttled
 *
 * Summaries refresh by themselves (throttled) when a `repo-changed` event arrives.
 */
import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import * as api from "../api/tauri";
import { validateProjectName } from "../api/projectName";
import type { CloneResult, Project, RepoInfo, RepoSummary } from "../api/types";
import { dirtyCount } from "./changesScope";
import { subscribeRepoChanged } from "./events";
import { loadPersisted, savePersisted } from "./persist";
import { sidebarOrder } from "./repoTree";

// ---------------------------------------------------------------- projects

interface WorkspaceState {
  projects: Project[];
  activeProjectId: string | null;
  loaded: boolean;
}

const [workspace, setWorkspace] = createStore<WorkspaceState>({ projects: [], activeProjectId: null, loaded: false });
export { workspace };

/** The active project, or undefined when the workspace has none (the app shows `Welcome`). */
export const activeProject = (): Project | undefined => workspace.projects.find((p) => p.id === workspace.activeProjectId);

/** Repos of the active project, in sidebar order (folders first, then names; ITERATION-3 1.1). The combined graph orders its lanes the same way. */
export const projectRepos: () => RepoInfo[] = createRoot(() => createMemo(() => sidebarOrder(activeProject()?.repos ?? [])));

/** True when the active project has more than one repo. */
export const isMultiRepo = (): boolean => projectRepos().length > 1;

/** Finds a repo of any project by id. */
export function repoById(repoId: string): RepoInfo | undefined {
  for (const p of workspace.projects) {
    const r = p.repos.find((x) => x.id === repoId);
    if (r) return r;
  }
  return undefined;
}

/** Loads the workspace from the backend (once at startup) and the summaries of the active project. */
export async function loadWorkspace(): Promise<void> {
  const ws = await api.workspaceLoad();
  batch(() => {
    setWorkspace({ projects: ws.projects, activeProjectId: ws.activeProjectId ?? ws.projects[0]?.id ?? null, loaded: true });
  });
  projectSwitched();
  await refreshSummaries();
}

/** Opens the folder picker (or uses `path`) and adds the folder as a project. Resolves to the project, or null when cancelled. */
export async function addProject(path?: string): Promise<Project | null> {
  const chosen = path ?? (await (await import("../api/dialog")).pickFolder("Add project folder"));
  if (!chosen) return null;
  const project = await api.projectAdd(chosen);
  setWorkspace(
    produce((s) => {
      const i = s.projects.findIndex((p) => p.id === project.id);
      if (i >= 0) s.projects[i] = project;
      else s.projects.push(project);
    }),
  );
  await setActiveProject(project.id);
  return project;
}

export async function setActiveProject(projectId: string): Promise<void> {
  await api.projectSetActive(projectId);
  setWorkspace("activeProjectId", projectId);
  projectSwitched();
  await refreshSummaries();
}

export async function removeProject(projectId: string): Promise<void> {
  await api.projectRemove(projectId);
  const wasActive = workspace.activeProjectId === projectId;
  setWorkspace(
    produce((s) => {
      s.projects = s.projects.filter((p) => p.id !== projectId);
      if (s.activeProjectId === projectId) s.activeProjectId = s.projects[0]?.id ?? null;
    }),
  );
  if (wasActive) projectSwitched();
  else restoreRepoFilter();
  await refreshSummaries();
}

/** Re-discovers the repos of a project. */
export async function rescanProject(projectId: string): Promise<void> {
  const project = await api.projectRescan(projectId);
  setWorkspace("projects", (p) => p.id === projectId, reconcile(project));
  restoreRepoFilter();
  await refreshSummaries();
}

/**
 * Takes in what `cloneRepo` made: the rescanned or new project replaces / joins the store and becomes the active one,
 * with the new repo in the log filter and focused.
 */
export async function adoptClonedProject(result: CloneResult): Promise<void> {
  const { project } = result;
  setWorkspace(
    produce((s) => {
      const i = s.projects.findIndex((p) => p.id === project.id);
      if (i >= 0) s.projects[i] = project;
      else s.projects.push(project);
    }),
  );
  if (workspace.activeProjectId !== project.id) {
    await api.projectSetActive(project.id);
    setWorkspace("activeProjectId", project.id);
    projectSwitched();
  } else {
    restoreRepoFilter();
  }
  const added = project.repos.find((r) => r.path === result.path);
  if (added) {
    if (!selectedIds().includes(added.id)) setSelectedRepoIds([...selectedIds(), added.id]);
    setFocusedRepoId(added.id);
  }
  await refreshSummaries();
}

/** Why `name` cannot be the new name of project `projectId` (the backend's rules, checked while the user types), or null. */
export function projectNameError(projectId: string, name: string): string | null {
  return validateProjectName(name, workspace.projects, projectId).error ?? null;
}

/**
 * Renames a project; the backend validates the name and saves the workspace. The id does not change, so the log filter,
 * the selection and every saved per-project state stay; the title bar, the sidebar, the switcher and Welcome show the new
 * name at once. Rejects with the backend error.
 */
export async function renameProject(projectId: string, name: string): Promise<Project> {
  const updated = await api.projectRename(projectId, name);
  setWorkspace("projects", (p) => p.id === projectId, "name", updated.name);
  return updated;
}

// ---------------------------------------------------------------- repo filter (log scope)

const [selectedIds, setSelectedIds] = createSignal<string[]>([]);

const switchListeners = new Set<() => void>();

/**
 * Calls `cb` whenever the active project changes (switch, removal of the active project, first load). `state/selection.ts`
 * uses it to drop the commit/file/changes-repo selection of the old project.
 */
export function onActiveProjectChanged(cb: () => void): () => void {
  switchListeners.add(cb);
  return () => switchListeners.delete(cb);
}

/** The active project is another one now: resets selection (via listeners), repo filter and focused repo. */
function projectSwitched(): void {
  batch(() => {
    switchListeners.forEach((cb) => cb());
    restoreRepoFilter();
  });
}

function filterKey(): string {
  return "repoFilter." + (workspace.activeProjectId ?? "none");
}

function restoreRepoFilter(): void {
  const all = projectRepos().map((r) => r.id);
  const saved = loadPersisted<string[] | null>(filterKey(), null);
  const valid = saved ? all.filter((id) => saved.includes(id)) : [];
  setSelectedIds(valid.length > 0 ? valid : all);
  setFocusedRepoIdRaw(all.includes(focusedRepoId() ?? "") ? focusedRepoId() : all[0] ?? null);
}

/** Repo ids shown in the log and the changes view (the "Repos: 5 of 12" filter). Never empty when the project has repos. */
export const selectedRepoIds = (): string[] => selectedIds();

/** Replaces the repo filter. An empty list means "all". */
export function setSelectedRepoIds(ids: string[]): void {
  const all = projectRepos().map((r) => r.id);
  const next = all.filter((id) => ids.includes(id)); // sidebar order, whatever the order of `ids`
  const value = next.length > 0 ? next : all;
  setSelectedIds(value);
  savePersisted(filterKey(), value);
}

/** Adds or removes one repo from the filter (keeps at least one). */
export function toggleRepo(repoId: string): void {
  const cur = selectedIds();
  if (cur.includes(repoId)) {
    if (cur.length > 1) setSelectedRepoIds(cur.filter((id) => id !== repoId));
  } else {
    // keep sidebar order
    setSelectedRepoIds(projectRepos().map((r) => r.id).filter((id) => id === repoId || cur.includes(id)));
  }
}

/** The log shows only this repo ("Only this"; click on the repo spine). */
export function selectOnlyRepo(repoId: string): void {
  setSelectedRepoIds([repoId]);
}

export function selectAllRepos(): void {
  setSelectedRepoIds(projectRepos().map((r) => r.id));
}

/** True when the filter hides at least one repo of the project. */
export const isRepoFilterActive = (): boolean => selectedIds().length < projectRepos().length;

/** Repos that pass the filter, in sidebar order. */
export const selectedRepos = (): RepoInfo[] => projectRepos().filter((r) => selectedIds().includes(r.id));

// ---------------------------------------------------------------- focused repo

const [focusedRepoId, setFocusedRepoIdRaw] = createSignal<string | null>(null);

/**
 * The repo that single-repo commands apply to (title bar branch widget, status bar, Ctrl+Shift+K).
 * Selecting a commit or clicking a repo in the sidebar focuses it.
 */
export const focusedRepo = (): RepoInfo | undefined => {
  const id = focusedRepoId();
  return projectRepos().find((r) => r.id === id) ?? projectRepos()[0];
};
export const focusedRepoIdSignal = focusedRepoId;
/** Focuses a repo of the active project; ids that are not in it (e.g. left over from another project) are ignored. */
export function setFocusedRepoId(repoId: string | null): void {
  if (repoId !== null && !projectRepos().some((r) => r.id === repoId)) return;
  setFocusedRepoIdRaw(repoId);
}

// ---------------------------------------------------------------- summaries

const [summaries, setSummaries] = createStore<Record<string, RepoSummary>>({});

/** Latest summary of a repo (branch, ahead/behind, dirty counts, operation state), or undefined before the first load. */
export const summary = (repoId: string): RepoSummary | undefined => summaries[repoId];

/** Sums over the repos of the active project: what the Pull / Push buttons and the Local changes badge show. */
export const projectTotals = createRoot(() =>
  createMemo(() => {
    let ahead = 0;
    let behind = 0;
    let changes = 0;
    let conflicted = 0;
    let operations = 0;
    for (const r of projectRepos()) {
      const s = summaries[r.id];
      if (!s) continue;
      ahead += s.ahead;
      behind += s.behind;
      changes += dirtyCount(s);
      conflicted += s.conflicted;
      if (s.state !== "clean") operations++;
    }
    return { ahead, behind, changes, conflicted, operations };
  }),
);

let inflight: Promise<void> | null = null;
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let lastRun = 0;
const THROTTLE_MS = 300;

async function fetchSummaries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const list = await api.repoSummaries(ids);
    batch(() => {
      for (const s of list) setSummaries(s.repoId, reconcile(s));
    });
  } catch {
    /* a failed background refresh keeps the previous values */
  }
}

/**
 * Reloads summaries now. Without arguments: every repo of the active project.
 * Calls that arrive while one is running are merged into the next run.
 */
export function refreshSummaries(repoIds?: string[]): Promise<void> {
  const ids = repoIds ?? projectRepos().map((r) => r.id);
  for (const id of ids) pending.add(id);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      while (pending.size > 0) {
        const batchIds = [...pending];
        pending.clear();
        lastRun = Date.now();
        await fetchSummaries(batchIds);
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function scheduleRefresh(repoId: string): void {
  pending.add(repoId);
  if (timer !== undefined) return;
  const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastRun));
  timer = setTimeout(() => {
    timer = undefined;
    void refreshSummaries([]);
  }, wait);
}

// Refresh summaries when a repo changes (throttled).
subscribeRepoChanged(scheduleRefresh);
