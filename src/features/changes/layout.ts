/** Vertical layout of the Local changes tab (file list above, commit box below). */

import { cssPx } from "../../state/metrics";

export { cssPx };

/**
 * True when the island is too short for the file list at its minimum plus the full commit box. `available` is the
 * island height without the notice and banner rows above the list.
 */
export function isCompact(available: number, listMin: number, commitMin: number): boolean {
  return available > 0 && available < listMin + commitMin;
}
