/**
 * Which layout the diff uses: the user's explicit choice of this session, else unified in a narrow pane, else the saved
 * setting. The switch has a hysteresis band so the layout does not flip back and forth around one width.
 */
import type { DiffMode } from "../../state/settings";

/** Below this pane width (px) side by side is unreadable and the diff falls back to unified. */
export const NARROW_DIFF_PX = 720;
/** A pane that fell back to unified returns to the saved mode only from this width (px) on; in between it keeps the layout it shows. */
export const WIDE_DIFF_PX = 820;

/**
 * @param explicit  mode the user picked in this session (header switch or Ctrl+Alt+D), or null
 * @param saved     the persisted `diffMode` setting
 * @param width     width of the diff pane in px; 0 / unknown (the pane is hidden) keeps the shown layout
 * @param shown     the layout the diff shows now, or null before the first one
 */
export function effectiveDiffMode(explicit: DiffMode | null, saved: DiffMode, width: number, shown: DiffMode | null = null): DiffMode {
  if (explicit) return explicit;
  if (width <= 0) return shown ?? saved;
  if (width < NARROW_DIFF_PX) return "unified";
  if (width >= WIDE_DIFF_PX || saved === "unified") return saved;
  // inside the band: keep what is shown (unified from a narrow pane, or the saved side by side)
  return shown ?? saved;
}
