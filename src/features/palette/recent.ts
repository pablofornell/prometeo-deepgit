/** Recent palette items, persisted as `deepgit.ui.palette.recent` (last 10, newest first). */
import { loadPersisted, savePersisted } from "../../state/persist";
import type { PaletteItem } from "./sources";

const KEY = "palette.recent";
export const MAX_RECENT = 10;

/** Palette-only actions that were removed (the colour actions went with the per-repo colours). */
export const RETIRED_ACTIONS: ReadonlySet<string> = new Set(["x.repoColor", "x.projectColor"]);

/** Stable identity of an item, used to de-duplicate recents. */
export const itemKey = (i: PaletteItem): string => `${i.kind}:${i.key}`;

/**
 * Pure: the stored recents that can still be shown and run, at most `MAX_RECENT`. Dropped: anything that is not an
 * item, and an action that is retired or whose action is gone (`actionExists` is false for its key).
 *
 *   cleanRecent([{ kind: "action", key: "x.repoColor", ... }, fetch], exists)   [fetch]
 */
export function cleanRecent(raw: unknown, actionExists: (key: string) => boolean): PaletteItem[] {
  if (!Array.isArray(raw)) return [];
  const ok = (x: unknown): x is PaletteItem => {
    if (!x || typeof x !== "object") return false;
    const i = x as Partial<PaletteItem>;
    if (typeof i.kind !== "string" || typeof i.key !== "string") return false;
    if (i.kind !== "action") return true;
    return typeof i.title === "string" && !RETIRED_ACTIONS.has(i.key) && actionExists(i.key);
  };
  return raw.filter(ok).slice(0, MAX_RECENT);
}

/** The stored recents (`cleanRecent`); when some were dropped, the cleaned list is saved back. */
export function loadRecent(actionExists: (key: string) => boolean): PaletteItem[] {
  const raw = loadPersisted<unknown>(KEY, []);
  const list = cleanRecent(raw, actionExists);
  if (Array.isArray(raw) && raw.length !== list.length) saveRecent(list);
  return list;
}

/** Pure: `list` with `item` moved or added at the front, capped at `MAX_RECENT`. */
export function withRecent(list: PaletteItem[], item: PaletteItem): PaletteItem[] {
  return [item, ...list.filter((x) => itemKey(x) !== itemKey(item))].slice(0, MAX_RECENT);
}

export function saveRecent(list: PaletteItem[]): void {
  savePersisted(KEY, list);
}
