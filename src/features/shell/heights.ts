/**
 * Vertical split of the centre column: main + details row (top), optional diff island and optional bottom tool
 * window. The diff and the bottom window keep a share (ratio) of the space left after the splitters; the main row
 * takes the rest and never gets shorter than its minimum: when the window is small the bottom window gives way first,
 * then the diff, down to their own minimums.
 */
export interface Mins {
  top: number;
  diff: number;
  bottom: number;
}

export interface Ratios {
  diff: number;
  bottom: number;
}

export interface Heights {
  top: number;
  diff: number;
  bottom: number;
  /** Space the three parts share (column height without the splitters). */
  available: number;
}

export const DEFAULT_RATIOS: Ratios = { diff: 0.3, bottom: 0.2 };

/** Keeps a persisted value usable: both ratios in (0, 0.9) and together at most 0.9. */
export function sanitizeRatios(r: Partial<Ratios> | null | undefined): Ratios {
  const ok = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 0.9 ? v : d);
  const out = { diff: ok(r?.diff, DEFAULT_RATIOS.diff), bottom: ok(r?.bottom, DEFAULT_RATIOS.bottom) };
  if (out.diff + out.bottom > 0.9) return { ...DEFAULT_RATIOS };
  return out;
}

/**
 * @param total   height of the centre column in px
 * @param splitter thickness of one splitter in px
 * @param showDiff / showBottom  which optional parts are visible
 */
export function allocate(total: number, splitter: number, showDiff: boolean, showBottom: boolean, ratios: Ratios, mins: Mins): Heights {
  const splitters = (showDiff ? 1 : 0) + (showBottom ? 1 : 0);
  const available = Math.max(0, total - splitters * splitter);
  let diff = showDiff ? Math.max(mins.diff, Math.round(available * ratios.diff)) : 0;
  let bottom = showBottom ? Math.max(mins.bottom, Math.round(available * ratios.bottom)) : 0;
  let deficit = mins.top - (available - diff - bottom);
  if (deficit > 0 && showBottom) {
    const take = Math.min(deficit, bottom - mins.bottom);
    bottom -= take;
    deficit -= take;
  }
  if (deficit > 0 && showDiff) {
    const take = Math.min(deficit, diff - mins.diff);
    diff -= take;
  }
  return { top: available - diff - bottom, diff, bottom, available };
}

/** The ratio that makes a part `px` tall, kept inside what the other parts allow. */
export function ratioFor(px: number, available: number): number {
  return available > 0 ? Math.min(0.9, Math.max(0.01, px / available)) : 0;
}

/** Largest height the diff (`part` "diff") or the bottom window can take without squeezing the others below their minimums. */
export function maxFor(part: "diff" | "bottom", h: Heights, mins: Mins, showDiff: boolean, showBottom: boolean): number {
  const other = part === "diff" ? (showBottom ? h.bottom : 0) : showDiff ? h.diff : 0;
  return Math.max(mins[part], h.available - mins.top - other);
}
