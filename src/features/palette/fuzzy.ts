/**
 * Pure fuzzy matching for the palette (DESIGN.md 5.15).
 *
 *   fuzzyMatch("nwbr", "New branch")  ->  { score, positions: [0, 2, 4, 5] }  (null when it does not match)
 *   fuzzyMatchPath("ctrl", "src/features/log/LogController.ts")  -> matches inside the file name win
 *   segments("New branch", [0, 4])    ->  [{ text: "N", match: true }, { text: "ew ", match: false }, ...]
 *
 * Case-insensitive subsequence match. Several words separated by spaces must all match (in any order).
 * The score rewards consecutive characters, word starts (after space, `/`, `-`, `_`, `.`, or a camelCase hump)
 * and an early first match; gaps cost a little.
 */

export interface FuzzyResult {
  /** Higher is better. Comparable only between results of the same query. */
  score: number;
  /** Indexes in the target of the matched characters, ascending. */
  positions: number[];
}

const BONUS_START = 8;
const BONUS_BOUNDARY = 7;
const BONUS_CAMEL = 5;
const BONUS_CONSECUTIVE = 6;
const BASE = 4;
const GAP = 1;
const LEAD = 0.5;
const MAX_LEAD = 6;
const NEG = Number.NEGATIVE_INFINITY;

const isBoundaryChar = (c: string): boolean => c === " " || c === "/" || c === "-" || c === "_" || c === "." || c === ":" || c === "\\";
const isUpper = (c: string): boolean => c !== c.toLowerCase();
const isLower = (c: string): boolean => c !== c.toUpperCase();

function bonusAt(t: string, j: number): number {
  if (j === 0) return BONUS_START;
  const prev = t[j - 1];
  if (isBoundaryChar(prev)) return BONUS_BOUNDARY;
  if (isUpper(t[j]) && isLower(prev)) return BONUS_CAMEL;
  return 0;
}

/** Best alignment of one word (no spaces) inside `target`; null when it is not a subsequence. */
function matchWord(word: string, target: string): FuzzyResult | null {
  const q = word.toLowerCase();
  const tl = target.toLowerCase();
  const n = q.length;
  const m = target.length;
  if (n === 0) return { score: 0, positions: [] };
  if (n > m) return null;
  // quick reject: is it a subsequence at all?
  let qi = 0;
  for (let j = 0; j < m && qi < n; j++) if (tl[j] === q[qi]) qi++;
  if (qi < n) return null;

  // dp[i][j]: best score with q[i] matched at target[j]; from[i][j]: where q[i-1] was matched.
  const dp: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    dp.push(new Float64Array(m).fill(NEG));
    from.push(new Int32Array(m).fill(-1));
  }
  for (let j = 0; j < m; j++) {
    if (tl[j] === q[0]) dp[0][j] = BASE + bonusAt(target, j) - Math.min(j, MAX_LEAD) * LEAD;
  }
  for (let i = 1; i < n; i++) {
    // best (dp[i-1][k] - GAP * (j - k - 1)) over k < j - 1, maintained as j grows
    let run = NEG;
    let runK = -1;
    for (let j = i; j < m; j++) {
      const k = j - 2;
      if (k >= 0 && dp[i - 1][k] > NEG) {
        if (run > NEG) run -= GAP;
        if (dp[i - 1][k] >= run) {
          run = dp[i - 1][k];
          runK = k;
        }
      } else if (run > NEG) run -= GAP;
      if (tl[j] !== q[i]) continue;
      const here = BASE + bonusAt(target, j);
      let best = NEG;
      let bestK = -1;
      const adj = dp[i - 1][j - 1];
      if (adj > NEG) {
        best = adj + here + BONUS_CONSECUTIVE;
        bestK = j - 1;
      }
      if (run > NEG && run + here > best) {
        best = run + here;
        bestK = runK;
      }
      if (best > NEG) {
        dp[i][j] = best;
        from[i][j] = bestK;
      }
    }
  }
  let bestJ = -1;
  let best = NEG;
  for (let j = 0; j < m; j++) {
    // a slightly shorter target wins ties: it is a tighter match
    const s = dp[n - 1][j];
    if (s > best) {
      best = s;
      bestJ = j;
    }
  }
  if (bestJ < 0) return null;
  const positions: number[] = new Array<number>(n);
  let j = bestJ;
  for (let i = n - 1; i >= 0; i--) {
    positions[i] = j;
    j = from[i][j];
  }
  return { score: best - m * 0.02, positions };
}

/** Matches `query` (one or more words) against `target`. Empty query matches everything with score 0. */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, positions: [] };
  let score = 0;
  const set = new Set<number>();
  for (const w of words) {
    const r = matchWord(w, target);
    if (!r) return null;
    score += r.score;
    for (const p of r.positions) set.add(p);
  }
  return { score, positions: [...set].sort((a, b) => a - b) };
}

/**
 * Like `fuzzyMatch` for file paths: when the query also matches the file name on its own, that match
 * wins (with a bonus) and its positions are shifted into the full path.
 */
export function fuzzyMatchPath(query: string, path: string): FuzzyResult | null {
  const whole = fuzzyMatch(query, path);
  if (!whole) return null;
  const slash = path.lastIndexOf("/");
  if (slash < 0 || query.trim() === "") return whole;
  const base = path.slice(slash + 1);
  const inBase = fuzzyMatch(query, base);
  if (!inBase) return whole;
  return { score: inBase.score + 12, positions: inBase.positions.map((p) => p + slash + 1) };
}

export interface Segment {
  text: string;
  match: boolean;
}

/** Splits `text` into runs of matched / unmatched characters, for highlighting. */
export function segments(text: string, positions: readonly number[]): Segment[] {
  if (positions.length === 0) return [{ text, match: false }];
  const hit = new Set(positions);
  const out: Segment[] = [];
  let cur = "";
  let curMatch = false;
  for (let i = 0; i < text.length; i++) {
    const m = hit.has(i);
    if (i > 0 && m !== curMatch) {
      out.push({ text: cur, match: curMatch });
      cur = "";
    }
    cur += text[i];
    curMatch = m;
  }
  if (cur) out.push({ text: cur, match: curMatch });
  return out;
}

/** Positions of a plain case-insensitive substring (used to highlight commit search hits). */
export function substringPositions(query: string, target: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const i = target.toLowerCase().indexOf(q);
  return i < 0 ? [] : Array.from({ length: q.length }, (_, k) => i + k);
}
