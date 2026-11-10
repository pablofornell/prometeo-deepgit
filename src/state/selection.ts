/**
 * What the user selected: the commit (log), the file (details / local changes) shown in the diff
 * island, and which main tab is active.
 *
 *   setSelectedCommit({ repoId, oid });
 *   selectFile({ repoId, spec: { kind: "commit", oid }, path });
 *   <Show when={selectedFile()}>{(f) => <DiffViewer repoId={f().repoId} spec={f().spec} path={f().path} />}</Show>
 */
import { createSignal } from "solid-js";
import type { DiffSpec } from "../api/types";
import { onActiveProjectChanged, setFocusedRepoId } from "./workspace";

export interface SelectedCommit {
  repoId: string;
  oid: string;
}

export interface SelectedFile {
  repoId: string;
  spec: DiffSpec;
  path: string;
  oldPath?: string;
}

export type MainTab = "log" | "changes";

const [commit, setCommit] = createSignal<SelectedCommit | null>(null);
const [file, setFile] = createSignal<SelectedFile | null>(null);
const [tab, setTab] = createSignal<MainTab>("log");
const [changesRepo, setChangesRepo] = createSignal<string | null>(null);

/** The commit selected in the log (reactive). */
export const selectedCommit = commit;
/** The file whose diff the diff island shows (reactive). */
export const selectedFile = file;
/** Active tab of the main island (reactive). */
export const mainTab = tab;
/** Repo shown in the Local changes tab when a single repo is scoped (reactive). */
export const changesRepoId = changesRepo;

/** Selects a commit (or none). Clears the selected file when the commit changes and focuses its repo. */
export function setSelectedCommit(c: SelectedCommit | null): void {
  const prev = commit();
  if (prev?.repoId === c?.repoId && prev?.oid === c?.oid) return;
  setCommit(c);
  if (file()?.spec.kind === "commit") setFile(null);
  if (c) setFocusedRepoId(c.repoId);
}

/** Selects the file shown in the diff island (or none). */
export function selectFile(f: SelectedFile | null): void {
  setFile(f);
  if (f) setFocusedRepoId(f.repoId);
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
}

// A commit, file or changes repo of the old project means nothing in the new one.
onActiveProjectChanged(() => {
  clearSelection();
  setChangesRepoId(null);
});
