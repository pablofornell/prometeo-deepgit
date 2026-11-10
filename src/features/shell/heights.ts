/**
 * Vertical split of the centre column: the main + details row (top) and the optional bottom tool window. The bottom
 * window keeps a share (ratio) of the space left after the splitter; the main row takes the rest and never gets
 * shorter than its minimum: when the window is small the bottom window gives way, down to its own minimum.
 */
export interface Mins {
  top: number;
  bottom: number;
}

export interface Ratios {
  bottom: number;
}

export interface Heights {
  top: number;
  bottom: number;
  /** Space the two parts share (column height without the splitter). */
  available: number;
}

export const DEFAULT_RATIOS: Ratios = { bottom: 0.2 };

/**
 * Keeps a persisted value usable: the ratio in (0, 0.9). Older versions saved `{ diff, bottom }` (the diff island
 * is gone); unknown keys are ignored and a bad value falls back to the default.
 */
export function sanitizeRatios(r: Partial<Ratios> | null | undefined): Ratios {
  const ok = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 0.9 ? v : d);
  return { bottom: ok(r?.bottom, DEFAULT_RATIOS.bottom) };
}

/**
 * @param total   height of the centre column in px
 * @param splitter thickness of the splitter in px
 * @param showBottom  whether the bottom tool window is visible
 */
export function allocate(total: number, splitter: number, showBottom: boolean, ratios: Ratios, mins: Mins): Heights {
  const available = Math.max(0, total - (showBottom ? splitter : 0));
  let bottom = showBottom ? Math.max(mins.bottom, Math.round(available * ratios.bottom)) : 0;
  const deficit = mins.top - (available - bottom);
  if (deficit > 0 && showBottom) bottom -= Math.min(deficit, bottom - mins.bottom);
  return { top: available - bottom, bottom, available };
}

/** The ratio that makes the bottom window `px` tall, kept inside what the main row allows. */
export function ratioFor(px: number, available: number): number {
  return available > 0 ? Math.min(0.9, Math.max(0.01, px / available)) : 0;
}

/** Largest height the bottom window can take without squeezing the main row below its minimum. */
export function maxBottom(h: Heights, mins: Mins): number {
  return Math.max(mins.bottom, h.available - mins.top);
}
