/** Pure geometry for a dialog that is moved from its natural place (no DOM). See `moveDialogBy` in `Dialog.tsx`. */

export interface DialogBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Offset {
  x: number;
  y: number;
}

/**
 * The offset of a dialog after moving it by `shift`, limited so that the dialog stays inside the window.
 * `natural` is the dialog's box at offset 0. On an axis where the dialog does not fit the offset is 0.
 */
export function clampDialogOffset(offset: Offset, shift: Offset, natural: DialogBox, viewport: { width: number; height: number }, margin = 8): Offset {
  const axis = (cur: number, by: number, start: number, size: number, room: number): number => {
    const lo = margin - start;
    const hi = room - margin - size - start;
    if (hi < lo) return 0;
    return Math.min(hi, Math.max(lo, cur + by));
  };
  return {
    x: axis(offset.x, shift.x, natural.left, natural.width, viewport.width),
    y: axis(offset.y, shift.y, natural.top, natural.height, viewport.height),
  };
}

/**
 * A dialog move that waits for a page zoom to apply (`changeInPlace` in `features/settings/widgets.tsx`): the webview
 * applies the zoom a moment after the click, and client coordinates change with it, so the move is computed on the
 * `resize` that the zoom causes. There is one at a time: a second click before the zoom applied replaces the first, so
 * the dialog moves once, from the final geometry.
 */
export interface PendingReanchor<A> {
  /** The control that must stay under the pointer. */
  anchor: A;
  /** Its box before the change, in the client coordinates of zoom `from`. */
  before: DialogBox;
  /** Where the pointer was (client coordinates of zoom `from`), or null for the middle of the control. */
  pointer: Offset | null;
  /** The zoom (percent) that `before` and `pointer` were measured at. */
  from: number;
  /** The zoom the last click asked for. */
  to: number;
  /** A `resize` came already: the page shows a zoom after `from`. */
  resized: boolean;
}

export interface ReanchorClick<A> {
  anchor: A;
  before: DialogBox;
  pointer: Offset | null;
  /** The zoom before this click, and the zoom it asks for. */
  from: number;
  to: number;
}

/**
 * The pending move after a zoom click. Before any `resize` the page is still at the zoom of the first click, so the
 * last click wins and the move goes from the first `from` to the last `to`. After a `resize` the click starts a new
 * move from the zoom the page has now.
 *
 *   click 100 -> 110, click 110 -> 120, resize   ->  one move, scale 100 / 120
 */
export function reanchorClick<A>(pending: PendingReanchor<A> | null, click: ReanchorClick<A>): PendingReanchor<A> {
  const from = pending && !pending.resized ? pending.from : click.from;
  return { anchor: click.anchor, before: click.before, pointer: click.pointer, from, to: click.to, resized: false };
}

/** `resize` came for the pending move. */
export function reanchorResized<A>(pending: PendingReanchor<A>): PendingReanchor<A> {
  return { ...pending, resized: true };
}

/** How client coordinates of a fixed screen point change from `from` to `to` (the `scale` of `pinShift`). */
export function reanchorScale(pending: PendingReanchor<unknown>): number {
  return pending.to > 0 ? pending.from / pending.to : 1;
}
