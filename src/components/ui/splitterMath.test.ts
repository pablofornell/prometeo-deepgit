// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clampSize, dragSize } from "./splitterMath";

describe("clampSize", () => {
  it("keeps the size between the limits and rounds it", () => {
    expect(clampSize(400, 320, 700)).toBe(400);
    expect(clampSize(100, 320, 700)).toBe(320);
    expect(clampSize(900, 320, 700)).toBe(700);
    expect(clampSize(400.6, 320, 700)).toBe(401);
  });
  it("accepts missing limits", () => {
    expect(clampSize(-5)).toBe(0);
    expect(clampSize(5000, 10)).toBe(5000);
    expect(clampSize(5000, undefined, 300)).toBe(300);
  });
  it("lets the minimum win when the limits cross", () => {
    expect(clampSize(500, 320, 200)).toBe(320);
  });
});

describe("dragSize", () => {
  it("grows a reversed pane (right of its bar) when the pointer moves left", () => {
    expect(dragSize(500, -40, true, 320, 700)).toBe(540);
    expect(dragSize(500, 40, true, 320, 700)).toBe(460);
  });
  it("grows a normal pane when the pointer moves right", () => {
    expect(dragSize(280, 20, false, 200, 480)).toBe(300);
  });
  it("stops at both limits, however far the pointer goes", () => {
    expect(dragSize(500, -5000, true, 320, 700)).toBe(700);
    expect(dragSize(500, 5000, true, 320, 700)).toBe(320);
  });
  it("starts from the clamped size when the pane is beyond the maximum", () => {
    // maximized column (1157 px) with a drag limit of 882: moving the pointer back by 20 px gives 862, not a dead zone at 882
    expect(dragSize(1157, 20, true, 320, 882)).toBe(862);
    expect(dragSize(1157, -20, true, 320, 882)).toBe(882);
  });
  it("starts from the clamped size when the pane is below the minimum", () => {
    expect(dragSize(100, -30, true, 320, 882)).toBe(350);
  });
});
