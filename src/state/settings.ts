/**
 * User settings, persisted one key at a time under `deepgit.ui.<key>`.
 *
 *   import { settings, setSetting, toggleTheme } from "../../state/settings";
 *   <Show when={settings.showGraph}>…</Show>
 *   setSetting("diffMode", "unified");
 *
 * `theme` is "dark" | "light" | "system"; `index.html` applies it before first paint with the same
 * rule as `applyTheme()`.
 */
import { createStore } from "solid-js/store";
import { loadPersisted, savePersisted } from "./persist";

export type ThemePref = "dark" | "light" | "system";
export type DateFormat = "relative" | "absolute";
export type DiffMode = "sideBySide" | "unified";
export type LaneColorMode = "repo" | "branch";

export interface Settings {
  theme: ThemePref;
  /** Date column of the log: "4 min ago" style or "10 Nov 2026 10:42". */
  dateFormat: DateFormat;
  diffMode: DiffMode;
  /** Draw the commit graph in the log. */
  showGraph: boolean;
  /** Lane colours in the combined log (DESIGN.md 11.6). */
  laneColors: LaneColorMode;
  /** 28 px rows instead of 24 px. */
  comfortableRows: boolean;
  /** Show background git commands (status, log, ...) in the console. */
  showBackgroundCommands: boolean;
}

const DEFAULTS: Settings = {
  theme: "dark",
  dateFormat: "relative",
  diffMode: "sideBySide",
  showGraph: true,
  laneColors: "repo",
  comfortableRows: false,
  showBackgroundCommands: false,
};

const initial = {} as Settings;
for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
  (initial as unknown as Record<string, unknown>)[k] = loadPersisted(k, DEFAULTS[k]);
}

const [settings, setStore] = createStore<Settings>(initial);
export { settings };

/** Changes one setting and persists it. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  setStore(key, value as never);
  savePersisted(key, value);
  if (key === "theme") applyTheme();
}

/** "dark" or "light" after resolving "system". */
export function resolvedTheme(): "dark" | "light" {
  if (settings.theme !== "system") return settings.theme;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Sets `data-theme` on <html>. Called at startup and whenever `theme` changes. */
export function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", resolvedTheme());
}

/** Flips between dark and light (the status bar switch). */
export function toggleTheme(): void {
  setSetting("theme", resolvedTheme() === "dark" ? "light" : "dark");
}

/** Applies the theme and follows the OS when the preference is "system". Call once. */
export function initSettings(): void {
  applyTheme();
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (settings.theme === "system") applyTheme();
    });
  }
}
