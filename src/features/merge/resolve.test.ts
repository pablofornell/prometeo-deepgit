import { describe, expect, it } from "vitest";
import { tryResolveText } from "./resolve";

describe("tryResolveText (magic resolve)", () => {
  it("takes the changed word of each side when they changed different words", () => {
    expect(tryResolveText("a2 b", "a b", "a b2")).toBe("a2 b2");
    expect(tryResolveText("foo(a, b, c)", "foo(a, b)", "bar(a, b)")).toBe("bar(a, b, c)");
    expect(tryResolveText("let total = price * qty;", "let total = price + qty;", "let sum = price + qty;")).toBe("let sum = price * qty;");
  });

  it("resolves a change of one side only", () => {
    expect(tryResolveText("x = 1", "x = 1", "x = 2")).toBe("x = 2");
    expect(tryResolveText("x = 2", "x = 1", "x = 1")).toBe("x = 2");
  });

  it("accepts the same change on both sides", () => {
    expect(tryResolveText("x = 2", "x = 1", "x = 2")).toBe("x = 2");
  });

  it("works across lines", () => {
    const base = "fn a() {\n    one();\n    two();\n}";
    const left = "fn a() {\n    one_changed();\n    two();\n}";
    const right = "fn a() {\n    one();\n    two_changed();\n}";
    expect(tryResolveText(left, base, right)).toBe("fn a() {\n    one_changed();\n    two_changed();\n}");
  });

  it("does NOT resolve when both sides changed the same word differently", () => {
    expect(tryResolveText("x = 1", "x = 0", "x = 2")).toBeNull();
    expect(tryResolveText("timeout: 30", "timeout: 10", "timeout: 60")).toBeNull();
  });

  it("does NOT resolve a deletion against a change of the same word", () => {
    expect(tryResolveText("call()", "call(retry)", "call(retry2)")).toBeNull();
    expect(tryResolveText("a c", "a b c", "a bb c")).toBeNull();
  });

  it("does NOT resolve two different insertions at the same place", () => {
    expect(tryResolveText("a X b", "a b", "a Y b")).toBeNull();
  });

  it("falls back to ignoring whitespace: one side only re-indented, the other changed a word", () => {
    expect(tryResolveText("a   b", "a b", "a c")).toBe("a   c");
    expect(tryResolveText("if (x) {\n    y();\n}", "if (x) {\n  y();\n}", "if (z) {\n  y();\n}")).toBe("if (z) {\n    y();\n}");
  });

  it("lets the left side win when both sides only changed the whitespace, differently (as IntelliJ does)", () => {
    expect(tryResolveText("a  b", "a b", "a   b")).toBe("a  b");
  });

  it("handles unicode words and empty text", () => {
    expect(tryResolveText("café b2", "café b", "cafés b")).toBe("cafés b2");
    expect(tryResolveText("", "", "")).toBe("");
  });
});
