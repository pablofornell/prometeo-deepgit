// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RefLabel } from "../../api/types";
import { pillBudget, pillMinWidths, pillSpace, pillWidths, visiblePills } from "./pills";

const local = (name: string, isCurrent = false): RefLabel => ({ kind: "local", name, isCurrent });
const tag = (name: string): RefLabel => ({ kind: "tag", name, isCurrent: false });

describe("pillBudget", () => {
  it("is 45% of a wide subject column", () => {
    expect(pillBudget(1000, 120)).toBe(450);
  });
  it("leaves the subject at least 40% / 120 px", () => {
    expect(pillBudget(300, 120)).toBe(135);
    expect(pillBudget(200, 120)).toBe(80);
    expect(pillBudget(120, 120)).toBe(0);
    expect(pillBudget(0, 120)).toBe(0);
  });
  it("never lets pills plus subject exceed the column", () => {
    for (const w of [90, 150, 240, 400, 900, 2000]) {
      const b = pillBudget(w, 120);
      expect(b).toBeLessThanOrEqual(w * 0.45 + 1e-9);
      expect(w - b).toBeGreaterThanOrEqual(Math.min(w, Math.max(120, w * 0.4)) - 1e-9);
    }
  });
});

describe("visiblePills", () => {
  it("shows everything that fits", () => {
    expect(visiblePills([60, 60], 200)).toBe(2);
    expect(visiblePills([], 0)).toBe(0);
    expect(visiblePills([150], 10)).toBe(1);
  });
  it("collapses to the pills that fit plus +N, at least the first", () => {
    expect(visiblePills([60, 60, 60], 140)).toBe(1);
    expect(visiblePills([60, 60, 60, 60], 170)).toBe(2);
    expect(visiblePills([150, 150], 50)).toBe(1);
  });
  it("keeps room for the +N chip (26 px with its gap) and no more", () => {
    // 60 + 26 fits in 86, not in 85
    expect(visiblePills([60, 60], 86 - 1)).toBe(1);
    expect(visiblePills([60, 60, 60], 60 + 4 + 60 + 26)).toBe(2);
    expect(visiblePills([60, 60, 60], 60 + 4 + 60 + 26 - 1)).toBe(1);
  });
  it("shows a pill only when its minimum width fits", () => {
    // natural 150 + 150 do not fit in 120, but both fit at 40 + 4 + 40 and shrink
    expect(visiblePills([150, 150], 120, [40, 40])).toBe(2);
    // three pills: 40 + 4 + 40 + 4 + 40 = 128 > 100: show the pills whose minimum fits with the chip
    expect(visiblePills([150, 150, 150], 100, [40, 40, 40])).toBe(1);
    expect(visiblePills([150, 150, 150], 110, [40, 40, 40])).toBe(2);
  });
  it("never hides a split HEAD pill that fits at its minimum before a pill behind it", () => {
    // split HEAD: min 90 (42 + 48). With the chip it needs 116.
    expect(visiblePills([200, 100, 100], 116, [90, 40, 40])).toBe(1);
    expect(visiblePills([200, 100, 100], 116 + 44, [90, 40, 40])).toBe(2);
  });
});

describe("pillSpace", () => {
  it("is the budget when the first pill and the chip fit in it", () => {
    expect(pillSpace(200, [90, 40, 40])).toBe(200);
  });
  it("grows to the first pill at its minimum plus the chip when the budget is smaller", () => {
    expect(pillSpace(60, [90, 40, 40])).toBe(90 + 26);
    expect(pillSpace(0, [90])).toBe(90);
    expect(pillSpace(50, [])).toBe(0);
  });
});

describe("pillWidths", () => {
  it("merges a local branch with its remote", () => {
    const refs: RefLabel[] = [local("main"), { kind: "remote", name: "origin/main", isCurrent: false }, tag("v1")];
    expect(pillWidths(refs).length).toBe(2);
  });
  it("gives the split HEAD pill HEAD + 48 px as minimum and an ordinary pill 40 px", () => {
    const refs: RefLabel[] = [local("feature/PAY-2318-refunds", true), local("develop"), tag("v1")];
    expect(pillMinWidths(refs)).toEqual([90, 40, 40]);
    expect(pillWidths(refs)[0]).toBe(212);
    expect(pillWidths([local("feature/" + "x".repeat(80), true)])[0]).toBe(220);
  });
  it("keeps a plain HEAD pill at its natural width", () => {
    const refs: RefLabel[] = [{ kind: "head", name: "HEAD", isCurrent: true }, local("develop")];
    const [w] = pillWidths(refs);
    expect(pillMinWidths(refs)[0]).toBe(w);
  });
  it("caps long names", () => {
    expect(pillWidths([local("feature/" + "x".repeat(80))])[0]).toBe(150);
  });
});
