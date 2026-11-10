/**
 * Shell layout state: which panels are visible and which bottom tool window is open.
 * Panel sizes live in `Splitter` (`persistKey`); see `features/shell/Shell.tsx`.
 *
 *   toggleBottomTool("console");   // Alt+9
 *   openBottomTool("console");     // e.g. the "Show in console" toast action
 */
import { createSignal } from "solid-js";
import { loadPersisted, savePersisted } from "./persist";

export type BottomTool = "console" | "matrix";

const [sidebarVisible, setSidebarVisibleRaw] = createSignal(loadPersisted("sidebarVisible", true));
const [diffVisible, setDiffVisibleRaw] = createSignal(loadPersisted("diffVisible", true));
const [bottomTool, setBottomToolRaw] = createSignal<BottomTool | null>(loadPersisted<BottomTool | null>("bottomTool", null));

export { sidebarVisible, diffVisible, bottomTool };

export function setSidebarVisible(v: boolean): void {
  setSidebarVisibleRaw(v);
  savePersisted("sidebarVisible", v);
}
export const toggleSidebar = () => setSidebarVisible(!sidebarVisible());

export function setDiffVisible(v: boolean): void {
  setDiffVisibleRaw(v);
  savePersisted("diffVisible", v);
}
export const toggleDiff = () => setDiffVisible(!diffVisible());

/** Opens a bottom tool window, or closes it when `tool` is null. */
export function openBottomTool(tool: BottomTool | null): void {
  setBottomToolRaw(tool);
  savePersisted("bottomTool", tool);
}
/** Opens the tool, or closes it when it is already the open one. */
export function toggleBottomTool(tool: BottomTool): void {
  openBottomTool(bottomTool() === tool ? null : tool);
}
