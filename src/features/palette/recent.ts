/** Recent palette items, persisted as `deepgit.ui.palette.recent` (last 10, newest first). */
import { loadPersisted, savePersisted } from "../../state/persist";
import type { PaletteItem } from "./sources";

const KEY = "palette.recent";
export const MAX_RECENT = 10;

/** Stable identity of an item, used to de-duplicate recents. */
export const itemKey = (i: PaletteItem): string => `${i.kind}:${i.key}`;

export function loadRecent(): PaletteItem[] {
  const raw = loadPersisted<unknown>(KEY, []);
  return Array.isArray(raw) ? (raw.filter((x) => x && typeof x === "object" && typeof (x as PaletteItem).kind === "string") as PaletteItem[]).slice(0, MAX_RECENT) : [];
}

/** Pure: `list` with `item` moved or added at the front, capped at `MAX_RECENT`. */
export function withRecent(list: PaletteItem[], item: PaletteItem): PaletteItem[] {
  return [item, ...list.filter((x) => itemKey(x) !== itemKey(item))].slice(0, MAX_RECENT);
}

export function saveRecent(list: PaletteItem[]): void {
  savePersisted(KEY, list);
}
