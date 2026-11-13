/**
 * A request from outside the Files tab to open a file in it (the "Open .gitignore" toast action).
 * `openFileInFiles` shows the Files tab and leaves the request. The Files tab takes it with `takeOpenFileRequest`,
 * also when it mounts after the call.
 */
import { createSignal } from "solid-js";
import { setMainTab } from "./selection";

export interface OpenFileRequest {
  repoId: string;
  /** The path relative to the repo. */
  path: string;
}

const [request, setRequest] = createSignal<OpenFileRequest | null>(null);

/** The open request that waits for the Files tab (reactive). */
export const openFileRequest = request;

/** Shows the Files tab and asks it to open `path` of the repo. */
export function openFileInFiles(repoId: string, path: string): void {
  setRequest({ repoId, path });
  setMainTab("files");
}

/** Returns the waiting request and clears it. */
export function takeOpenFileRequest(): OpenFileRequest | null {
  const r = request();
  if (r) setRequest(null);
  return r;
}
