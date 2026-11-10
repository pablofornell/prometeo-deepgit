// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_WORD_RATIO, pairWords, tokenize, wordDiff, type Span } from "./wordDiff";

const slice = (s: string, spans: Span[]) => spans.map((x) => s.slice(x.start, x.end));

describe("tokenize", () => {
  it("splits words, whitespace and punctuation", () => {
    expect(tokenize("let a_1 = f(x);")).toEqual(["let", " ", "a_1", " ", "=", " ", "f", "(", "x", ")", ";"]);
  });
  it("keeps unicode letters together", () => {
    expect(tokenize("año nuevo")).toEqual(["año", " ", "nuevo"]);
  });
  it("is lossless", () => {
    const s = "  if (a >= 10) { return \"x\";\t}";
    expect(tokenize(s).join("")).toBe(s);
  });
});

describe("wordDiff", () => {
  it("returns nothing for equal lines", () => {
    expect(wordDiff("same", "same")).toEqual({ a: [], b: [], ratio: 0 });
  });
  it("highlights one changed word", () => {
    const o = "if req.amount > payment.captured {";
    const n = "if req.amount > payment.refundable() {";
    const r = wordDiff(o, n);
    expect(slice(o, r.a)).toEqual(["captured"]);
    expect(slice(n, r.b)).toEqual(["refundable()"]);
  });
  it("handles pure insertions on the new side", () => {
    const r = wordDiff("foo(a)", "foo(a, b)");
    expect(r.a).toEqual([]);
    expect(slice("foo(a, b)", r.b)).toEqual([", b"]);
  });
  it("handles pure deletions", () => {
    const r = wordDiff("foo(a, b)", "foo(a)");
    expect(slice("foo(a, b)", r.a)).toEqual([", b"]);
    expect(r.b).toEqual([]);
  });
  it("merges two changes separated by a single space", () => {
    const o = "alpha beta gamma";
    const n = "ALPHA BETA gamma";
    const r = wordDiff(o, n);
    expect(slice(o, r.a)).toEqual(["alpha beta"]);
    expect(slice(n, r.b)).toEqual(["ALPHA BETA"]);
  });
  it("highlights whitespace-only changes", () => {
    const r = wordDiff("a b", "a  b");
    expect(r.a).toEqual([{ start: 1, end: 2 }]);
    expect(r.b).toEqual([{ start: 1, end: 3 }]);
  });
  it("spans never overlap and stay inside the text", () => {
    const o = "const total = items.reduce((s, i) => s + i.price, 0);";
    const n = "const total = lines.map((l) => l.price).reduce((s, p) => s + p, 0n);";
    const r = wordDiff(o, n);
    for (const [text, spans] of [[o, r.a], [n, r.b]] as const) {
      let prev = 0;
      for (const s of spans) {
        expect(s.start).toBeGreaterThanOrEqual(prev);
        expect(s.end).toBeGreaterThan(s.start);
        expect(s.end).toBeLessThanOrEqual(text.length);
        prev = s.end;
      }
    }
  });
  it("falls back to prefix/suffix on huge lines without throwing", () => {
    const o = Array.from({ length: 900 }, (_, i) => "w" + i).join(" ");
    const n = Array.from({ length: 900 }, (_, i) => "x" + i).join(" ");
    expect(() => wordDiff(o, n)).not.toThrow();
  });
});

describe("pairWords", () => {
  it("gives highlights for similar lines", () => {
    expect(pairWords("let a = 1;", "let b = 1;")).not.toBeNull();
  });
  it("gives null when most of the line changed", () => {
    expect(pairWords("completely different text here", "nothing in common at all")).toBeNull();
    expect(MAX_WORD_RATIO).toBe(0.6);
  });
  it("gives null for minified lines", () => {
    expect(pairWords("a".repeat(2500), "b".repeat(2500))).toBeNull();
  });
});
