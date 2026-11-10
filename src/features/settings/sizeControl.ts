/**
 * Pure logic of the size controls of the Settings pages (`widgets.tsx`): number steps, the slider gesture and the
 * "stay under the pointer" geometry. No DOM, so it is tested under node.
 *
 * Why it exists: a size setting (font size, UI scale) resizes the page, so the control moves under a pressed pointer.
 * A slider that applies its value while it moves then reads a new value from the same pointer position, applies it,
 * moves again, and so on. The rules here make one user action give exactly one change:
 *  - a pointer drag only previews; the value is applied once, on release (`sliderStep`);
 *  - a `-` / `+` click is one step (`stepBy`), and there is no press-and-hold repeat;
 *  - after the change the dialog is moved so that the control is still under the pointer (`pinShift`).
 */

export interface NumberRange {
  min: number;
  max: number;
  step: number;
}

/** `value` inside the range, on the step grid that starts at `min`. Not a finite number: `min`. */
export function snapToRange(value: number, r: NumberRange): number {
  if (!Number.isFinite(value)) return r.min;
  const step = r.step > 0 ? r.step : 1;
  const snapped = r.min + Math.round((value - r.min) / step) * step;
  // the top of the range is always reachable, also when it is not on the grid
  const top = value >= r.max ? r.max : snapped;
  return Math.min(r.max, Math.max(r.min, top));
}

/** One step up or down from `value`, kept inside the range. */
export function stepBy(value: number, dir: 1 | -1, r: NumberRange): number {
  return snapToRange(value + dir * (r.step > 0 ? r.step : 1), r);
}

/** The number in a text box ("14", " 14 ", "12,5"), or null when the text is empty or not a number. */
export function parseNumberText(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- slider gesture

export interface SliderState {
  /** A pointer is down on the slider. */
  dragging: boolean;
  /** The value under the pointer, shown but not applied; null when there is no drag. */
  preview: number | null;
}

export const SLIDER_IDLE: SliderState = { dragging: false, preview: null };

export type SliderEvent =
  /** Pointer pressed on the slider. */
  | { type: "down" }
  /** The slider reports a value (pointer move, or an arrow key when no pointer is down). */
  | { type: "input"; value: number }
  /** Pointer released (`change`, `pointerup`). `value` is the slider value at that moment, when known. */
  | { type: "release"; value?: number }
  /** The drag ended without a release on the slider (`pointercancel`): nothing is applied. */
  | { type: "cancel" };

export interface SliderStepResult {
  state: SliderState;
  /** The value to apply now, or null. At most one per gesture. */
  apply: number | null;
}

/**
 * The slider state machine. `committed` is the value the setting has now.
 *
 *   down, input 14, input 15, input 16, release   ->  apply 16 once (on release)
 *   input 14 (no pointer down: an arrow key)        ->  apply 14 at once
 *   release, release (change + pointerup)           ->  the second one does nothing
 */
export function sliderStep(state: SliderState, event: SliderEvent, committed: number): SliderStepResult {
  switch (event.type) {
    case "down":
      return { state: { dragging: true, preview: state.preview }, apply: null };
    case "input":
      if (state.dragging) return { state: { dragging: true, preview: event.value }, apply: null };
      return { state: SLIDER_IDLE, apply: event.value === committed ? null : event.value };
    case "release": {
      if (!state.dragging) return { state: SLIDER_IDLE, apply: null };
      const value = event.value ?? state.preview;
      return { state: SLIDER_IDLE, apply: value === null || value === committed ? null : value };
    }
    case "cancel":
      return { state: SLIDER_IDLE, apply: null };
  }
}

// ---------------------------------------------------------------- stay under the pointer

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * How far to move the dialog so that the control is under the pointer again after a change that resized the page.
 * `before` / `after` are the control's boxes around the change, `pointer` is where the pointer was (null: the middle of
 * the control; a pointer outside the control counts as the nearest point of it, so a drag that ended away from the
 * slider does not pull the dialog over). That point keeps its relative place on the control (the same fraction of its
 * width and height).
 *
 * `scale` is how client coordinates of a fixed screen point change with the change: 1 for a font size, and
 * `old zoom / new zoom` for a page zoom (the same screen pixel is fewer CSS px at a larger zoom).
 */
export function pinShift(before: Box, after: Box, pointer: Point | null, scale = 1): Point {
  const within = (v: number, start: number, size: number) => Math.min(start + size, Math.max(start, v));
  const p = pointer
    ? { x: within(pointer.x, before.left, before.width), y: within(pointer.y, before.top, before.height) }
    : { x: before.left + before.width / 2, y: before.top + before.height / 2 };
  const fx = before.width > 0 ? (p.x - before.left) / before.width : 0.5;
  const fy = before.height > 0 ? (p.y - before.top) / before.height : 0.5;
  return {
    x: Math.round(p.x * scale - (after.left + fx * after.width)),
    y: Math.round(p.y * scale - (after.top + fy * after.height)),
  };
}
