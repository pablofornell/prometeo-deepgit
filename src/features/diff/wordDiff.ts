/**
 * Intra-line ("word") diff: LCS over tokens split on word boundaries. Pure, no DOM.
 *
 *   const r = wordDiff("let a = 1;", "let b = 1;");   // r.a = [{start: 4, end: 5}], r.b = [{start: 4, end: 5}]
 */

/** Half-open range of UTF-16 offsets inside a line. */
export interface Span {
  start: number;
  end: number;
}

export interface WordDiffResult {
  /** Changed ranges of the old text. */
  a: Span[];
  /** Changed ranges of the new text. */
  b: Span[];
  /** Share of the longer line that changed (0..1). */
  ratio: number;
}

/** Above this share of the line changed, the line is coloured as a whole and no words are highlighted. */
export const MAX_WORD_RATIO = 0.6;
/** Lines longer than this skip the word diff (minified files). */
export const MAX_WORD_LINE = 2000;
/** DP budget (token pairs). Beyond it only the common prefix and suffix are trimmed. */
const MAX_CELLS = 250_000;

const TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** Splits a line into whitespace runs, words (letters, digits, `_`) and single punctuation characters. */
export function tokenize(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

const isBlank = (t: string) => /^\s+$/.test(t);

/** Merges touching spans, and spans separated only by one whitespace token. */
function mergeSpans(spans: Span[], tokens: string[], offsets: number[]): Span[] {
  if (spans.length < 2) return spans;
  const out: Span[] = [{ ...spans[0] }];
  for (let k = 1; k < spans.length; k++) {
    const last = out[out.length - 1];
    const cur = spans[k];
    let join = cur.start <= last.end;
    if (!join) {
      // the gap is exactly one blank token
      const ti = offsets.indexOf(last.end);
      join = ti >= 0 && isBlank(tokens[ti] ?? "") && offsets[ti + 1] === cur.start;
    }
    if (join) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

function offsetsOf(tokens: string[]): number[] {
  const out: number[] = [0];
  let n = 0;
  for (const t of tokens) {
    n += t.length;
    out.push(n);
  }
  return out;
}

/** Token-level LCS diff of two lines. */
export function wordDiff(oldText: string, newText: string): WordDiffResult {
  if (oldText === newText) return { a: [], b: [], ratio: 0 };
  const ta = tokenize(oldText);
  const tb = tokenize(newText);
  const oa = offsetsOf(ta);
  const ob = offsetsOf(tb);

  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
  let suf = 0;
  while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]) suf++;
  const n = ta.length - pre - suf;
  const m = tb.length - pre - suf;

  const keepA = new Uint8Array(ta.length);
  const keepB = new Uint8Array(tb.length);
  for (let i = 0; i < pre; i++) {
    keepA[i] = 1;
    keepB[i] = 1;
  }
  for (let i = 0; i < suf; i++) {
    keepA[ta.length - 1 - i] = 1;
    keepB[tb.length - 1 - i] = 1;
  }

  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_CELLS) {
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = ta[pre + i] === tb[pre + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ta[pre + i] === tb[pre + j]) {
        keepA[pre + i] = 1;
        keepB[pre + j] = 1;
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }

  const spansOf = (tokens: string[], keep: Uint8Array, offsets: number[]): Span[] => {
    const raw: Span[] = [];
    for (let k = 0; k < tokens.length; k++) {
      if (keep[k]) continue;
      const last = raw[raw.length - 1];
      if (last && last.end === offsets[k]) last.end = offsets[k + 1];
      else raw.push({ start: offsets[k], end: offsets[k + 1] });
    }
    return mergeSpans(raw, tokens, offsets);
  };

  const a = spansOf(ta, keepA, oa);
  const b = spansOf(tb, keepB, ob);
  const size = (s: Span[]) => s.reduce((t, x) => t + (x.end - x.start), 0);
  const ratio = Math.max(oldText.length ? size(a) / oldText.length : 0, newText.length ? size(b) / newText.length : 0);
  return { a, b, ratio };
}

/** Word highlights for a pair of lines, or `null` when the lines differ too much (colour the line only). */
export function pairWords(oldText: string, newText: string): { a: Span[]; b: Span[] } | null {
  if (oldText.length > MAX_WORD_LINE || newText.length > MAX_WORD_LINE) return null;
  const r = wordDiff(oldText, newText);
  if (r.ratio > MAX_WORD_RATIO) return null;
  return { a: r.a, b: r.b };
}
