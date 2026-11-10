// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hunkHash } from "./hunkHash";

describe("hunkHash", () => {
  it("matches the shared test vector (FNV-1a 32 over ' a\\n-b\\n+c\\n', computed with Python)", () => {
    expect(
      hunkHash([
        { kind: "context", text: "a" },
        { kind: "del", text: "b" },
        { kind: "add", text: "c" },
      ]),
    ).toBe("ca8967d5");
  });
  it("hashes the UTF-8 bytes, not UTF-16 units", () => {
    // python: same loop over ' é\n'.encode()
    expect(hunkHash([{ kind: "context", text: "é" }])).toBe("e8a06597");
  });
  it("is the FNV offset basis for no lines and always 8 hex chars", () => {
    expect(hunkHash([])).toBe("811c9dc5");
    expect(hunkHash([{ kind: "add", text: "x" }])).toMatch(/^[0-9a-f]{8}$/);
  });
  it("distinguishes the line kind and the line order", () => {
    const a = { kind: "add", text: "x" } as const;
    const d = { kind: "del", text: "x" } as const;
    expect(hunkHash([a])).not.toBe(hunkHash([d]));
    expect(hunkHash([a, d])).not.toBe(hunkHash([d, a]));
  });
});
