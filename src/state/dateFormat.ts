/**
 * The one date formatter of the UI. Pure (no store, no DOM): `state/dates.ts` binds it to the `dateFormat` setting.
 *
 *   formatDateAs("relative", t, now)   "3 h ago"
 *   formatDateAs("absolute", t)        "10-11-2026 14:32"             (dd-mm-yyyy HH:mm, 24 h, whatever the language)
 *   formatFullDate(t)                  "10-11-2026 14:32:05 +01:00"   (tooltips: always absolute, with seconds and the UTC offset)
 *
 * All times are local time. `unixSec` is seconds since the epoch, `nowMs` milliseconds.
 */

export type DateFormat = "relative" | "absolute";

export const DATE_FORMATS: readonly DateFormat[] = ["relative", "absolute"];

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const two = (n: number): string => String(n).padStart(2, "0");

/** "now", "4 min ago", "3 h ago", "yesterday", "5 d ago", "3 mo ago", "2 y ago". A time in the future is "now". */
export function formatRelative(unixSec: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - unixSec));
  if (s < 45) return "now";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(s / 3600);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.round(d / 365)} y ago`;
}

/** "+01:00": the offset from UTC of local time at that moment. */
function utcOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${off < 0 ? "-" : "+"}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/** "10-11-2026": the day alone, dd-mm-yyyy. */
export function formatDay(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** "10-11-2026 14:32"; with `seconds`: "10-11-2026 14:32:05 +01:00" (the offset of that moment, local time). */
export function formatAbsolute(unixSec: number, seconds = false): string {
  const d = new Date(unixSec * 1000);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (!seconds) return `${formatDay(unixSec)} ${hm}`;
  return `${formatDay(unixSec)} ${hm}:${two(d.getSeconds())} ${utcOffset(d)}`;
}

/** A date in the chosen format. `nowMs` matters for "relative" only. */
export function formatDateAs(format: DateFormat, unixSec: number, nowMs: number = Date.now()): string {
  return format === "relative" ? formatRelative(unixSec, nowMs) : formatAbsolute(unixSec);
}

/**
 * The full absolute date with seconds and the UTC offset, for tooltips: "10-11-2026 14:32:05 +01:00". Never relative:
 * the tooltip is where a relative date shows its exact time.
 */
export function formatFullDate(unixSec: number): string {
  return formatAbsolute(unixSec, true);
}

/**
 * The other view of a date, shown next to the main one where there is room (commit details): the exact date for
 * the relative format, the age for the absolute one.
 */
export function formatOtherDate(format: DateFormat, unixSec: number, nowMs: number = Date.now()): string {
  return format === "relative" ? formatAbsolute(unixSec) : formatRelative(unixSec, nowMs);
}

/** Name of a month group of the log: "October 2026" (a heading, not a date). */
export function formatMonth(year: number, month0: number): string {
  return `${MONTHS_LONG[month0]} ${year}`;
}

/** A text as wide as a date gets in this format, to size a column: measure it in the column's font. */
export function dateWidthSample(format: DateFormat): string {
  return format === "relative" ? "59 min ago" : formatAbsolute(new Date(2022, 8, 28, 22, 48, 58).getTime() / 1000);
}

/** Text shown in Settings next to each format: the same moment (3 hours before `nowMs`) in that format. */
export function dateFormatExample(format: DateFormat, nowMs: number = Date.now()): string {
  return formatDateAs(format, Math.floor(nowMs / 1000) - 3 * 3600, nowMs);
}
