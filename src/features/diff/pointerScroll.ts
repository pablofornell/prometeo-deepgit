/**
 * Horizontal scroll by pointer position for the diff panes. Pure maths: the viewer reads the DOM and calls these.
 *
 *   const target = targetScrollLeft(e.clientX, rect.left, rect.width, pane.scrollWidth - pane.clientWidth);
 *   pane.scrollLeft = stepToward(pane.scrollLeft, target);   // once per animation frame
 */

/** Gives the 0..1 position of the pointer across a pane. The edge band at each side maps to the two ends. */
export function pointerRatio(pointerX: number, rectLeft: number, rectWidth: number, edge = 32): number {
  if (rectWidth <= 0) return 0;
  // A pane narrower than the two edge bands has no middle: use the whole width.
  const inner = rectWidth - 2 * edge;
  const raw = inner > 0 ? (pointerX - rectLeft - edge) / inner : (pointerX - rectLeft) / rectWidth;
  return Math.min(1, Math.max(0, raw));
}

/** The scroll position the pointer asks for. No overflow (`maxScroll` ≤ 0) asks for 0. */
export function targetScrollLeft(pointerX: number, rectLeft: number, rectWidth: number, maxScroll: number, edge = 32): number {
  if (!(maxScroll > 0)) return 0;
  return pointerRatio(pointerX, rectLeft, rectWidth, edge) * maxScroll;
}

/** One animation step from `current` toward `target`. Snaps to `target` when less than half a pixel away. */
export function stepToward(current: number, target: number, factor = 0.2): number {
  if (Math.abs(target - current) < 0.5) return target;
  return current + (target - current) * factor;
}
