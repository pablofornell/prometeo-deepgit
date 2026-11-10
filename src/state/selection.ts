/**
 * What the user selected: the commit (log), the file (details / local changes) shown in the "File changes" tab of
 * the right column, which tab of that column is open, and which main tab is active.
 *
 *   setSelectedCommit({ repoId, oid });
 *   selectFile({ repoId, spec: { kind: "commit", oid }, path });
 *   <Show when={selectedFile()}>{(f) => <DiffViewer repoId={f().repoId} spec={f().spec} path={f().path} />}</Show>
 */
import { createEffect, createRoot, createSignal, on } from "solid-js";
import type { DiffSpec, RepoInfo } from "../api/types";
import { changesCount, changesScope } from "./changesScope";
import { onActiveProjectChanged, projectRepos, selectedRepoIds, selectedRepos, setFocusedRepoId, summary } from "./workspace";

export interface SelectedCommit {
  repoId: string;
  oid: string;
  /** Set when a stash is selected: `oid` is then the stash commit. Not a log row. */
  stash?: { index: number };
}

export interface SelectedFile {
  repoId: string;
  spec: DiffSpec;
  path: string;
  oldPath?: string;
}

export type MainTab = "log" | "changes";
/** Tabs of the right column: "files" = Changed files (commit details), "diff" = File changes (the diff of the selected file). */
export type DetailsTab = "files" | "diff";

const [commit, setCommit] = createSignal<SelectedCommit | null>(null);
const [file, setFile] = createSignal<SelectedFile | null>(null);
const [tab, setTab] = createSignal<MainTab>("log");
const [changesRepo, setChangesRepo] = createSignal<string | null>(null);
const [dTab, setDTab] = createSignal<DetailsTab>("files");

/** The commit selected in the log (reactive). */
export const selectedCommit = commit;
/** The file whose diff the "File changes" tab shows (reactive). */
export const selectedFile = file;
/** Active tab of the main island (reactive). */
export const mainTab = tab;
/** Repo shown in the Local changes tab when a single repo is scoped (reactive). */
export const changesRepoId = changesRepo;
/** Active tab of the right column (reactive). */
export const detailsTab = dTab;

/**
 * Repos the Local changes view shows (reactive): the single repo picked in the sidebar / the Uncommitted changes row,
 * else the repos that pass the repo filter (the project-level view).
 */
export const changesScopeRepos = (): RepoInfo[] => changesScope(projectRepos(), selectedRepos(), changesRepo());
/** Changed files in `changesScopeRepos()` (reactive): the number the Local changes badges show. */
export const changesScopeCount = (): number => changesCount(changesScopeRepos(), summary);

/**
 * Selects a commit (or none) and focuses its repo. The selected file stays: `CommitDetails` re-points it to the new
 * commit when the commit changes the same path, and drops it (back to "Changed files") when it does not.
 * Selecting no commit drops a commit file at once.
 */
export function setSelectedCommit(c: SelectedCommit | null): void {
  const prev = commit();
  if (prev?.repoId === c?.repoId && prev?.oid === c?.oid && prev?.stash?.index === c?.stash?.index) return;
  setCommit(c);
  if (!c && file()?.spec.kind === "commit") {
    setFile(null);
    setDTab("files");
  }
  if (c) setFocusedRepoId(c.repoId);
}

/**
 * Selects the file shown in the "File changes" tab (or none). By default the right column switches to that tab;
 * pass `{ reveal: false }` to select quietly (keyboard moves in the file tree, re-pointing after a commit change).
 */
export function selectFile(f: SelectedFile | null, opts?: { reveal?: boolean }): void {
  setFile(f);
  if (f) {
    setFocusedRepoId(f.repoId);
    if (opts?.reveal !== false) setDTab("diff");
  }
}

/** Opens a tab of the right column. */
export function setDetailsTab(t: DetailsTab): void {
  setDTab(t);
}

export function setMainTab(t: MainTab): void {
  setTab(t);
}

export function setChangesRepoId(repoId: string | null): void {
  setChangesRepo(repoId);
}

/** Clears commit and file selection. */
export function clearSelection(): void {
  setCommit(null);
  setFile(null);
  setDTab("files");
}

// Changing the repo filter (show all, hide a repo, only this one) goes back to the project-level Local changes view;
// otherwise a repo picked earlier would keep hiding the others after the user asked to see them.
createRoot(() => {
  let last = selectedRepoIds().join("\0");
  createEffect(
    on(selectedRepoIds, (ids) => {
      const key = ids.join("\0");
      if (key === last) return;
      last = key;
      setChangesRepo(null);
    }, { defer: true }),
  );
});

// A commit, file or changes repo of the old project means nothing in the new one.
onActiveProjectChanged(() => {
  clearSelection();
  setChangesRepoId(null);
});
