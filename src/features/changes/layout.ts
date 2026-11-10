/** Vertical layout of the Local changes tab (file list above, commit box below). */

/** Reads a px token from the document root. */
export function cssPx(name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * True when the island is too short for the file list at its minimum plus the full commit box. `available` is the
 * island height without the notice and banner rows above the list.
 */
export function isCompact(available: number, listMin: number, commitMin: number): boolean {
  return available > 0 && available < listMin + commitMin;
}
