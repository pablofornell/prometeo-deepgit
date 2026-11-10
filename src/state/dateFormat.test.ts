// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DATE_FORMATS, dateFormatExample, dateWidthSample, formatAbsolute, formatDateAs, formatDay, formatFullDate, formatIso, formatMonth, formatOtherDate,
  formatRelative,
} from "./dateFormat";

// Tuesday 10 Nov 2026, 14:32:05 local time
const T = new Date(2026, 10, 10, 14, 32, 5).getTime() / 1000;
const NOW = T * 1000 + 3 * 3600 * 1000;

describe("formatRelative", () => {
  it("says how long ago", () => {
    expect(formatRelative(T, T * 1000 + 10_000)).toBe("now");
    expect(formatRelative(T, T * 1000 + 4 * 60_000)).toBe("4 min ago");
    expect(formatRelative(T, NOW)).toBe("3 h ago");
    expect(formatRelative(T, T * 1000 + 86400_000)).toBe("yesterday");
    expect(formatRelative(T, T * 1000 + 5 * 86400_000)).toBe("5 d ago");
    expect(formatRelative(T, T * 1000 + 90 * 86400_000)).toBe("3 mo ago");
    expect(formatRelative(T, T * 1000 + 800 * 86400_000)).toBe("2 y ago");
  });
  it("says now for a time in the future", () => {
    expect(formatRelative(T, T * 1000 - 3600_000)).toBe("now");
  });
});

describe("formatDateAs", () => {
  it("writes the three formats", () => {
    expect(formatDateAs("relative", T, NOW)).toBe("3 h ago");
    expect(formatDateAs("absolute", T, NOW, "en-GB")).toBe("10 Nov 2026, 14:32");
    expect(formatDateAs("iso", T, NOW)).toBe("2026-11-10 14:32");
  });
  it("follows the locale in the absolute format", () => {
    expect(formatAbsolute(T, "en-US")).toBe("Nov 10, 2026, 02:32 PM");
    expect(formatAbsolute(T, "de-DE")).toBe("10. Nov. 2026, 14:32");
  });
  it("falls back to British English for a locale the runtime refuses", () => {
    expect(formatAbsolute(T, "not a locale!")).toBe("10 Nov 2026, 14:32");
  });
  it("pads the ISO date and time", () => {
    expect(formatIso(new Date(2026, 0, 5, 7, 3).getTime() / 1000)).toBe("2026-01-05 07:03");
  });
});

describe("formatFullDate", () => {
  it("is absolute with seconds and the time zone, whatever the format", () => {
    const full = formatFullDate("absolute", T, "en-GB");
    expect(full).toMatch(/^Tue, 10 Nov 2026, 14:32:05 \S+/);
    expect(formatFullDate("relative", T, "en-GB")).toBe(full);
  });
  it("is ISO with the UTC offset in the ISO format", () => {
    expect(formatFullDate("iso", T)).toMatch(/^2026-11-10 14:32:05 [+-]\d\d:\d\d$/);
  });
});

describe("formatOtherDate", () => {
  it("gives the exact date for the relative format and the age for the others", () => {
    expect(formatOtherDate("relative", T, NOW, "en-GB")).toBe("10 Nov 2026, 14:32");
    expect(formatOtherDate("iso", T, NOW)).toBe("3 h ago");
    expect(formatOtherDate("absolute", T, NOW)).toBe("3 h ago");
  });
});

describe("formatMonth and formatDay", () => {
  it("name a month and a day in each format", () => {
    expect(formatMonth("relative", 2026, 9)).toBe("October 2026");
    expect(formatMonth("absolute", 2026, 9, "en-GB")).toBe("October 2026");
    expect(formatMonth("iso", 2026, 9)).toBe("2026-10");
    expect(formatDay("absolute", T, "en-GB")).toBe("10 Nov 2026");
    expect(formatDay("iso", T)).toBe("2026-11-10");
  });
});

describe("Settings examples and column samples", () => {
  it("shows the moment 3 hours ago in each format", () => {
    expect(DATE_FORMATS.map((f) => dateFormatExample(f, NOW, "en-GB"))).toEqual(["3 h ago", "10 Nov 2026, 14:32", "2026-11-10 14:32"]);
  });
  it("gives a sample at least as long as a date of the format", () => {
    expect(dateWidthSample("relative").length).toBeGreaterThanOrEqual("59 min ago".length);
    expect(dateWidthSample("iso")).toBe("2022-09-28 22:48");
    // September: the longest short month name in many locales ("Sept" in recent English data)
    expect(dateWidthSample("absolute", "en-GB")).toMatch(/^28 Sept? 2022, 22:48$/);
  });
});
