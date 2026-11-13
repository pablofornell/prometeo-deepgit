// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DATE_FORMATS, dateFormatExample, dateWidthSample, formatAbsolute, formatDateAs, formatDay, formatFullDate, formatMonth, formatOtherDate,
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
  it("writes the two formats", () => {
    expect(DATE_FORMATS).toEqual(["relative", "absolute"]);
    expect(formatDateAs("relative", T, NOW)).toBe("3 h ago");
    expect(formatDateAs("absolute", T, NOW)).toBe("10-11-2026 14:32");
  });
  it("pads the day, the month and the time, and uses 24 hours", () => {
    expect(formatAbsolute(new Date(2026, 0, 5, 7, 3).getTime() / 1000)).toBe("05-01-2026 07:03");
    expect(formatAbsolute(new Date(2026, 11, 31, 23, 59).getTime() / 1000)).toBe("31-12-2026 23:59");
  });
  it("does not depend on the language", () => {
    expect(formatAbsolute(T)).toBe("10-11-2026 14:32");
  });
});

describe("formatFullDate", () => {
  it("is dd-mm-yyyy HH:mm:ss with the UTC offset", () => {
    expect(formatFullDate(T)).toMatch(/^10-11-2026 14:32:05 [+-]\d\d:\d\d$/);
    expect(formatAbsolute(T, true)).toBe(formatFullDate(T));
  });
});

describe("formatOtherDate", () => {
  it("gives the exact date for the relative format and the age for the absolute one", () => {
    expect(formatOtherDate("relative", T, NOW)).toBe("10-11-2026 14:32");
    expect(formatOtherDate("absolute", T, NOW)).toBe("3 h ago");
  });
});

describe("formatMonth and formatDay", () => {
  it("name a month and a day", () => {
    expect(formatMonth(2026, 9)).toBe("October 2026");
    expect(formatDay(T)).toBe("10-11-2026");
    expect(formatDay(new Date(2026, 2, 4, 12).getTime() / 1000)).toBe("04-03-2026");
  });
});

describe("Settings examples and column samples", () => {
  it("shows the moment 3 hours ago in each format", () => {
    expect(DATE_FORMATS.map((f) => dateFormatExample(f, NOW))).toEqual(["3 h ago", "10-11-2026 14:32"]);
  });
  it("gives a sample at least as long as a date of the format", () => {
    expect(dateWidthSample("relative").length).toBeGreaterThanOrEqual("59 min ago".length);
    expect(dateWidthSample("absolute")).toBe("28-09-2022 22:48");
  });
});
