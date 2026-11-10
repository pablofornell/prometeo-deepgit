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
