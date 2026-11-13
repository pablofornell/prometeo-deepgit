/**
 * Pure logic of the find and replace widget: the match counter, the first match to select and the seed text.
 * It does not use Solid or the DOM. `@codemirror/search` does the matching (`SearchQuery.getCursor`).
 */
import { SearchQuery } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";

/** The widget counts at most this many matches. More matches show as `9999+`. */
export const MATCH_CAP = 9999;

/** Longest selection (in characters) that becomes the text to find. */
const SEED_MAX = 1000;

export interface MatchRange {
  from: number;
  to: number;
}

export interface MatchStats {
  /** `empty`: no text to find. `invalid`: bad regular expression. `none`: no match. `some`: at least one match. */
  kind: "empty" | "invalid" | "none" | "some";
  /** Number of matches, at most `MATCH_CAP`. */
  total: number;
  /** True when there are more matches than `MATCH_CAP`. */
  capped: boolean;
  /** 1-based number of the match that is the main selection. `null` when the selection is not a match. */
  current: number | null;
}

/** The three toggles of a query. */
export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

/** The matches of a query in a document, in order. `ranges` stops at `cap`. The list is valid until the document or the query changes. */
export interface MatchList {
  kind: MatchStats["kind"];
  ranges: MatchRange[];
  /** True when there are more matches than `ranges` holds. */
  capped: boolean;
}

/** An empty list for a query that has no text to find. */
export const NO_MATCHES: MatchList = { kind: "empty", ranges: [], capped: false };

/** Finds the matches of `spec` in `state`, at most `cap`. It scans the whole document once, so cache the result. It never throws. */
export function collectMatches(state: EditorState, spec: SearchQuery, cap = MATCH_CAP): MatchList {
  if (spec.search === "") return NO_MATCHES;
  if (!spec.valid) return { kind: "invalid", ranges: [], capped: false };
  const ranges: MatchRange[] = [];
  const cursor = spec.getCursor(state);
  for (let m = cursor.next(); !m.done; m = cursor.next()) {
    if (ranges.length === cap) return { kind: "some", ranges, capped: true };
    ranges.push({ from: m.value.from, to: m.value.to });
  }
  return { kind: ranges.length === 0 ? "none" : "some", ranges, capped: false };
}

/** The counter data for a cached match list and a selection. It is cheap (a binary search), so run it on every cursor move. */
export function statsAt(list: MatchList, from: number, to: number): MatchStats {
  const { ranges } = list;
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].from < from) lo = mid + 1;
    else hi = mid;
  }
  const hit = lo < ranges.length && ranges[lo].from === from && ranges[lo].to === to;
  return { kind: list.kind, total: ranges.length, capped: list.capped, current: hit ? lo + 1 : null };
}

/** Counts the matches of `spec` in `state` and finds which one is the main selection. It never throws. */
export function matchStats(state: EditorState, spec: SearchQuery, cap = MATCH_CAP): MatchStats {
  const { from, to } = state.selection.main;
  return statsAt(collectMatches(state, spec, cap), from, to);
}

/** The text of the counter: `3 of 12`, `? of 12`, `No results`, `Invalid regex`, `3 of 9999+`, or "" for an empty query. */
export function counterText(s: MatchStats): string {
  switch (s.kind) {
    case "empty":
      return "";
    case "invalid":
      return "Invalid regex";
    case "none":
      return "No results";
    default:
      return `${s.current ?? "?"} of ${s.total}${s.capped ? "+" : ""}`;
  }
}

/** True when the find input shows the error border and the counter the error colour. */
export function isErrorState(s: MatchStats): boolean {
  return s.kind === "invalid" || s.kind === "none";
}

/** How far past the cursor the wrap-around pass looks, so a match that starts before the cursor and ends after it is found. */
const WRAP_OVERLAP = 1000;

/** The first match that starts at or after `from`. It wraps to the start of the document once. `null` when there is none. */
export function firstMatchFrom(state: EditorState, spec: SearchQuery, from: number): MatchRange | null {
  if (!spec.valid) return null;
  const tail = spec.getCursor(state, from).next();
  if (!tail.done) return { from: tail.value.from, to: tail.value.to };
  if (from === 0) return null;
  const head = spec.getCursor(state, 0, Math.min(state.doc.length, from + WRAP_OVERLAP + spec.search.length)).next();
  return head.done ? null : { from: head.value.from, to: head.value.to };
}

/** Escapes the characters of `text` that a regular expression reads as syntax. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The text of the main selection to put in the find input: one line only, not empty, not very long.
 * `null` when the selection does not qualify. In regex mode the text is escaped so that it finds itself.
 */
export function seedText(state: EditorState, regexp: boolean): string | null {
  const { from, to, empty } = state.selection.main;
  if (empty || to - from > SEED_MAX) return null;
  const text = state.sliceDoc(from, to);
  if (/[\r\n]/.test(text)) return null;
  return regexp ? escapeRegex(text) : text;
}

/**
 * A copy of `spec` with other options and/or other texts. Plain mode is literal, like VS Code: `\n`, `\t` and `\\` in the find text
 * and in the replacement are those characters. Only regex mode reads escapes.
 */
export function withQuery(spec: SearchQuery, patch: Partial<FindOptions> & { search?: string; replace?: string }): SearchQuery {
  const regexp = patch.regexp ?? spec.regexp;
  return new SearchQuery({
    search: patch.search ?? spec.search,
    replace: patch.replace ?? spec.replace,
    caseSensitive: patch.caseSensitive ?? spec.caseSensitive,
    wholeWord: patch.wholeWord ?? spec.wholeWord,
    regexp,
    literal: !regexp,
  });
}

/** A query with no text and plain (literal) mode. It starts the session. */
export function emptyQuery(): SearchQuery {
  return withQuery(new SearchQuery({ search: "" }), {});
}

/** True when both queries find and replace the same way. `SearchQuery.eq` ignores `literal`, so this checks it too. */
export function sameQuery(a: SearchQuery, b: SearchQuery): boolean {
  return a.eq(b) && a.literal === b.literal;
}
