/**
 * Pure helpers that turn the filter bar values into a `LogQuery` (PLAN.md section 4): the `author:`, `path:`,
 * `before:` and `after:` prefixes of the text box, the date presets and the labels of the chips.
 */
import type { LogQuery } from "../../api/types";
import { formatDay } from "../../state/dateFormat";

export interface FilterValues {
  /** Raw content of the text box (may hold prefixes). */
  text: string;
  /** Refs to show; empty = everything. */
  refs: string[];
  author: string;
  /** Unix seconds. */
  since: number | null;
  until: number | null;
  path: string;
}

export const EMPTY_FILTERS: FilterValues = { text: "", refs: [], author: "", since: null, until: null, path: "" };

export interface ParsedText {
  text: string;
  author?: string;
  path?: string;
  /** Unix seconds (local midnight). */
  before?: number;
  after?: number;
}

const PREFIX = /(^|\s)(author|path|before|after):("[^"]*"|\S+)/gi;

/** Local midnight of `DD-MM-YYYY` (or `YYYY-MM-DD`, which the date inputs give) as unix seconds, or null. */
export function parseDay(s: string): number | null {
  const t = s.trim();
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(t);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const [y, mo, day] = dmy ? [dmy[3], dmy[2], dmy[1]] : ymd ? [ymd[1], ymd[2], ymd[3]] : [];
  if (y === undefined) return null;
  const d = new Date(Number(y), Number(mo) - 1, Number(day));
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

/** Extracts the prefixes of the text box. Unknown or invalid prefixes stay in the text. */
export function parseTextFilter(raw: string): ParsedText {
  const out: ParsedText = { text: "" };
  out.text = raw
    .replace(PREFIX, (whole, lead: string, key: string, value: string) => {
      const v = value.replace(/^"|"$/g, "");
      switch (key.toLowerCase()) {
        case "author":
          out.author = v;
          return lead;
        case "path":
          out.path = v;
          return lead;
        case "before":
        case "after": {
          const day = parseDay(v);
          if (day === null) return whole;
          if (key.toLowerCase() === "before") out.before = day;
          else out.after = day;
          return lead;
        }
        default:
          return whole;
      }
    })
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

/** Builds the query. The chip values win over the prefixes typed in the text box. */
export function buildQuery(repoIds: string[], f: FilterValues): LogQuery {
  const p = parseTextFilter(f.text);
  return {
    repoIds,
    refs: f.refs,
    text: p.text || null,
    author: f.author.trim() || p.author || null,
    path: f.path.trim() || p.path || null,
    since: f.since ?? p.after ?? null,
    until: f.until ?? p.before ?? null,
    maxCount: 0,
  };
}

export type DatePreset = "24h" | "7d" | "30d" | "1y" | "custom";

export const DATE_PRESETS: { id: Exclude<DatePreset, "custom">; label: string; seconds: number }[] = [
  { id: "24h", label: "Last 24 hours", seconds: 86400 },
  { id: "7d", label: "Last 7 days", seconds: 7 * 86400 },
  { id: "30d", label: "Last 30 days", seconds: 30 * 86400 },
  { id: "1y", label: "Last year", seconds: 365 * 86400 },
];

/** `since` of a preset at `nowMs`. */
export function presetSince(id: Exclude<DatePreset, "custom">, nowMs: number): number {
  const p = DATE_PRESETS.find((x) => x.id === id);
  return Math.floor(nowMs / 1000) - (p?.seconds ?? 0);
}

/** Chip label of the date filter: "Date", "Last 7 days", "03-11-2026 - 09-11-2026". */
export function dateChipLabel(preset: DatePreset | null, since: number | null, until: number | null): string {
  if (since === null && until === null) return "Date";
  const p = DATE_PRESETS.find((x) => x.id === preset);
  if (p) return p.label;
  if (since !== null && until !== null) return `${formatDay(since)} - ${formatDay(until)}`;
  if (since !== null) return `Since ${formatDay(since)}`;
  return `Until ${formatDay(until as number)}`;
}

/** Chip label of the branch filter: "Branch: all", "Branch: HEAD", "Branch: main", "Branch: main +2". */
export function branchChipLabel(refs: string[]): string {
  if (refs.length === 0) return "Branch: all";
  return refs.length === 1 ? `Branch: ${refs[0]}` : `Branch: ${refs[0]} +${refs.length - 1}`;
}

/** Highlights: splits `subject` around the case-insensitive matches of `needle`. */
export function splitMatches(subject: string, needle: string): { text: string; match: boolean }[] {
  const n = needle.trim().toLowerCase();
  if (!n) return [{ text: subject, match: false }];
  const lower = subject.toLowerCase();
  const out: { text: string; match: boolean }[] = [];
  let from = 0;
  for (;;) {
    const i = lower.indexOf(n, from);
    if (i < 0) break;
    if (i > from) out.push({ text: subject.slice(from, i), match: false });
    out.push({ text: subject.slice(i, i + n.length), match: true });
    from = i + n.length;
  }
  if (from < subject.length) out.push({ text: subject.slice(from), match: false });
  return out.length ? out : [{ text: subject, match: false }];
}
