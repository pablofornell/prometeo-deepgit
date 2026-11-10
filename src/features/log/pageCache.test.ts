// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PageCache } from "./pageCache";

describe("PageCache", () => {
  it("stores and reads pages", () => {
    const c = new PageCache<string>(3);
    c.set(0, "a");
    expect(c.get(0)).toBe("a");
    expect(c.has(1)).toBe(false);
    expect(c.size).toBe(1);
  });

  it("evicts the least recently used page", () => {
    const c = new PageCache<string>(2);
    c.set(0, "a");
    c.set(1, "b");
    c.get(0); // 1 is now the oldest
    expect(c.set(2, "c")).toBe(1);
    expect(c.has(1)).toBe(false);
    expect(c.has(0)).toBe(true);
    expect(c.has(2)).toBe(true);
  });

  it("clear empties the cache", () => {
    const c = new PageCache<number>(2);
    c.set(0, 1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get(0)).toBeUndefined();
  });
});
