// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clampDialogOffset, reanchorClick, reanchorResized, reanchorScale } from "./dialogGeometry";

const VIEW = { width: 1440, height: 900 };
/** The Settings dialog at its natural place in a 1440 x 900 window. */
const NATURAL = { left: 200, top: 108, width: 1040, height: 700 };

describe("clampDialogOffset", () => {
  it("adds the shift to the offset the dialog has", () => {
    expect(clampDialogOffset({ x: 0, y: 0 }, { x: 4, y: -12 }, NATURAL, VIEW)).toEqual({ x: 4, y: -12 });
    expect(clampDialogOffset({ x: 4, y: -12 }, { x: 3, y: -11 }, NATURAL, VIEW)).toEqual({ x: 7, y: -23 });
  });

  it("keeps the dialog inside the window, with a margin", () => {
    // up: the top edge stops 8 px below the top of the window
    expect(clampDialogOffset({ x: 0, y: -90 }, { x: 0, y: -40 }, NATURAL, VIEW)).toEqual({ x: 0, y: -100 });
    // down and right
    expect(clampDialogOffset({ x: 0, y: 0 }, { x: 500, y: 500 }, NATURAL, VIEW)).toEqual({ x: 192, y: 84 });
    // left
    expect(clampDialogOffset({ x: 0, y: 0 }, { x: -500, y: 0 }, NATURAL, VIEW)).toEqual({ x: -192, y: 0 });
  });

  it("does not move on an axis where the dialog does not fit", () => {
    const wide = { left: 4, top: 108, width: 1436, height: 700 };
    expect(clampDialogOffset({ x: 0, y: 0 }, { x: 30, y: 10 }, wide, VIEW)).toEqual({ x: 0, y: 10 });
  });
});

describe("pending re-anchor of a zoom click", () => {
  const plus = { left: 1160, top: 322, width: 18, height: 18 };
  const minus = { left: 1100, top: 322, width: 18, height: 18 };

  it("two quick clicks before the zoom applies give one move, from the first zoom to the last", () => {
    const first = reanchorClick(null, { anchor: "plus", before: plus, pointer: { x: 1169, y: 331 }, from: 100, to: 110 });
    const second = reanchorClick(first, { anchor: "plus", before: plus, pointer: { x: 1170, y: 330 }, from: 110, to: 120 });
    expect(second).toEqual({ anchor: "plus", before: plus, pointer: { x: 1170, y: 330 }, from: 100, to: 120, resized: false });
    // one shift for 100 % -> 120 %, not one for 100 -> 110 and another for 110 -> 120
    expect(reanchorScale(second)).toBeCloseTo(100 / 120);
  });

  it("the last click wins, also on another control", () => {
    const first = reanchorClick(null, { anchor: "plus", before: plus, pointer: null, from: 100, to: 110 });
    const back = reanchorClick(first, { anchor: "minus", before: minus, pointer: { x: 1109, y: 331 }, from: 110, to: 100 });
    expect(back).toMatchObject({ anchor: "minus", before: minus, from: 100, to: 100 });
    expect(reanchorScale(back)).toBe(1);
  });

  it("a click after the resize starts a new move from the zoom the page has", () => {
    const first = reanchorResized(reanchorClick(null, { anchor: "plus", before: plus, pointer: null, from: 100, to: 110 }));
    expect(first.resized).toBe(true);
    const next = reanchorClick(first, { anchor: "plus", before: plus, pointer: null, from: 110, to: 120 });
    expect(next).toMatchObject({ from: 110, to: 120, resized: false });
    expect(reanchorScale(next)).toBeCloseTo(110 / 120);
  });
});
