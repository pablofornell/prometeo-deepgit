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

/** Counts the matches of `spec` in `state` and finds which one is the main selection. It never throws. */
export function matchStats(state: EditorState, spec: SearchQuery, cap = MATCH_CAP): MatchStats {
  if (spec.search === "") return { kind: "empty", total: 0, capped: false, current: null };
  if (!spec.valid) return { kind: "invalid", total: 0, capped: false, current: null };
  const { from, to } = state.selection.main;
  let total = 0;
  let current: number | null = null;
  const cursor = spec.getCursor(state);
  for (let m = cursor.next(); !m.done; m = cursor.next()) {
    if (total === cap) return { kind: "some", total, capped: true, current };
    total++;
    if (current === null && m.value.from === from && m.value.to === to) current = total;
  }
  return { kind: total === 0 ? "none" : "some", total, capped: false, current };
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

/** The first match that starts at or after `from`. It wraps to the start of the document. `null` when there is none. */
export function firstMatchFrom(state: EditorState, spec: SearchQuery, from: number): MatchRange | null {
  if (!spec.valid) return null;
  for (const start of from > 0 ? [from, 0] : [0]) {
    const m = spec.getCursor(state, start).next();
    if (!m.done) return { from: m.value.from, to: m.value.to };
  }
  return null;
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

/** A copy of `spec` with other options and/or other texts. */
export function withQuery(spec: SearchQuery, patch: Partial<FindOptions> & { search?: string; replace?: string }): SearchQuery {
  return new SearchQuery({
    search: patch.search ?? spec.search,
    replace: patch.replace ?? spec.replace,
    caseSensitive: patch.caseSensitive ?? spec.caseSensitive,
    wholeWord: patch.wholeWord ?? spec.wholeWord,
    regexp: patch.regexp ?? spec.regexp,
  });
}
