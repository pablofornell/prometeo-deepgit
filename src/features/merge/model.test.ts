import { describe, expect, it } from "vitest";
import { MARKER_END, MARKER_MIDDLE, MARKER_START, MergeModel, classify, linesOf, normalizeText, updateRange } from "./model";
import { mergeRanges } from "./seqDiff";

/** Builds a model from line arrays joined with "\n". */
const model = (base: string[], left: string[], right: string[]) => new MergeModel(base.join("\n"), left.join("\n"), right.join("\n"));

/** The classification of the single change between three small line lists. */
function typeOf(base: string[], left: string[], right: string[]) {
  const ranges = mergeRanges(base, left, right);
  expect(ranges).toHaveLength(1);
  const { type, leftChange, rightChange, resolvable } = classify(base, left, right, ranges[0]);
  return { type, leftChange, rightChange, resolvable };
}

describe("classification (IntelliJ getMergeType)", () => {
  const ctx = ["start"]; // keep an unchanged line before so the ranges are not at the file start

  it("base empty, one side inserted: inserted by that side", () => {
    expect(typeOf([...ctx], [...ctx, "new"], [...ctx])).toEqual({ type: "inserted", leftChange: true, rightChange: false, resolvable: false });
    expect(typeOf([...ctx], [...ctx], [...ctx, "new"])).toEqual({ type: "inserted", leftChange: false, rightChange: true, resolvable: false });
  });

  it("base empty, both inserted the same lines: inserted, not a conflict", () => {
    expect(typeOf([...ctx], [...ctx, "same"], [...ctx, "same"])).toEqual({ type: "inserted", leftChange: true, rightChange: true, resolvable: false });
  });

  it("base empty, both inserted different lines: conflict that cannot be resolved by magic", () => {
    expect(typeOf([...ctx], [...ctx, "one"], [...ctx, "two"])).toEqual({ type: "conflict", leftChange: true, rightChange: true, resolvable: false });
  });

  it("both sides deleted the lines: deleted", () => {
    expect(typeOf(["a", "b", "c"], ["a", "c"], ["a", "c"])).toEqual({ type: "deleted", leftChange: true, rightChange: true, resolvable: false });
  });

  it("one side equals the base: modified by the other side, or deleted by it", () => {
    expect(typeOf(["a", "b", "c"], ["a", "b", "c"], ["a", "B", "c"])).toEqual({ type: "modified", leftChange: false, rightChange: true, resolvable: false });
    expect(typeOf(["a", "b", "c"], ["a", "B", "c"], ["a", "b", "c"])).toEqual({ type: "modified", leftChange: true, rightChange: false, resolvable: false });
    expect(typeOf(["a", "b", "c"], ["a", "b", "c"], ["a", "c"])).toEqual({ type: "deleted", leftChange: false, rightChange: true, resolvable: false });
    expect(typeOf(["a", "b", "c"], ["a", "c"], ["a", "b", "c"])).toEqual({ type: "deleted", leftChange: true, rightChange: false, resolvable: false });
  });

  it("both sides changed the lines to the same thing: modified, not a conflict", () => {
    expect(typeOf(["a", "b", "c"], ["a", "X", "c"], ["a", "X", "c"])).toEqual({ type: "modified", leftChange: true, rightChange: true, resolvable: false });
  });

  it("both sides changed the lines differently: conflict", () => {
    expect(typeOf(["a", "x = 0", "c"], ["a", "x = 1", "c"], ["a", "x = 2", "c"])).toEqual({ type: "conflict", leftChange: true, rightChange: true, resolvable: false });
  });

  it("a conflict whose sides changed different words can be resolved by magic", () => {
    expect(typeOf(["a", "f(x, y)", "c"], ["a", "g(x, y)", "c"], ["a", "f(x, y, z)", "c"])).toEqual({ type: "conflict", leftChange: true, rightChange: true, resolvable: true });
  });

  it("modify/delete is a conflict and magic resolve never takes it", () => {
    expect(typeOf(["a", "b", "c"], ["a", "c"], ["a", "B", "c"])).toEqual({ type: "conflict", leftChange: true, rightChange: true, resolvable: false });
    expect(typeOf(["a", "b", "c"], ["a", "B", "c"], ["a", "c"])).toEqual({ type: "conflict", leftChange: true, rightChange: true, resolvable: false });
  });
});

describe("text helpers", () => {
  it("normalises CRLF only for crlf files", () => {
    expect(normalizeText("a\r\nb\r\n", "crlf")).toBe("a\nb\n");
    expect(normalizeText("a\r\nb\n", "lf")).toBe("a\r\nb\n");
  });

  it("splits like a document: a final newline is a final empty line", () => {
    expect(linesOf("a\nb\n")).toEqual(["a", "b", ""]);
    expect(linesOf("")).toEqual([""]);
  });

  it("updateRange follows IntelliJ updateRangeOnModification", () => {
    // edit before / after / inside the range
    expect(updateRange(5, 8, 8, 9, 2)).toEqual({ start: 5, end: 8, damaged: false });
    expect(updateRange(5, 8, 0, 2, 3)).toEqual({ start: 8, end: 11, damaged: false });
    expect(updateRange(5, 8, 6, 7, 1)).toEqual({ start: 5, end: 9, damaged: false });
    // the range is inside the edit, or the edit cuts one of its ends
    expect(updateRange(5, 8, 4, 10, -2)).toEqual({ start: 8, end: 8, damaged: true });
    expect(updateRange(5, 8, 7, 10, 0)).toEqual({ start: 5, end: 7, damaged: true });
    expect(updateRange(5, 8, 3, 6, 2)).toEqual({ start: 8, end: 10, damaged: true });
  });
});

describe("a model without differences", () => {
  it("has no chunks and the result is the base", () => {
    const m = new MergeModel("a\nb\n", "a\nb\n", "a\nb\n");
    expect(m.chunks).toEqual([]);
    expect(m.resultText()).toBe("a\nb\n");
    expect(m.counts()).toEqual({ conflicts: 0, changes: 0 });
    expect(m.nextUnresolved(-1)).toBe(-1);
    expect(m.resolveAutomatically()).toBe(0);
  });
});

describe("applying changes", () => {
  const base = ["one", "two", "three", "four", "five"];
  const left = ["one", "TWO", "three", "four", "five"]; // changes line 2
  const right = ["one", "two", "three", "four", "FIVE"]; // changes line 5

  it("starts with the base in the result and every chunk open", () => {
    const m = model(base, left, right);
    expect(m.resultText()).toBe(base.join("\n"));
    expect(m.chunks.map((c) => [c.type, c.leftChange, c.rightChange])).toEqual([
      ["modified", true, false],
      ["modified", false, true],
    ]);
    expect(m.counts()).toEqual({ conflicts: 0, changes: 2 });
  });

  it("applies only the left changes, or only the right ones, or all", () => {
    const l = model(base, left, right);
    expect(l.applyNonConflicting("left")).toBe(1);
    expect(l.result).toEqual(["one", "TWO", "three", "four", "five"]);
    expect(l.counts()).toEqual({ conflicts: 0, changes: 1 });

    const r = model(base, left, right);
    expect(r.applyNonConflicting("right")).toBe(1);
    expect(r.result).toEqual(["one", "two", "three", "four", "FIVE"]);

    const all = model(base, left, right);
    expect(all.applyNonConflicting("all")).toBe(2);
    expect(all.result).toEqual(["one", "TWO", "three", "four", "FIVE"]);
    expect(all.counts()).toEqual({ conflicts: 0, changes: 0 });
    expect(all.hasNonConflicting("all")).toBe(false);
  });

  it("applying a side that did not change the chunk resolves it and leaves the base", () => {
    const m = model(base, left, right);
    expect(m.applyChange(0, "right")).toBe(false);
    expect(m.isResolved(m.chunks[0])).toBe(true);
    expect(m.result).toEqual(base);
  });

  it("moves the chunks after an insertion or a deletion", () => {
    const m = model(["a", "b", "c", "d"], ["a", "x", "y", "b", "c", "d"], ["a", "b", "c"]);
    expect(m.chunks.map((c) => c.type)).toEqual(["inserted", "deleted"]);
    m.applyChange(0, "left"); // +2 lines
    expect(m.result).toEqual(["a", "x", "y", "b", "c", "d"]);
    expect(m.chunks[1].start).toBe(5);
    m.applyChange(1, "right"); // the delete of "d"
    expect(m.result).toEqual(["a", "x", "y", "b", "c"]);
  });

  it("ignoring a change keeps the base and resolves it", () => {
    const m = model(base, left, right);
    expect(m.ignoreChange(0, "left")).toBe(true);
    expect(m.isResolved(m.chunks[0])).toBe(true);
    expect(m.result).toEqual(base);
    expect(m.ignoreChange(0, "left")).toBe(false);
  });

  it("does not auto-apply a chunk whose result lines were edited", () => {
    const m = model(base, left, right);
    m.documentChanged(1, 2, 0, ["one", "my own two", "three", "four", "five"]);
    // the hand edit already resolved chunk 0
    expect(m.chunks[0].byHand).toBe(true);
    expect(m.applyNonConflicting("all")).toBe(1);
    expect(m.result).toEqual(["one", "my own two", "three", "four", "FIVE"]);
  });
});

describe("conflicts", () => {
  const base = ["a", "x = 0", "b"];
  const left = ["a", "x = 1", "b"];
  const right = ["a", "x = 2", "b"];

  it("applying one side leaves the conflict open until the other side is applied or ignored", () => {
    const m = model(base, left, right);
    expect(m.chunks[0].type).toBe("conflict");
    expect(m.counts()).toEqual({ conflicts: 1, changes: 0 });
    m.applyChange(0, "left");
    expect(m.result).toEqual(left);
    expect(m.counts()).toEqual({ conflicts: 1, changes: 0 });
    expect(m.canApply(m.chunks[0], "left")).toBe(false);
    expect(m.canApply(m.chunks[0], "right")).toBe(true);
    m.ignoreChange(0, "right");
    expect(m.counts()).toEqual({ conflicts: 0, changes: 0 });
    expect(m.result).toEqual(left);
  });

  it("applying both sides keeps Yours first, then Theirs (either click order)", () => {
    const a = model(base, left, right);
    a.applyChange(0, "left");
    a.applyChange(0, "right");
    expect(a.result).toEqual(["a", "x = 1", "x = 2", "b"]);
    expect(a.counts().conflicts).toBe(0);

    const b = model(base, left, right);
    b.applyChange(0, "right");
    b.applyChange(0, "left");
    expect(b.result).toEqual(["a", "x = 1", "x = 2", "b"]);
    expect(b.counts().conflicts).toBe(0);
  });

  it("resolve=true takes one side and closes the conflict at once", () => {
    const m = model(base, left, right);
    m.applyChange(0, "right", true);
    expect(m.result).toEqual(right);
    expect(m.counts().conflicts).toBe(0);
  });

  it("ignoring with resolve=true closes the conflict and keeps the base", () => {
    const m = model(base, left, right);
    m.ignoreChange(0, "left", true);
    expect(m.counts().conflicts).toBe(0);
    expect(m.result).toEqual(base);
  });

  it("a conflict where the other side deleted the lines is resolved by one click", () => {
    const m = model(["a", "b", "c"], ["a", "c"], ["a", "B", "c"]);
    expect(m.chunks[0].type).toBe("conflict");
    m.applyChange(0, "right"); // right has lines; left is empty -> resolved at once
    expect(m.result).toEqual(["a", "B", "c"]);
    expect(m.counts().conflicts).toBe(0);
  });

  it("applyNonConflicting never touches conflicts", () => {
    const m = model(["a", "x = 0", "b", "c"], ["a", "x = 1", "b", "C"], ["a", "x = 2", "b", "c"]);
    expect(m.applyNonConflicting("all")).toBe(1);
    expect(m.result).toEqual(["a", "x = 0", "b", "C"]);
    expect(m.counts()).toEqual({ conflicts: 1, changes: 0 });
  });

  it("navigates to the next and previous open chunk, wrapping around", () => {
    const m = model(["1", "2", "3", "4", "5", "6", "7"], ["1", "L", "3", "4", "L", "6", "7"], ["1", "R", "3", "4", "5", "6", "R"]);
    expect(m.chunks.map((c) => c.type)).toEqual(["conflict", "modified", "modified"]);
    expect(m.nextUnresolved(-1)).toBe(0);
    expect(m.nextUnresolved(0)).toBe(1);
    expect(m.nextUnresolved(2)).toBe(0);
    expect(m.nextUnresolved(0, -1)).toBe(2);
    expect(m.nextUnresolved(0, 1, true)).toBe(0); // only conflicts: wraps to itself
    m.applyChange(1, "left");
    expect(m.nextUnresolved(0)).toBe(2);
  });
});

describe("magic resolve", () => {
  it("merges a conflict where the sides changed different words", () => {
    const m = model(["a", "call(x, y)", "b"], ["a", "run(x, y)", "b"], ["a", "call(x, y, z)", "b"]);
    expect(m.chunks[0].type).toBe("conflict");
    expect(m.chunks[0].resolvable).toBe(true);
    expect(m.hasMagicResolvable()).toBe(true);
    expect(m.magicResolve(0)).toBe(true);
    expect(m.result).toEqual(["a", "run(x, y, z)", "b"]);
    expect(m.counts().conflicts).toBe(0);
  });

  it("does NOT resolve a conflict where both changed the same word", () => {
    const m = model(["a", "x = 0", "b"], ["a", "x = 1", "b"], ["a", "x = 2", "b"]);
    expect(m.magicResolve(0)).toBe(false);
    expect(m.result).toEqual(["a", "x = 0", "b"]);
    expect(m.counts().conflicts).toBe(1);
  });

  it("does NOT resolve modify/delete", () => {
    const m = model(["a", "b", "c"], ["a", "c"], ["a", "B", "c"]);
    expect(m.magicResolve(0)).toBe(false);
    expect(m.hasMagicResolvable()).toBe(false);
  });

  it("does not resolve a conflict whose result lines were edited", () => {
    const m = model(["a", "call(x, y)", "b"], ["a", "run(x, y)", "b"], ["a", "call(x, y, z)", "b"]);
    m.applyChange(0, "left"); // result changed -> not auto-resolvable any more
    expect(m.canResolveAutomatically(m.chunks[0], "all")).toBe(false);
    expect(m.magicResolve(0)).toBe(false);
  });

  it("resolveAutomatically does non-conflicting changes and magic merges, and leaves the rest", () => {
    const m = model(
      ["h", "one", "m", "f(a)", "n", "x = 0", "o", "tail"],
      ["h", "ONE", "m", "g(a)", "n", "x = 1", "o", "tail"],
      ["h", "one", "m", "f(a, b)", "n", "x = 2", "o", "TAIL"],
    );
    expect(m.chunks.map((c) => c.type)).toEqual(["modified", "conflict", "conflict", "modified"]);
    expect(m.resolveAutomatically()).toBe(3);
    expect(m.result).toEqual(["h", "ONE", "m", "g(a, b)", "n", "x = 0", "o", "TAIL"]);
    expect(m.counts()).toEqual({ conflicts: 1, changes: 0 });
    expect(m.resolveAutomatically()).toBe(0);
  });
});

describe("accept all", () => {
  it("makes the result exactly the left or the right version", () => {
    const base = ["a", "b", "c", "d", "e"];
    const left = ["a", "B", "c", "e", "tail"];
    const right = ["a", "b2", "c", "D", "e"];
    const m = model(base, left, right);
    m.applyChange(0, "right"); // some earlier work is thrown away
    m.acceptAll("left");
    expect(m.result).toEqual(left);
    expect(m.counts()).toEqual({ conflicts: 0, changes: 0 });
    m.acceptAll("right");
    expect(m.result).toEqual(right);
    expect(m.counts()).toEqual({ conflicts: 0, changes: 0 });
  });

  it("reset returns to the base with everything open", () => {
    const m = model(["a", "b"], ["a", "L"], ["a", "R"]);
    m.applyChange(0, "left", true);
    m.reset();
    expect(m.result).toEqual(["a", "b"]);
    expect(m.counts()).toEqual({ conflicts: 1, changes: 0 });
  });
});

describe("hand edits in the result", () => {
  const base = ["a", "x = 0", "b", "c", "d"];
  const left = ["a", "x = 1", "b", "c", "D"];
  const right = ["a", "x = 2", "b", "c", "d"];

  it("resolves the conflict the user edited", () => {
    const m = model(base, left, right);
    const edited = ["a", "x = 3", "b", "c", "d"];
    m.documentChanged(1, 2, 0, edited);
    expect(m.chunks[0].byHand).toBe(true);
    expect(m.counts()).toEqual({ conflicts: 0, changes: 1 });
    expect(m.result).toEqual(edited);
  });

  it("opens it again when the edit is undone", () => {
    const m = model(base, left, right);
    m.documentChanged(1, 2, 0, ["a", "x = 3", "b", "c", "d"]);
    m.documentChanged(1, 2, 0, base);
    expect(m.chunks[0].byHand).toBe(false);
    expect(m.counts().conflicts).toBe(1);
  });

  it("an edit next to a chunk does not resolve it, and later chunks move with added lines", () => {
    const m = model(base, left, right);
    // a new first line shifts both chunks
    m.documentChanged(0, 1, 1, ["new", "a", "x = 0", "b", "c", "d"]);
    expect(m.chunks.map((c) => [c.start, c.end])).toEqual([[2, 3], [5, 6]]);
    expect(m.counts()).toEqual({ conflicts: 1, changes: 1 });
    // typing at the end of line "b" (between the two chunks) touches neither
    m.documentChanged(3, 4, 0, ["new", "a", "x = 0", "bb", "c", "d"]);
    expect(m.counts()).toEqual({ conflicts: 1, changes: 1 });
  });

  it("an Enter at the end of a chunk's last line grows the chunk", () => {
    const m = model(["a", "b", "c", "d"], ["a", "B", "c", "d"], ["a", "b", "c", "D"]);
    // chunk 0 = line 1. Enter at the end of line 1: old lines [1,2), +1 line.
    m.documentChanged(1, 2, 1, ["a", "b", "", "c", "d"]);
    expect(m.chunks[0]).toMatchObject({ start: 1, end: 3 });
    expect(m.chunks[1]).toMatchObject({ start: 4, end: 5 });
  });

  it("deleting the whole region damages the chunk without crashing", () => {
    const m = model(base, left, right);
    m.documentChanged(0, 5, -3, ["a", "d"]);
    expect(m.chunks[0].start).toBeLessThanOrEqual(m.chunks[0].end);
    expect(m.result).toEqual(["a", "d"]);
  });

  it("several edits of one transaction, given last to first, move every chunk", () => {
    const m = model(["a", "b", "c", "d", "e", "f"], ["a", "B", "c", "d", "E", "f"], ["a", "b", "c", "d", "e", "f"]);
    // a replace-all style edit: one line added before chunk 0 and two lines before chunk 1
    const after = ["new", "a", "b", "c", "x", "y", "d", "e", "f"];
    m.documentEdits(
      [
        { oldLine1: 3, oldLine2: 4, shift: 2 },
        { oldLine1: 0, oldLine2: 1, shift: 1 },
      ],
      after,
    );
    expect(m.chunks.map((c) => [c.start, c.end])).toEqual([[2, 3], [7, 8]]);
    expect(m.result).toEqual(after);
  });

  it("snapshot and restore bring back the chunk state", () => {
    const m = model(base, left, right);
    const before = m.snapshot();
    const resultBefore = [...m.result];
    m.applyChange(0, "left", true);
    m.applyChange(1, "right");
    expect(m.counts()).toEqual({ conflicts: 0, changes: 0 });
    m.restore(before, resultBefore);
    expect(m.counts()).toEqual({ conflicts: 1, changes: 1 });
    expect(m.result).toEqual(base);
    expect(m.chunks[0].start).toBe(1);
  });
});

describe("saving with unresolved conflicts", () => {
  it("writes standard conflict blocks for the open conflicts only", () => {
    const m = model(["a", "x = 0", "b", "c"], ["a", "x = 1", "b", "C"], ["a", "x = 2", "b", "c"]);
    m.applyNonConflicting("all");
    expect(m.resultWithMarkers({ left: "main", right: "feature" })).toBe(
      ["a", `${MARKER_START} main`, "x = 1", MARKER_MIDDLE, "x = 2", `${MARKER_END} feature`, "b", "C"].join("\n"),
    );
  });

  it("is the plain result when nothing is open", () => {
    const m = model(["a", "x = 0"], ["a", "x = 1"], ["a", "x = 2"]);
    m.applyChange(0, "left", true);
    expect(m.resultWithMarkers({ left: "l", right: "r" })).toBe("a\nx = 1");
    expect(m.resultText()).toBe("a\nx = 1");
  });

  it("keeps a trailing newline", () => {
    const m = new MergeModel("a\nx = 0\n", "a\nx = 1\n", "a\nx = 2\n");
    expect(m.resultWithMarkers({ left: "l", right: "r" })).toBe(`a\n${MARKER_START} l\nx = 1\n${MARKER_MIDDLE}\nx = 2\n${MARKER_END} r\n`);
  });

  it("does not write markers for a conflict the user edited by hand", () => {
    const m = model(["a", "x = 0"], ["a", "x = 1"], ["a", "x = 2"]);
    m.documentChanged(1, 2, 0, ["a", "x = 9"]);
    expect(m.resultWithMarkers({ left: "l", right: "r" })).toBe("a\nx = 9");
  });
});

describe("add/add and trailing newlines", () => {
  it("an add/add conflict with an empty base is one conflict over the whole content", () => {
    const m = new MergeModel("", "x\ny\n", "x\nz\n");
    expect(m.chunks).toHaveLength(1);
    expect(m.chunks[0].type).toBe("conflict");
    expect(m.chunks[0].base).toEqual({ start: 0, end: 0 });
    m.applyChange(0, "left");
    m.applyChange(0, "right");
    expect(m.resultText()).toBe("x\ny\nx\nz\n");
  });

  it("one side losing the final newline is a change of its own", () => {
    const m = new MergeModel("a\nb\n", "a\nb", "a\nb\nc\n");
    expect(m.chunks.length).toBeGreaterThan(0);
    m.acceptAll("left");
    expect(m.resultText()).toBe("a\nb");
    m.acceptAll("right");
    expect(m.resultText()).toBe("a\nb\nc\n");
  });
});

// ---------------------------------------------------------------- random invariants

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTriple(r: () => number): { base: string[]; left: string[]; right: string[] } {
  const base = Array.from({ length: 1 + Math.floor(r() * 12) }, (_, i) => `line ${i}`);
  const mutate = (x: string[], tag: string) => {
    const y = [...x];
    const edits = Math.floor(r() * 4);
    for (let k = 0; k < edits; k++) {
      const at = Math.floor(r() * (y.length + 1));
      const roll = r();
      if (roll < 0.35) y.splice(at, Math.floor(r() * 3));
      else if (roll < 0.7) y.splice(at, 0, `${tag}${Math.floor(r() * 3)}`);
      else if (at < y.length) y[at] = `${tag}${Math.floor(r() * 3)}`;
    }
    return y;
  };
  return { base, left: mutate(base, "L"), right: mutate(base, "R") };
}

describe("invariants on random files", () => {
  it("accept left / right always give exactly that version", () => {
    const r = rng(3);
    for (let t = 0; t < 300; t++) {
      const { base, left, right } = randomTriple(r);
      const m = model(base, left, right);
      m.acceptAll("left");
      expect(m.resultText()).toBe(left.join("\n"));
      expect(m.counts()).toEqual({ conflicts: 0, changes: 0 });
      m.acceptAll("right");
      expect(m.resultText()).toBe(right.join("\n"));
    }
  });

  it("when only one side changed, applying non-conflicting gives that side", () => {
    const r = rng(5);
    for (let t = 0; t < 200; t++) {
      const { base, left } = randomTriple(r);
      const m = model(base, left, base);
      expect(m.chunks.every((c) => c.type !== "conflict")).toBe(true);
      m.applyNonConflicting("all");
      expect(m.resultText()).toBe(left.join("\n"));
      const n = model(base, base, left);
      n.applyNonConflicting("all");
      expect(n.resultText()).toBe(left.join("\n"));
      expect(n.counts()).toEqual({ conflicts: 0, changes: 0 });
    }
  });

  it("chunk ranges stay ordered and inside the result after any sequence of actions", () => {
    const r = rng(9);
    for (let t = 0; t < 300; t++) {
      const { base, left, right } = randomTriple(r);
      const m = model(base, left, right);
      for (let k = 0; k < 6; k++) {
        if (m.chunks.length === 0) break;
        const i = Math.floor(r() * m.chunks.length);
        const side = r() < 0.5 ? "left" : "right";
        const roll = r();
        if (roll < 0.5) m.applyChange(i, side);
        else if (roll < 0.7) m.ignoreChange(i, side);
        else if (roll < 0.85) m.magicResolve(i);
        else m.applyNonConflicting(side);
        let prev = 0;
        for (const c of m.chunks) {
          expect(c.start).toBeGreaterThanOrEqual(prev);
          expect(c.end).toBeGreaterThanOrEqual(c.start);
          expect(c.end).toBeLessThanOrEqual(m.result.length);
          prev = c.end;
        }
      }
      // the markers text always has balanced blocks
      const text = m.resultWithMarkers({ left: "l", right: "r" });
      expect(text.split("\n").filter((x) => x.startsWith(MARKER_START)).length).toBe(text.split("\n").filter((x) => x.startsWith(MARKER_END)).length);
    }
  });

  it("non-conflicting changes of both sides in different places merge cleanly", () => {
    const base = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const left = [...base];
    left[2] = "L2";
    left.splice(10, 1);
    const right = [...base];
    right[15] = "R15";
    right.splice(6, 0, "inserted");
    const m = model(base, left, right);
    expect(m.counts().conflicts).toBe(0);
    m.applyNonConflicting("all");
    expect(m.result).toEqual(base.map((l, i) => (i === 2 ? "L2" : i === 15 ? "R15" : l)).filter((_, i) => i !== 10).flatMap((l, i, a) => (a[i] === "line 5" ? [l, "inserted"] : [l])));
    expect(m.counts()).toEqual({ conflicts: 0, changes: 0 });
  });
});
