/** Window controls for the custom title bar. All are no-ops in a plain browser. */
import { isTauri } from "./tauri";

async function withWindow(fn: (w: import("@tauri-apps/api/window").Window) => Promise<void>): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await fn(getCurrentWindow());
}

export const minimizeWindow = () => withWindow((w) => w.minimize());
export const toggleMaximizeWindow = () => withWindow((w) => w.toggleMaximize());
export const closeWindow = () => withWindow((w) => w.close());
/** Starts an OS window drag (the title bar uses `data-tauri-drag-region`; call this for custom drag areas). */
export const startDraggingWindow = () => withWindow((w) => w.startDragging());
