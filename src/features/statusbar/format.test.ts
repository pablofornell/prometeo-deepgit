// @vitest-environment node
import { describe, expect, it } from "vitest";
import { middleTruncate } from "./format";

describe("middleTruncate", () => {
  it("keeps short text", () => expect(middleTruncate("git fetch", 20)).toBe("git fetch"));
  it("cuts the middle and keeps the length", () => {
    const out = middleTruncate("git push --porcelain origin refs/heads/feature/PAY-2318-refunds", 30);
    expect(out).toHaveLength(30);
    expect(out.startsWith("git push --porc")).toBe(true);
    expect(out.endsWith("PAY-2318-refunds")).toBe(false);
    expect(out).toContain("…");
  });
});
