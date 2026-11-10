/**
 * "Magic resolve": merges a conflict at word level when the two sides changed different words
 * (IntelliJ `MergeResolveUtil.SimpleHelper`). Pure, no DOM.
 *
 *   tryResolveText("a b2", "a b", "a2 b")   // "a2 b2"
 *   tryResolveText("x = 1", "x = 0", "x = 2") // null: both sides changed the same word
 *
 * The three texts are split into tokens (words, single punctuation marks, whitespace runs, newlines) and diffed
 * base-versus-left and base-versus-right. Where the changed token ranges do not overlap, each side's change is
 * taken. It is tried twice, exactly and then ignoring whitespace; a side that only changed whitespace loses to
 * the side that changed words. A range changed differently by both sides, or deleted by one side and changed by
 * the other, makes the whole resolve fail (`null`).
 */
import { intern, mergeRanges } from "./seqDiff";

interface Tok {
  text: string;
  start: number;
  end: number;
}

const TOKEN_RE = /\n|[^\S\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

const isBlank = (t: Tok) => /^\s+$/.test(t.text);
const stripWs = (s: string) => s.replace(/\s+/g, "");

/** Character ranges of one region in `[left, base, right]` order. */
type Range3 = [[number, number], [number, number], [number, number]];
type Side3 = 0 | 1 | 2;

interface WordType {
  conflict: boolean;
  left: boolean;
  right: boolean;
}

function trySimple(left: string, base: string, right: string, ignoreWs: boolean): string | null {
  const texts = [left, base, right];
  const toks = texts.map((t) => {
    const all = tokenize(t);
    return ignoreWs ? all.filter((x) => !isBlank(x)) : all;
  });
  const [l, b, r] = intern(...toks.map((ts) => ts.map((t) => t.text)));
  const merged = mergeRanges(b, l, r);

  /** Character offset of token `i` of text `t` (the end of the text past the last token). */
  const at = (t: Side3, i: number) => (i < toks[t].length ? toks[t][i].start : texts[t].length);
  const sliceOf = (t: Side3, range: Range3) => texts[t].slice(range[t][0], range[t][1]);
  const between = (from: number[], to: number[]): Range3 => [
    [from[0], to[0]],
    [from[1], to[1]],
    [from[2], to[2]],
  ];

  /** The merge type of a character range under a policy (IntelliJ `getWordMergeType`). */
  const typeOf = (range: Range3, ignore: boolean): WordType => {
    const empty = (t: Side3) => range[t][0] === range[t][1];
    const same = (x: Side3, y: Side3) =>
      ignore ? stripWs(sliceOf(x, range)) === stripWs(sliceOf(y, range)) : sliceOf(x, range) === sliceOf(y, range);
    if (empty(1)) {
      if (empty(0)) return { conflict: false, left: false, right: true };
      if (empty(2)) return { conflict: false, left: true, right: false };
      return same(0, 2) ? { conflict: false, left: true, right: true } : { conflict: true, left: true, right: true };
    }
    if (empty(0) && empty(2)) return { conflict: false, left: true, right: true };
    const unchangedLeft = same(1, 0);
    const unchangedRight = same(1, 2);
    if (unchangedLeft && unchangedRight) return { conflict: false, left: false, right: false };
    if (unchangedLeft) return { conflict: false, left: false, right: true };
    if (unchangedRight) return { conflict: false, left: true, right: false };
    if (same(0, 2)) return { conflict: false, left: true, right: true };
    return { conflict: true, left: true, right: true };
  };

  let out = "";
  /** The text between two changes: the base unless only one side changed it (whitespace, when ignored). */
  const appendGap = (range: Range3) => {
    if (range.every((x) => x[0] === x[1])) return;
    const baseText = sliceOf(1, range);
    if (baseText === sliceOf(0, range) && baseText === sliceOf(2, range)) {
      out += baseText;
      return;
    }
    const type = typeOf(range, false);
    out += sliceOf(type.left ? 0 : type.right ? 2 : 1, range);
  };

  let from = [0, 0, 0];
  for (const m of merged) {
    const start = [at(0, m.left[0]), at(1, m.base[0]), at(2, m.right[0])];
    appendGap(between(from, start));
    const end = [at(0, m.left[1]), at(1, m.base[1]), at(2, m.right[1])];
    const range = between(start, end);
    const type = typeOf(range, ignoreWs);
    if (type.conflict) return null;
    out += sliceOf(type.left ? 0 : 2, range);
    from = end;
  }
  appendGap(between(from, [left.length, base.length, right.length]));
  return out;
}

/** The merged text, or `null` when the two sides changed the same words differently. */
export function tryResolveText(left: string, base: string, right: string): string | null {
  return trySimple(left, base, right, false) ?? trySimple(left, base, right, true);
}
