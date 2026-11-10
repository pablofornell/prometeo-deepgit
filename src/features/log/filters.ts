/**
 * State of the filter bar. Module-level signals: the log is mounted once for the whole session of the app.
 * `query()` is what the log session opens; it only changes when a filter value changes.
 */
import { createMemo, createRoot, createSignal } from "solid-js";
import type { LogQuery } from "../../api/types";
import { isRepoFilterActive, projectRepos, selectAllRepos, selectedRepoIds } from "../../state/workspace";
import { type DatePreset, EMPTY_FILTERS, type FilterValues, buildQuery, parseTextFilter } from "./query";

const [textInput, setTextInput] = createSignal("");
const [text, setText] = createSignal("");
const [refs, setRefs] = createSignal<string[]>([]);
const [author, setAuthor] = createSignal("");
const [since, setSince] = createSignal<number | null>(null);
const [until, setUntil] = createSignal<number | null>(null);
const [datePreset, setDatePreset] = createSignal<DatePreset | null>(null);
const [path, setPath] = createSignal("");

export { textInput, text, refs, author, since, until, datePreset, path };
export { setRefs, setAuthor, setPath };

let debounce: ReturnType<typeof setTimeout> | undefined;

/** Typing in the text box: the box updates now, the query 250 ms after the last key. */
export function typeText(value: string): void {
  setTextInput(value);
  clearTimeout(debounce);
  debounce = setTimeout(() => setText(value), 250);
}

/** Applies the text now (Enter). */
export function commitText(): void {
  clearTimeout(debounce);
  setText(textInput());
}

export function setDateRange(preset: DatePreset | null, from: number | null, to: number | null): void {
  setDatePreset(preset);
  setSince(from);
  setUntil(to);
}

const values = (): FilterValues => ({ text: text(), refs: refs(), author: author(), since: since(), until: until(), path: path() });

/** The query of the log. */
export const query: () => LogQuery = createRoot(() =>
  createMemo<LogQuery>(() => buildQuery(selectedRepoIds(), values()), buildQuery([], EMPTY_FILTERS), { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) }),
);

/** True when a filter other than the repo selection limits the commits (the "Uncommitted changes" row is hidden then). */
export const hasContentFilter = (): boolean => {
  const p = parseTextFilter(text());
  return !!(p.text || p.author || p.path || p.before || p.after || refs().length || author() || path() || since() !== null || until() !== null);
};

export interface ActiveFilter {
  id: "repos" | "text" | "branch" | "author" | "date" | "path";
  label: string;
}

/** Filters that are on, for the "No commits match these filters" text and the clear button. */
export function activeFilters(): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const p = parseTextFilter(text());
  if (isRepoFilterActive() && projectRepos().length > 1) out.push({ id: "repos", label: "Repos" });
  if (p.text) out.push({ id: "text", label: "Text" });
  if (refs().length) out.push({ id: "branch", label: "Branch" });
  if (author() || p.author) out.push({ id: "author", label: "Author" });
  if (since() !== null || until() !== null || p.before || p.after) out.push({ id: "date", label: "Date" });
  if (path() || p.path) out.push({ id: "path", label: "Path" });
  return out;
}

/** Clears every filter, including the repo selection (Ctrl+Shift+F). */
export function clearAllFilters(): void {
  clearTimeout(debounce);
  setTextInput(EMPTY_FILTERS.text);
  setText(EMPTY_FILTERS.text);
  setRefs([]);
  setAuthor("");
  setPath("");
  setDateRange(null, null, null);
  selectAllRepos();
}
