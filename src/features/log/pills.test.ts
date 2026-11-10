// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RefLabel } from "../../api/types";
import { pillBudget, pillWidths, visiblePills } from "./pills";

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
});

describe("pillWidths", () => {
  it("merges a local branch with its remote", () => {
    const refs: RefLabel[] = [local("main"), { kind: "remote", name: "origin/main", isCurrent: false }, tag("v1")];
    expect(pillWidths(refs).length).toBe(2);
  });
  it("caps long names", () => {
    expect(pillWidths([local("feature/" + "x".repeat(80))])[0]).toBe(150);
  });
});
