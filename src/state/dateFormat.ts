/**
 * The one date formatter of the UI. Pure (no store, no DOM): `state/dates.ts` binds it to the `dateFormat` setting.
 *
 *   formatDateAs("relative", t, now)   "3 h ago"
 *   formatDateAs("absolute", t, now)   "10 Nov 2026, 14:32"   (order, month name and clock of the user's locale)
 *   formatDateAs("iso", t, now)        "2026-11-10 14:32"
 *   formatFullDate("absolute", t)      "Tue, 10 Nov 2026, 14:32:05 CET"   (tooltips: always an absolute date and the time zone)
 *
 * All times are local time. `unixSec` is seconds since the epoch, `nowMs` milliseconds.
 */

export type DateFormat = "relative" | "absolute" | "iso";

export const DATE_FORMATS: readonly DateFormat[] = ["relative", "absolute", "iso"];

/** The locale of the absolute format when the runtime does not name one. */
const FALLBACK_LOCALE = "en-GB";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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

/** "2026-11-10 14:32"; with `seconds`: "2026-11-10 14:32:05 +01:00" (the offset of that moment, local time). */
export function formatIso(unixSec: number, seconds = false): string {
  const d = new Date(unixSec * 1000);
  const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (!seconds) return `${day} ${hm}`;
  return `${day} ${hm}:${two(d.getSeconds())} ${utcOffset(d)}`;
}

type Shape = "short" | "full" | "month" | "day";

const SHAPES: Record<Shape, Intl.DateTimeFormatOptions> = {
  short: { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
  full: { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" },
  month: { month: "long", year: "numeric" },
  day: { day: "numeric", month: "short", year: "numeric" },
};

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** A cached `Intl.DateTimeFormat`, or null when the runtime cannot make one for the locale. */
function intl(shape: Shape, locale: string | undefined): Intl.DateTimeFormat | null {
  const key = `${shape}|${locale ?? ""}`;
  let f = formatters.get(key);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat(locale ?? defaultLocale(), SHAPES[shape]);
    } catch {
      f = null;
    }
    formatters.set(key, f);
  }
  return f;
}

/** The user's locale (the first language of the browser or webview), else British English. */
function defaultLocale(): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : undefined;
  return nav || FALLBACK_LOCALE;
}

/** The fixed English forms, used when `Intl` fails. */
function plain(shape: Shape, d: Date): string {
  if (shape === "month") return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (shape === "day") return day;
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return shape === "short" ? `${day}, ${hm}` : `${DAYS[d.getDay()]}, ${day}, ${hm}:${two(d.getSeconds())} ${utcOffset(d)}`;
}

function localized(shape: Shape, unixSec: number, locale: string | undefined): string {
  const d = new Date(unixSec * 1000);
  const f = intl(shape, locale);
  if (!f) return plain(shape, d);
  try {
    // some locales put a narrow no-break space before "PM"; plain spaces wrap and measure the same everywhere
    return f.format(d).replace(/[  ]/g, " ");
  } catch {
    return plain(shape, d);
  }
}

/** "10 Nov 2026, 14:32" in the locale (`locale` omitted: the user's). */
export function formatAbsolute(unixSec: number, locale?: string): string {
  return localized("short", unixSec, locale);
}

/** A date in the chosen format. `nowMs` matters for "relative" only. */
export function formatDateAs(format: DateFormat, unixSec: number, nowMs: number = Date.now(), locale?: string): string {
  if (format === "relative") return formatRelative(unixSec, nowMs);
  if (format === "iso") return formatIso(unixSec);
  return formatAbsolute(unixSec, locale);
}

/**
 * The full absolute date and time zone, for tooltips: "Tue, 10 Nov 2026, 14:32:05 CET", or "2026-11-10 14:32:05 +01:00" when the
 * format is ISO. Never relative: the tooltip is where a relative date shows its exact time.
 */
export function formatFullDate(format: DateFormat, unixSec: number, locale?: string): string {
  return format === "iso" ? formatIso(unixSec, true) : localized("full", unixSec, locale);
}

/**
 * The other view of a date, shown next to the main one where there is room (commit details): the exact date for
 * the relative format, the age for the absolute ones.
 */
export function formatOtherDate(format: DateFormat, unixSec: number, nowMs: number = Date.now(), locale?: string): string {
  return format === "relative" ? formatAbsolute(unixSec, locale) : formatRelative(unixSec, nowMs);
}

/** Name of a month group of the log: "October 2026" (English for relative, the locale for absolute), "2026-10" for ISO. */
export function formatMonth(format: DateFormat, year: number, month0: number, locale?: string): string {
  if (format === "iso") return `${year}-${two(month0 + 1)}`;
  if (format === "relative") return `${MONTHS_LONG[month0]} ${year}`;
  return localized("month", new Date(year, month0, 15, 12).getTime() / 1000, locale);
}

/** "10 Nov 2026" or "2026-11-10": the day alone, for the "Today" and "Yesterday" groups of the log. */
export function formatDay(format: DateFormat, unixSec: number, locale?: string): string {
  if (format === "iso") return formatIso(unixSec).slice(0, 10);
  return localized("day", unixSec, locale);
}

/** A text as wide as a date gets in this format, to size a column: measure it in the column's font. */
export function dateWidthSample(format: DateFormat, locale?: string): string {
  // 28 Sep 2022, 22:48: wide digits and a wide month in most fonts and locales
  return format === "relative" ? "59 min ago" : formatDateAs(format, new Date(2022, 8, 28, 22, 48, 58).getTime() / 1000, 0, locale);
}

/** Text shown in Settings next to each format: the same moment (3 hours before `nowMs`) in that format. */
export function dateFormatExample(format: DateFormat, nowMs: number = Date.now(), locale?: string): string {
  return formatDateAs(format, Math.floor(nowMs / 1000) - 3 * 3600, nowMs, locale);
}
