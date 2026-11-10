// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clampDialogOffset } from "./dialogGeometry";

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
