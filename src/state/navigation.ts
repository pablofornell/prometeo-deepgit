/**
 * Back / forward navigation like an IDE: the mouse side buttons (button 3 = back, button 4 = forward) and Alt+Left /
 * Alt+Right (registered in `shortcuts.ts`). The stack logic is in `navHistory.ts`; this file watches what the user does
 * and restores a location.
 *
 * A location is the main view (Log, Local changes, Files) plus the commit selected in the log, or the file open in the
 * Files view. A new location is recorded when the view, the commit or the file changes, and not while a location is
 * being restored. A commit selected in the log is found and scrolled into view by `LogView`; a file is opened by
 * `FilesView`, which tells this module how with `onOpenFile` and what its active file is with `setNavFile`.
 */
import { createEffect, createRoot, createSignal } from "solid-js";
import { isOverlayOpen } from "./keymap";
import { createNavHistory, type NavLocation } from "./navHistory";
import { mainTab, selectedCommit, setMainTab, setSelectedCommit, type MainTab } from "./selection";
import { onActiveProjectChanged, repoById } from "./workspace";

export interface NavFile {
  repoId: string;
  path: string;
}

const [navFile, setNavFileSig] = createSignal<NavFile | null>(null);
let openFile: ((repoId: string, path: string) => void) | null = null;

/** The Files view reports the file of its active tab here (null when none is open). */
export function setNavFile(f: NavFile | null): void {
  setNavFileSig((prev) => (prev?.repoId === f?.repoId && prev?.path === f?.path ? prev : f));
}

/** The Files view says how to open a file in a tab. Returns the function that removes it. */
export function onOpenFile(fn: (repoId: string, path: string) => void): () => void {
  openFile = fn;
  return () => {
    if (openFile === fn) openFile = null;
  };
}

const history = createNavHistory();

/** Where the user is now. */
function here(): NavLocation {
  const view = mainTab();
  if (view === "log") {
    const c = selectedCommit();
    return { view, commit: c ? { repoId: c.repoId, oid: c.oid, stash: c.stash?.index } : undefined };
  }
  if (view === "files") {
    const f = navFile();
    return { view, file: f ? { repoId: f.repoId, path: f.path } : undefined };
  }
  return { view };
}

const isView = (v: string): v is MainTab => v === "log" || v === "changes" || v === "files";

/** A location whose repo left the project, or whose view is unknown, is skipped. */
function isValid(loc: NavLocation): boolean {
  if (!isView(loc.view)) return false;
  const repoId = loc.commit?.repoId ?? loc.file?.repoId;
  return repoId === undefined || !!repoById(repoId);
}

let restoring = false;

/** Shows a location: the view first, then the commit (the log scrolls to it) or the file. */
function restore(loc: NavLocation): void {
  restoring = true;
  try {
    setMainTab(loc.view as MainTab);
    if (loc.view === "log" && loc.commit) {
      setSelectedCommit({ repoId: loc.commit.repoId, oid: loc.commit.oid, stash: loc.commit.stash === undefined ? undefined : { index: loc.commit.stash } });
    } else if (loc.view === "files" && loc.file) {
      openFile?.(loc.file.repoId, loc.file.path);
    }
  } finally {
    restoring = false;
  }
  // The place shown can differ from the stored one (a location without commit keeps the selection): follow it, so it
  // does not count as a new location.
  history.settle(loc.view === "files" ? loc : here());
}

/** Goes back one location. Returns false when there is none. */
export function navBack(): boolean {
  const loc = history.back(isValid);
  if (!loc) return false;
  restore(loc);
  return true;
}

/** Goes forward one location. Returns false when there is none. */
export function navForward(): boolean {
  const loc = history.forward(isValid);
  if (!loc) return false;
  restore(loc);
  return true;
}

/** True when `t` is a text field or an editor: Alt+Left / Alt+Right there move the cursor, they do not navigate. */
export function inTextField(t: EventTarget | null | undefined): boolean {
  const el = t as Element | null | undefined;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor') !== null;
}

function onMouse(e: MouseEvent): void {
  if (e.button !== 3 && e.button !== 4) return;
  // The webview would do its own page history on these buttons.
  e.preventDefault();
  if (e.type !== "mouseup" || isOverlayOpen()) return;
  if (e.button === 3) navBack();
  else navForward();
}

/** Starts recording locations and listening to the mouse side buttons. Called once from `App`; returns the stop function. */
export function startNavigation(): () => void {
  const dispose = createRoot((off) => {
    // Several changes in one tick (a palette pick sets the view and the commit) count as one location.
    let queued = false;
    const record = (): void => {
      queued = false;
      if (!restoring) history.record(here());
    };
    createEffect(() => {
      here();
      if (restoring || queued) return;
      queued = true;
      queueMicrotask(record);
    });
    const offProject = onActiveProjectChanged(() => {
      history.clear();
      queueMicrotask(record);
    });
    return () => {
      offProject();
      off();
    };
  });
  const types = ["mousedown", "mouseup", "auxclick"] as const;
  for (const t of types) window.addEventListener(t, onMouse, true);
  return () => {
    for (const t of types) window.removeEventListener(t, onMouse, true);
    dispose();
  };
}
