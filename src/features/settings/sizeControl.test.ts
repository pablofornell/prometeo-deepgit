// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SLIDER_IDLE, type SliderEvent, type SliderState, parseNumberText, pinShift, sliderStep, snapToRange, stepBy } from "./sizeControl";

const FONT = { min: 10, max: 20, step: 1 };
const SCALE = { min: 80, max: 200, step: 10 };

/** Runs the events of one gesture and returns every value that was applied. */
function run(events: SliderEvent[], committed: number): { applied: number[]; state: SliderState } {
  let state = SLIDER_IDLE;
  let value = committed;
  const applied: number[] = [];
  for (const e of events) {
    const r = sliderStep(state, e, value);
    state = r.state;
    if (r.apply !== null) {
      applied.push(r.apply);
      value = r.apply;
    }
  }
  return { applied, state };
}

describe("number steps", () => {
  it("one step is exactly one step, inside the range", () => {
    expect(stepBy(13, 1, FONT)).toBe(14);
    expect(stepBy(13, -1, FONT)).toBe(12);
    expect(stepBy(20, 1, FONT)).toBe(20);
    expect(stepBy(10, -1, FONT)).toBe(10);
    expect(stepBy(100, 1, SCALE)).toBe(110);
    expect(stepBy(80, -1, SCALE)).toBe(80);
  });

  it("snaps to the step grid and clamps", () => {
    expect(snapToRange(14.4, FONT)).toBe(14);
    expect(snapToRange(99, FONT)).toBe(20);
    expect(snapToRange(-3, FONT)).toBe(10);
    expect(snapToRange(124, SCALE)).toBe(120);
    expect(snapToRange(126, SCALE)).toBe(130);
    expect(snapToRange(Number.NaN, FONT)).toBe(10);
    // the top of a range that is not on the grid can still be reached
    expect(snapToRange(11, { min: 0, max: 10, step: 4 })).toBe(10);
  });

  it("reads the text of the number box", () => {
    expect(parseNumberText("14")).toBe(14);
    expect(parseNumberText("  16 ")).toBe(16);
    expect(parseNumberText("12,5")).toBe(12.5);
    expect(parseNumberText("")).toBeNull();
    expect(parseNumberText("   ")).toBeNull();
    expect(parseNumberText("abc")).toBeNull();
    expect(parseNumberText("14px")).toBeNull();
  });
});

describe("slider gesture", () => {
  it("a drag previews and applies once, on release, the value at the release", () => {
    const { applied, state } = run(
      [{ type: "down" }, { type: "input", value: 14 }, { type: "input", value: 15 }, { type: "input", value: 16 }, { type: "release", value: 16 }],
      13,
    );
    expect(applied).toEqual([16]);
    expect(state).toEqual(SLIDER_IDLE);
  });

  it("shows the value under the pointer while it drags and applies nothing", () => {
    let state = sliderStep(SLIDER_IDLE, { type: "down" }, 13).state;
    for (const v of [14, 15, 18, 17]) {
      const r = sliderStep(state, { type: "input", value: v }, 13);
      expect(r.apply).toBeNull();
      expect(r.state).toEqual({ dragging: true, preview: v });
      state = r.state;
    }
  });

  it("many input events at one pointer position (the page resized under the pointer) still give one change", () => {
    const wobble: SliderEvent[] = Array.from({ length: 40 }, (_, i) => ({ type: "input", value: 14 + (i % 5) }) as SliderEvent);
    const { applied } = run([{ type: "down" }, ...wobble, { type: "release", value: 15 }], 13);
    expect(applied).toEqual([15]);
  });

  it("a second release (change, then pointerup) does nothing", () => {
    const { applied } = run([{ type: "down" }, { type: "input", value: 15 }, { type: "release", value: 15 }, { type: "release", value: 15 }, { type: "release" }], 13);
    expect(applied).toEqual([15]);
  });

  it("a release without a value uses the last preview", () => {
    expect(run([{ type: "down" }, { type: "input", value: 17 }, { type: "release" }], 13).applied).toEqual([17]);
  });

  it("a drag that ends on the old value, or a click without a move, changes nothing", () => {
    expect(run([{ type: "down" }, { type: "input", value: 15 }, { type: "input", value: 13 }, { type: "release", value: 13 }], 13).applied).toEqual([]);
    expect(run([{ type: "down" }, { type: "release" }], 13).applied).toEqual([]);
  });

  it("a cancelled drag applies nothing and clears the preview", () => {
    const { applied, state } = run([{ type: "down" }, { type: "input", value: 19 }, { type: "cancel" }, { type: "release", value: 19 }], 13);
    expect(applied).toEqual([]);
    expect(state).toEqual(SLIDER_IDLE);
  });

  it("an arrow key (input without a pointer) applies at once, one step per event", () => {
    const { applied } = run([{ type: "input", value: 14 }, { type: "release", value: 14 }, { type: "input", value: 15 }, { type: "release", value: 15 }], 13);
    expect(applied).toEqual([14, 15]);
  });

  it("an input that repeats the current value is not a change", () => {
    expect(run([{ type: "input", value: 13 }], 13).applied).toEqual([]);
  });
});

describe("pinShift", () => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

  it("moves the dialog by what the control moved, at the pointer's place on the control", () => {
    // a `+` button grew and moved down and left; the pointer was in its middle
    const before = box(1160, 322, 18, 18);
    const after = box(1157, 333, 20, 20);
    expect(pinShift(before, after, { x: 1169, y: 331 })).toEqual({ x: 2, y: -12 });
    // after the shift the middle of the button is under the pointer again
    const moved = { left: after.left + 2, top: after.top - 12 };
    expect(moved.left + 10).toBe(1169);
    expect(moved.top + 10).toBe(331);
  });

  it("keeps the pointer on the same fraction of a slider that grew", () => {
    const before = box(900, 320, 180, 18);
    const after = box(860, 340, 220, 22);
    // pointer at 25 % of the width
    const s = pinShift(before, after, { x: 945, y: 329 });
    expect(after.left + s.x + 0.25 * after.width).toBe(945);
    expect(after.top + s.y + 0.5 * after.height).toBe(329);
  });

  it("does not move for a control that stayed in place", () => {
    const b = box(100, 100, 50, 20);
    expect(pinShift(b, b, { x: 120, y: 110 })).toEqual({ x: 0, y: 0 });
  });

  it("uses the middle of the control without a pointer, and the nearest point for a pointer outside it", () => {
    const before = box(100, 100, 100, 20);
    const after = box(100, 140, 100, 20);
    expect(pinShift(before, after, null)).toEqual({ x: 0, y: -40 });
    // released far below and right of the slider: the dialog is not pulled to the pointer
    expect(pinShift(before, after, { x: 900, y: 700 })).toEqual({ x: 0, y: -40 });
  });

  it("accounts for a page zoom: the same screen point has smaller client coordinates at a larger zoom", () => {
    // zoom 100 % -> 200 %: a point at client (600, 300) is at (300, 150) afterwards
    const before = box(590, 290, 20, 20);
    const after = box(590, 290, 20, 20);
    expect(pinShift(before, after, { x: 600, y: 300 }, 100 / 200)).toEqual({ x: -300, y: -150 });
  });
});
