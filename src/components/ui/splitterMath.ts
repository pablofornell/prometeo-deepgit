/** Size arithmetic of the `Splitter`, kept apart from the component so it can be unit tested. */

/**
 * `size` kept between `min` and `max` (both optional), rounded to whole px. When the limits cross (a layout-dependent
 * `max` below `min` in a small window) the minimum wins.
 */
export function clampSize(size: number, min?: number, max?: number): number {
  let v = size;
  if (max !== undefined) v = Math.min(v, max);
  return Math.round(Math.max(v, min ?? 0));
}

/**
 * New size of the pane after the pointer moved `delta` px (positive = towards the end of the axis) since the drag began.
 * The size the drag began from is clamped first: a pane that is outside the limits when the drag starts (the maximized
 * column, a window that shrank) would otherwise keep that size until the pointer had travelled back across the whole excess.
 */
export function dragSize(startSize: number, delta: number, reverse: boolean, min?: number, max?: number): number {
  return clampSize(clampSize(startSize, min, max) + (reverse ? -delta : delta), min, max);
}
