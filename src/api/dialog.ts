/** Native dialogs (Tauri plugin-dialog). In a browser they return fixed fake values. */
import { isTauri } from "./tauri";

/** Opens the OS folder picker. Resolves to the chosen path, or null when cancelled. */
export async function pickFolder(title = "Choose a folder"): Promise<string | null> {
  if (!isTauri()) return "~/work/acme-shop";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ directory: true, multiple: false, title });
  return typeof res === "string" ? res : null;
}
