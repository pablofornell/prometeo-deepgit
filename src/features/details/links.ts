/** Opens a URL with the system browser through the opener plugin (desktop app only). */

/** True when running inside the Tauri shell: links are clickable only then. */
export const canOpenLinks: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function openLink(url: string): Promise<void> {
  if (!canOpenLinks) return;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
