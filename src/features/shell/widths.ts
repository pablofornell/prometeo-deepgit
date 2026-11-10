/**
 * Width of the right column (Changed files / File changes) inside the centre row. The persisted value
 * (`deepgit.ui.split.details`, px) is clamped on every use, so an old or oversized value never breaks the layout.
 */
export const MIN_DETAILS = 320;
/** The main island (log, changes) never gets narrower than this when the column is dragged. */
export const MIN_MAIN = 480;
/** The main island keeps at least this much when the column is maximized. */
export const MIN_MAIN_MAXIMIZED = 200;
/** Share of the centre row the column takes when the user has not dragged it. */
export const DEFAULT_DETAILS_RATIO = 0.42;

/** Largest width the user can drag the column to. */
export function maxDetails(rowW: number, splitter: number): number {
  return Math.max(MIN_DETAILS, rowW - MIN_MAIN - splitter);
}

export function defaultDetails(rowW: number, splitter: number): number {
  return clampDetails(Math.round(rowW * DEFAULT_DETAILS_RATIO), rowW, splitter);
}

/** `w` kept between the minimum and what the main island allows; a missing or bad value gives the default. */
export function clampDetails(w: number | null | undefined, rowW: number, splitter: number): number {
  const v = typeof w === "number" && Number.isFinite(w) ? w : Math.round(rowW * DEFAULT_DETAILS_RATIO);
  return Math.round(Math.min(Math.max(v, MIN_DETAILS), maxDetails(rowW, splitter)));
}

/** Width of the maximized column: most of the row, the main island keeps a strip (never narrower than the normal width). */
export function maximizedDetails(rowW: number, splitter: number): number {
  const strip = Math.max(MIN_MAIN_MAXIMIZED, Math.round(rowW * 0.15));
  return Math.max(MIN_DETAILS, rowW - splitter - strip);
}
