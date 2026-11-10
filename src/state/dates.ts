/**
 * Dates as the user chose to see them (Settings > Appearance > Date format). Every date of the UI goes through here:
 *
 *   <span data-tip={fullDate(commit.time)}>{formatDate(commit.time)}</span>
 *
 * Reactive: read inside JSX, a memo or an effect, the text follows the `dateFormat` setting at once, and a relative
 * date ("4 min ago") follows the clock. The formats themselves are in `dateFormat.ts` (pure, tested).
 * Times are unix seconds.
 */
import { createSignal } from "solid-js";
import { dateFormatExample, type DateFormat, formatDateAs, formatFullDate, formatOtherDate } from "./dateFormat";
import { settings } from "./settings";

const TICK_MS = 30_000;
const [clock, setClock] = createSignal(Date.now());
let ticking = false;

/** The current time in ms, refreshed every 30 seconds (reactive). */
export function nowMs(): number {
  if (!ticking && typeof window !== "undefined") {
    ticking = true;
    window.setInterval(() => setClock(Date.now()), TICK_MS);
  }
  return clock();
}

/** A date in the user's format: "3 h ago", "10 Nov 2026, 14:32" or "2026-11-10 14:32". */
export function formatDate(unixSec: number): string {
  const format = settings.dateFormat;
  return formatDateAs(format, unixSec, format === "relative" ? nowMs() : 0);
}

/** The full absolute date, for a tooltip (never relative). */
export function fullDate(unixSec: number): string {
  return formatFullDate(settings.dateFormat, unixSec);
}

/** The other view of the date, for places with room for both: the exact date when the format is relative, else the age. */
export function otherDate(unixSec: number): string {
  const format = settings.dateFormat;
  return formatOtherDate(format, unixSec, format === "relative" ? 0 : nowMs());
}

/** The example that Settings shows next to a format: the moment 3 hours ago, in that format. It follows the clock. */
export function dateExample(format: DateFormat): string {
  return dateFormatExample(format, nowMs());
}
