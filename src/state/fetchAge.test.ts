// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ageFraction, ageLevel, describeFetchAge, formatAge } from "./fetchAge";

describe("fetch age", () => {
  it("scales to 2 hours and treats never as full", () => {
    expect(ageFraction(0)).toBe(0);
    expect(ageFraction(60)).toBe(0.5);
    expect(ageFraction(500)).toBe(1);
    expect(ageFraction(null)).toBe(1);
  });
  it("picks the level", () => {
    expect(ageLevel(14)).toBe("fresh");
    expect(ageLevel(15)).toBe("aging");
    expect(ageLevel(120)).toBe("aging");
    expect(ageLevel(121)).toBe("stale");
    expect(ageLevel(null)).toBe("stale");
  });
  it("formats", () => {
    expect(formatAge(0.2)).toBe("just now");
    expect(formatAge(4)).toBe("4 min ago");
    expect(formatAge(180)).toBe("3 h ago");
  });
  it("describes the oldest repo", () => {
    const now = 10_000_000;
    const d = describeFetchAge([{ name: "a", at: now - 4 * 60000 }, { name: "docs-site", at: now - 30 * 60000 }], now);
    expect(d.text).toBe("Fetched 30 min ago");
    expect(d.level).toBe("aging");
    expect(d.tooltip).toBe("Last fetch 4 min ago. Oldest: docs-site, 30 min ago.");
    expect(describeFetchAge([{ name: "a", at: null }], now).text).toBe("Not fetched yet");
  });
});
