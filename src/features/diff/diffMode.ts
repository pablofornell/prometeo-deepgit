/** Which layout the diff uses: the user's explicit choice of this session, else unified in a narrow pane, else the saved setting. */
import type { DiffMode } from "../../state/settings";

/** Below this pane width (px) side by side is unreadable and the diff falls back to unified. */
export const NARROW_DIFF_PX = 720;

/**
 * @param explicit  mode the user picked in this session (header switch or Ctrl+Alt+D), or null
 * @param saved     the persisted `diffMode` setting
 * @param width     width of the diff pane in px; 0 / unknown (the pane is hidden) counts as wide
 */
export function effectiveDiffMode(explicit: DiffMode | null, saved: DiffMode, width: number): DiffMode {
  if (explicit) return explicit;
  return width > 0 && width < NARROW_DIFF_PX ? "unified" : saved;
}
