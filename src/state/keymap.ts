/**
 * The single keyboard registry (DESIGN.md section 8). Every shortcut of the app is registered here so
 * the palette, menus and tooltips can list it.
 *
 *   const off = register("log.focusFilter", "Ctrl+F", () => input.focus(), { title: "Focus the text filter", group: "Log" });
 *   register("palette.open", ["Shift Shift", "Ctrl+K"], openPalette);      // double-tap and chord
 *   register("tool.console", "Alt+9", toggleConsole, () => hasProject());   // `when` condition
 *   onCleanup(off);
 *
 * Key syntax: modifiers `Ctrl` (= Cmd on macOS; physical Ctrl stays Ctrl elsewhere), `Alt`, `Shift`, `Meta` joined by `+`, then the key:
 * a letter or digit (`K`, `9`), a symbol (`` ` ``, `,`, `[`, `-`, `=`), or a name (`Enter`, `Esc`, `Space`, `Delete`,
 * `Backspace`, `Tab`, `Up`, `Down`, `Left`, `Right`, `PageUp`, `PageDown`, `Home`, `End`, `F1`..`F12`, `Plus` = the "+" character with or without Shift).
 * Space-separated tokens are a sequence typed within 300 ms: `Shift Shift` is a double tap.
 *
 * Plain keys and Ctrl/Cmd chords do not fire while an input, textarea or editable element has focus,
 * unless `allowInInput` is set (Alt chords still do). While a menu, popup or dialog is open no binding fires
 * unless it sets `allowInOverlay` (the overlay owns the keyboard). A handler that returns `false` lets the event continue (no preventDefault).
 */
import { createEffect, createSignal, onCleanup } from "solid-js";

export interface BindingOptions {
  /** Binding is active only while this returns true. */
  when?: () => boolean;
  /** Human title for the palette ("Fetch all repositories"). */
  title?: string;
  /** Palette group ("Global", "Log", "Diff"). */
  group?: string;
  /** Fire even when a text field has focus (needed for plain keys and Ctrl/Cmd chords; Alt chords always fire). */
  allowInInput?: boolean;
  /** Fire even while a context menu, popup or dialog is open (default: the overlay owns the keyboard). */
  allowInOverlay?: boolean;
}

export type KeyHandler = (e?: KeyboardEvent) => void | boolean;

export interface Binding {
  id: string;
  keys: string[];
  title?: string;
  group?: string;
}

interface Entry extends Binding {
  sequences: string[][];
  handler: KeyHandler;
  when?: () => boolean;
  allowInInput: boolean;
  allowInOverlay: boolean;
}

const SEQ_WINDOW_MS = 300;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const entries: Entry[] = [];
const [version, setVersion] = createSignal(0);

// ---------------------------------------------------------------- overlays (menus, popups, dialogs)

const [overlays, setOverlays] = createSignal(0);

/** True while a context menu, popup or dialog is open: the keymap stays quiet then (see `allowInOverlay`). */
export const isOverlayOpen = (): boolean => overlays() > 0;

/** Marks an overlay as open; call the returned function when it closes. Used by `Menu`, `Popup` and `Dialog`. */
export function openOverlay(): () => void {
  setOverlays((n) => n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setOverlays((n) => Math.max(0, n - 1));
  };
}

/** Inside a component: keeps an overlay marked as open while `open()` is true (and until the component is disposed). */
export function trackOverlay(open: () => boolean): void {
  createEffect(() => {
    if (!open()) return;
    onCleanup(openOverlay());
  });
}

const NAMES: Record<string, string> = {
  " ": "Space", Escape: "Esc", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Del: "Delete", Return: "Enter",
};
const CODE_SYMBOLS: Record<string, string> = {
  Backquote: "`", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[",
  BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=",
};

/** Normalises a user-written combo ("ctrl+shift+a") to the canonical token ("Ctrl+Shift+A"). */
function normalizeToken(token: string): string {
  const parts = token.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((m) => m.toLowerCase()));
  const out: string[] = [];
  if (mods.has("ctrl") || mods.has("cmd") || mods.has("mod")) out.push("Ctrl");
  if (mods.has("alt") || mods.has("option")) out.push("Alt");
  if (mods.has("shift")) out.push("Shift");
  if (mods.has("meta")) out.push("Meta");
  const lower = key.toLowerCase();
  const named: Record<string, string> = { esc: "Esc", escape: "Esc", enter: "Enter", space: "Space", delete: "Delete", del: "Delete", backspace: "Backspace", tab: "Tab", up: "Up", down: "Down", left: "Left", right: "Right", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End" };
  let k: string;
  if (named[lower]) k = named[lower];
  else if (/^f\d{1,2}$/.test(lower)) k = lower.toUpperCase();
  else if (key.length === 1) k = key.toUpperCase();
  else if (["ctrl", "alt", "shift", "meta"].includes(lower)) k = lower[0].toUpperCase() + lower.slice(1);
  else k = key;
  // a lone modifier token ("Shift") has no "+" part
  if (["Ctrl", "Alt", "Shift", "Meta"].includes(k) && out.length === 0) return k;
  return [...out, k].join("+");
}

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/**
 * Token of a keydown event, in the same canonical form. On macOS only Cmd (`metaKey`) is "Ctrl"; the physical Ctrl
 * key becomes "Meta" there, so it never triggers the Cmd shortcuts. Elsewhere Ctrl is "Ctrl" and the Windows/Super key "Meta".
 */
export function eventToken(e: KeyEventLike, mac: boolean = isMac): string | null {
  if (e.key === "Shift") return "Shift";
  if (e.key === "Control") return mac ? "Meta" : "Ctrl";
  if (e.key === "Alt") return "Alt";
  if (e.key === "Meta") return mac ? "Ctrl" : "Meta";
  let key: string;
  // "+" and "-" are matched by the character, not the physical key: on many layouts (Spanish, German, ...) they are
  // not where a US keyboard has them. "+" is named `Plus` and ignores Shift (Shift is how most layouts type it).
  const plus = e.key === "+";
  if (plus) key = "Plus";
  else if (e.key === "-") key = "-";
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_SYMBOLS[e.code]) key = CODE_SYMBOLS[e.code];
  else key = NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey && !plus) mods.push("Shift");
  if (mac ? e.ctrlKey : e.metaKey) mods.push("Meta");
  return [...mods, key].join("+");
}

function parse(keys: string): string[] {
  return keys.split(/\s+/).filter(Boolean).map(normalizeToken);
}

/**
 * Registers a shortcut. `keys` may be one string or several alternatives.
 * Re-registering an existing `id` replaces it. Returns the unregister function.
 */
export function register(id: string, keys: string | string[], handler: KeyHandler, opts?: BindingOptions | (() => boolean)): () => void {
  const o: BindingOptions = typeof opts === "function" ? { when: opts } : opts ?? {};
  const list = Array.isArray(keys) ? keys : [keys];
  unregister(id);
  entries.push({
    id, keys: list, title: o.title, group: o.group, sequences: list.map(parse), handler, when: o.when,
    allowInInput: o.allowInInput ?? false, allowInOverlay: o.allowInOverlay ?? false,
  });
  setVersion((v) => v + 1);
  return () => unregister(id);
}

export function unregister(id: string): void {
  const i = entries.findIndex((e) => e.id === id);
  if (i >= 0) {
    entries.splice(i, 1);
    setVersion((v) => v + 1);
  }
}

/** All bindings (reactive), for the palette and "Keyboard shortcuts" views. */
export function bindings(): Binding[] {
  version();
  return entries.map(({ id, keys, title, group }) => ({ id, keys: [...keys], title, group }));
}

/** Key alternatives of a binding as registered ("Ctrl+K"), or []. Reactive. */
export function keysFor(id: string): string[] {
  version();
  return entries.find((e) => e.id === id)?.keys ?? [];
}

/** Display string of the first shortcut of a binding ("Ctrl+K", or "⌘K" on macOS), or "". Reactive. Use in tooltips. */
export function shortcutLabel(id: string): string {
  const k = keysFor(id)[0];
  return k ? formatKeys(k) : "";
}

/** Platform display form of a key string: "Ctrl+K" stays, macOS shows "⌘K". */
export function formatKeys(keys: string): string {
  if (!isMac) return keys;
  return keys
    .split(" ")
    .map((tok) => tok.replace(/Ctrl\+?/g, "⌘").replace(/Alt\+?/g, "⌥").replace(/Shift\+/g, "⇧"))
    .join(" ");
}

/** Runs a binding by id (what the palette does when the user picks an action). Returns false when unknown or inactive. */
export function runBinding(id: string): boolean {
  const e = entries.find((x) => x.id === id);
  if (!e || (e.when && !e.when())) return false;
  e.handler();
  return true;
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

let buffer: { token: string; t: number }[] = [];

const MODIFIERS = ["Shift", "Ctrl", "Alt", "Meta"];
const modsOf = (tok: string): string[] => tok.split("+").slice(0, -1);

/**
 * True when a text field has focus and this key sequence would clash with typing or editing there: plain keys
 * (also with Shift) and Ctrl/Cmd chords. Alt chords and modifier-only sequences ("Shift Shift") are not blocked.
 */
export function blockedInInput(seq: readonly string[]): boolean {
  if (seq.every((tok) => MODIFIERS.includes(tok))) return false;
  const mods = seq.flatMap(modsOf);
  if (mods.includes("Ctrl") || mods.includes("Meta")) return true;
  return !mods.includes("Alt");
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) return;
  const token = eventToken(e);
  if (!token) return;
  const now = performance.now();
  buffer = buffer.filter((b) => now - b.t <= SEQ_WINDOW_MS);
  buffer.push({ token, t: now });
  if (buffer.length > 4) buffer.shift();
  const editable = isEditable(e.target);
  const overlay = isOverlayOpen();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (overlay && !entry.allowInOverlay) continue;
    for (const seq of entry.sequences) {
      if (seq.length > buffer.length) continue;
      const tail = buffer.slice(buffer.length - seq.length);
      if (!seq.every((tok, k) => tok === tail[k].token)) continue;
      if (entry.when && !entry.when()) continue;
      if (editable && !entry.allowInInput && blockedInInput(seq)) continue;
      if (entry.handler(e) === false) continue;
      e.preventDefault();
      buffer = [];
      return;
    }
  }
}

/** Installs the global listener. Called once from `App`. Returns the uninstall function. */
export function installKeymap(): () => void {
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
