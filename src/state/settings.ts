/**
 * User settings, persisted one key at a time under `deepgit.ui.<key>`.
 *
 *   import { settings, setSetting, toggleTheme } from "../../state/settings";
 *   <Show when={settings.showGraph}>…</Show>
 *   setSetting("diffMode", "unified");
 *
 * `theme` is "dark" | "light" | "system"; `index.html` applies it before first paint with the same
 * rule as `applyTheme()`. The same is true for the sizes (`fontSize`, `editorFontSize`, `uiScale`): see
 * `state/appearance.ts` for the maths and `applyAppearance()` below for what they change.
 *
 * Every stored value is validated on load and on `setSetting` (unknown strings, NaN and out-of-range numbers fall
 * back to the default or are clamped). `resetSettings()` removes the stored values.
 */
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { setAuthPrefs } from "../api/tauri";
import {
  UI_SCALE_DEFAULT, appearanceVars, sanitizeEditorFontSize, sanitizeFontSize, sanitizeUiScale, stepUiScale,
  FONT_SIZE_DEFAULT,
} from "./appearance";
import type { DateFormat } from "./dateFormat";
import { bumpAppearance } from "./metrics";
import { loadPersisted, removePersisted, savePersisted } from "./persist";

export type ThemePref = "dark" | "light" | "system";
export type { DateFormat } from "./dateFormat";
export type DiffMode = "sideBySide" | "unified";

/** Periods the auto-fetch can have, in minutes (0 = off). */
export const AUTO_FETCH_CHOICES = [0, 5, 15, 30, 60] as const;

export interface Settings {
  theme: ThemePref;
  /** How every date of the UI is written (`state/dates.ts`): "3 h ago", "10 Nov 2026, 14:32" (the user's locale) or "2026-11-10 14:32". */
  dateFormat: DateFormat;
  diffMode: DiffMode;
  /** Scroll long diff lines by the pointer position near the pane edges (`features/diff/pointerScroll.ts`). */
  diffPointerScroll: boolean;
  // ---- auto-fetch and commit sign-off (wave 1: git features) -----------------------------------------------------
  /** Fetch every repo of the project in the background every N minutes; 0 = off (`state/autoFetch.ts`). */
  autoFetchMinutes: number;
  /** Auto-fetch runs `fetch --all --prune` (true) or `fetch --all` (false). */
  autoFetchPrune: boolean;
  /** The "Sign-off" box of the commit box starts ticked; the box remembers its last state here. */
  commitSignOff: boolean;
  // ---- end of the auto-fetch and sign-off block ------------------------------------------------------------------
  /** Draw the commit graph in the log. */
  showGraph: boolean;
  /** Taller rows in the log (the compact height plus 4 px at the default font size). */
  comfortableRows: boolean;
  /** Show background git commands (status, log, ...) in the console. */
  showBackgroundCommands: boolean;
  /** UI font size in px, 10..20. All text sizes and the heights that depend on text derive from it. */
  fontSize: number;
  /** Mono font size (diff, console, hashes) in px, 10..20; `null` follows `fontSize`. */
  editorFontSize: number | null;
  /** Page zoom in percent, 80..200 in steps of 10. */
  uiScale: number;

  // ---- Authentication (docs/PLAN.md section 5.6) ---------------------------------------------------------------
  /**
   * Read saved passwords, tokens and key passphrases from the system key store and offer "Remember" in the login
   * dialog. Off: DeepGit still asks, but never reads or writes the key store. Sent to the backend (`setAuthPrefs`).
   */
  useCredentialStore: boolean;
}

export const SETTING_DEFAULTS: Readonly<Settings> = {
  theme: "dark",
  dateFormat: "iso",
  diffMode: "sideBySide",
  diffPointerScroll: true,
  // ---- auto-fetch and commit sign-off
  autoFetchMinutes: 15,
  autoFetchPrune: true,
  commitSignOff: false,
  // ----
  showGraph: true,
  comfortableRows: false,
  showBackgroundCommands: false,
  fontSize: FONT_SIZE_DEFAULT,
  editorFontSize: null,
  uiScale: UI_SCALE_DEFAULT,
  useCredentialStore: true,
};

const oneOf =
  <T extends string>(...allowed: T[]) =>
  (fallback: T) =>
  (v: unknown): T =>
    allowed.includes(v as T) ? (v as T) : fallback;

/** One validator per key: returns a valid value for any input. */
export const SANITIZERS: { [K in keyof Settings]: (v: unknown) => Settings[K] } = {
  theme: oneOf<ThemePref>("dark", "light", "system")(SETTING_DEFAULTS.theme),
  dateFormat: oneOf<DateFormat>("relative", "absolute", "iso")(SETTING_DEFAULTS.dateFormat),
  diffMode: oneOf<DiffMode>("sideBySide", "unified")(SETTING_DEFAULTS.diffMode),
  diffPointerScroll: (v) => (typeof v === "boolean" ? v : SETTING_DEFAULTS.diffPointerScroll),
  autoFetchMinutes: (v) => ((AUTO_FETCH_CHOICES as readonly number[]).includes(v as number) ? (v as number) : SETTING_DEFAULTS.autoFetchMinutes),
  autoFetchPrune: (v) => (typeof v === "boolean" ? v : SETTING_DEFAULTS.autoFetchPrune),
  commitSignOff: (v) => (typeof v === "boolean" ? v : SETTING_DEFAULTS.commitSignOff),
  showGraph: (v) => (typeof v === "boolean" ? v : SETTING_DEFAULTS.showGraph),
  comfortableRows: (v) => (typeof v === "boolean" ? v : SETTING_DEFAULTS.comfortableRows),
  showBackgroundCommands: (v) => (typeof v === "boolean" ? v : SETTING_DEFAULTS.showBackgroundCommands),
  fontSize: sanitizeFontSize,
  editorFontSize: sanitizeEditorFontSize,
  uiScale: sanitizeUiScale,
  useCredentialStore: (v) => (typeof v === "boolean" ? v : SETTING_DEFAULTS.useCredentialStore),
};

const KEYS = Object.keys(SETTING_DEFAULTS) as (keyof Settings)[];

/**
 * Settings that no longer exist. Their stored values are deleted at startup, so an old profile loads cleanly:
 * `laneColors` ("repo" | "branch": graph lanes are always coloured by lane now) and `repoTintStrength`
 * (repositories have no colour of their own any more).
 */
export const RETIRED_KEYS = ["laneColors", "repoTintStrength"] as const;
for (const k of RETIRED_KEYS) removePersisted(k);

const initial = {} as Settings;
for (const k of KEYS) {
  (initial as unknown as Record<string, unknown>)[k] = SANITIZERS[k](loadPersisted<unknown>(k, SETTING_DEFAULTS[k]));
}

const [settings, setStore] = createStore<Settings>(initial);
export { settings };

const APPEARANCE_KEYS: (keyof Settings)[] = ["fontSize", "editorFontSize", "uiScale"];

/** Changes one setting (validated) and persists it. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  const v = SANITIZERS[key](value) as Settings[K];
  setStore(key, v as never);
  savePersisted(key, v);
  if (key === "theme") applyTheme();
  if (APPEARANCE_KEYS.includes(key)) applyAppearance();
  if (key === "useCredentialStore") pushAuthPrefs();
}

/** Puts the given settings (all when omitted) back to their defaults and removes the stored values. */
export function resetSettings(keys: readonly (keyof Settings)[] = KEYS): void {
  for (const k of keys) {
    setStore(k, SETTING_DEFAULTS[k] as never);
    removePersisted(k);
  }
  if (keys.includes("theme")) applyTheme();
  if (keys.some((k) => APPEARANCE_KEYS.includes(k))) applyAppearance();
  if (keys.includes("useCredentialStore")) pushAuthPrefs();
}

/** Tells the backend the authentication settings. Called at startup and whenever `useCredentialStore` changes. */
function pushAuthPrefs(): void {
  setAuthPrefs(settings.useCredentialStore).catch(() => undefined);
}

/** What the OS prefers now ("dark" when it cannot be asked). */
function readSystemTheme(): "dark" | "light" {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The OS colour scheme as a signal: `initSettings` keeps it current, so everything that reads `resolvedTheme()` follows an OS switch. */
const [systemTheme, setSystemTheme] = createSignal<"dark" | "light">(readSystemTheme());

/** "dark" or "light" after resolving "system" (reactive: it follows the OS when the preference is "system"). */
export function resolvedTheme(): "dark" | "light" {
  if (settings.theme !== "system") return settings.theme;
  return systemTheme();
}

/** Sets `data-theme` on <html>. Called at startup and whenever `theme` changes. */
export function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", resolvedTheme());
}

let lastZoom = 1;
const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Writes the size variables on <html> (`--dg-font-base`, `--dg-text-scale`, `--dg-editor-font-base`, `--dg-ui-scale`)
 * and zooms the page. In the desktop app that is the webview zoom (true page zoom: CSS px, `window.innerWidth` and
 * scroll maths stay consistent); in a browser it is the CSS `zoom` property of <html>.
 */
export function applyAppearance(): void {
  const root = document.documentElement;
  const vars = appearanceVars(settings);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  const zoom = settings.uiScale / 100;
  if (inTauri()) {
    root.style.removeProperty("zoom");
    if (zoom !== lastZoom) {
      lastZoom = zoom;
      void import("@tauri-apps/api/webview").then((m) => m.getCurrentWebview().setZoom(zoom)).catch(() => undefined);
    }
  } else if (zoom === 1) {
    root.style.removeProperty("zoom");
  } else {
    root.style.setProperty("zoom", String(zoom));
  }
  bumpAppearance();
}

/** Zooms the whole UI one step in or out; returns the new percent. */
export function zoomUi(dir: 1 | -1): number {
  const next = stepUiScale(settings.uiScale, dir);
  setSetting("uiScale", next);
  return next;
}

/** Flips between dark and light (the status bar switch). */
export function toggleTheme(): void {
  setSetting("theme", resolvedTheme() === "dark" ? "light" : "dark");
}

/** Applies the theme and the sizes and follows the OS when the preference is "system". Call once. */
export function initSettings(): void {
  applyTheme();
  applyAppearance();
  pushAuthPrefs();
  if (typeof matchMedia === "function") {
    setSystemTheme(readSystemTheme());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      setSystemTheme(readSystemTheme());
      if (settings.theme === "system") applyTheme();
    });
  }
}
