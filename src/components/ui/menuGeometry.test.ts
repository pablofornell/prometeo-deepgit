// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inTriangle, movingToward } from "./menuGeometry";

describe("inTriangle", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  const c = { x: 0, y: 10 };
  it("accepts inner points", () => expect(inTriangle({ x: 2, y: 2 }, a, b, c)).toBe(true));
  it("rejects outer points", () => expect(inTriangle({ x: 8, y: 8 }, a, b, c)).toBe(false));
  it("works with either winding", () => expect(inTriangle({ x: 2, y: 2 }, a, c, b)).toBe(true));
});

describe("movingToward", () => {
  // Submenu to the right of its parent: near edge x = 200, rows 40..240.
  const sub = { left: 200, right: 400, top: 40, bottom: 240 };
  it("keeps the submenu while the pointer travels towards it", () => {
    expect(movingToward({ x: 150, y: 60 }, { x: 165, y: 90 }, sub)).toBe(true);
  });
  it("lets another item win when the pointer moves away", () => {
    expect(movingToward({ x: 150, y: 60 }, { x: 140, y: 120 }, sub)).toBe(false);
    expect(movingToward({ x: 150, y: 60 }, { x: 150, y: 290 }, sub)).toBe(false);
  });
  it("handles a submenu that opened to the left", () => {
    const left = { left: 0, right: 100, top: 40, bottom: 240 };
    expect(movingToward({ x: 150, y: 60 }, { x: 135, y: 90 }, left)).toBe(true);
  });
  it("is false without a previous point", () => expect(movingToward(null, { x: 1, y: 1 }, sub)).toBe(false));
});
