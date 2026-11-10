// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cycleTab, parseQuery, prefixFor } from "./query";

describe("parseQuery", () => {
  it("uses the tab when there is no prefix", () => {
    expect(parseQuery("  fix  ", "branches")).toEqual({ scope: "branches", text: "fix", prefix: null, author: false });
  });

  it("lets a prefix override the tab", () => {
    expect(parseQuery(">fetch", "files")).toEqual({ scope: "actions", text: "fetch", prefix: ">", author: false });
    expect(parseQuery("# 9f3c", "all").scope).toBe("commits");
    expect(parseQuery("/log.ts", "all").scope).toBe("files");
    expect(parseQuery(":api", "all").scope).toBe("repos");
  });

  it("treats @ as an author search in commits", () => {
    expect(parseQuery("@lucia", "all")).toEqual({ scope: "commits", text: "lucia", prefix: "@", author: true });
  });

  it("only reads a prefix at the start", () => {
    expect(parseQuery("a>b", "all").scope).toBe("all");
  });
});

describe("cycleTab", () => {
  it("wraps in both directions", () => {
    expect(cycleTab("all", 1)).toBe("commits");
    expect(cycleTab("repos", 1)).toBe("all");
    expect(cycleTab("all", -1)).toBe("repos");
  });
});

describe("prefixFor", () => {
  it("maps scopes to their prefix", () => {
    expect(prefixFor("actions")).toBe(">");
    expect(prefixFor("all")).toBeNull();
    expect(prefixFor("branches")).toBeNull();
  });
});
