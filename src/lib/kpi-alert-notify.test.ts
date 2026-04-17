/**
 * Unit tests for pure helpers in kpi-alert-notify.
 * We only test the exported isLastFiveDaysOfMonth function which has no
 * external dependencies (no DB, no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLastFiveDaysOfMonth } from "./kpi-alert-notify.js";

describe("isLastFiveDaysOfMonth", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper: set the system clock so that Bangkok (UTC+7) reports the given
   * year/month/day.  We offset by -7 hours so that
   * `new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" })` returns
   * the desired date at 09:00 Bangkok time.
   */
  function setBangkokDate(year: number, month: number, day: number) {
    // Bangkok is UTC+7.  Set the clock to 02:00 UTC so Bangkok sees 09:00.
    const utcMs = Date.UTC(year, month - 1, day, 2, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(utcMs));
  }

  it("returns true on the last day of the month (31st of January)", () => {
    setBangkokDate(2025, 1, 31); // Jan 31
    expect(isLastFiveDaysOfMonth()).toBe(true);
  });

  it("returns true on the 5th-to-last day (27th of January, lastDay=31)", () => {
    setBangkokDate(2025, 1, 27); // Jan 27 → lastDay - 4 = 27 ✓
    expect(isLastFiveDaysOfMonth()).toBe(true);
  });

  it("returns false on the 6th-to-last day (26th of January, lastDay=31)", () => {
    setBangkokDate(2025, 1, 26); // Jan 26 → 26 < 27 ✗
    expect(isLastFiveDaysOfMonth()).toBe(false);
  });

  it("returns true on the last day of February in a leap year (Feb 29 2028)", () => {
    setBangkokDate(2028, 2, 29); // Feb 29 is the last day
    expect(isLastFiveDaysOfMonth()).toBe(true);
  });

  it("returns true on Feb 25 in a leap year (lastDay=29, 29-4=25)", () => {
    setBangkokDate(2028, 2, 25);
    expect(isLastFiveDaysOfMonth()).toBe(true);
  });

  it("returns false on Feb 24 in a leap year (24 < 25)", () => {
    setBangkokDate(2028, 2, 24);
    expect(isLastFiveDaysOfMonth()).toBe(false);
  });

  it("returns true on the last day of a 30-day month (April 30)", () => {
    setBangkokDate(2025, 4, 30);
    expect(isLastFiveDaysOfMonth()).toBe(true);
  });

  it("returns true on April 26 (lastDay=30, 30-4=26)", () => {
    setBangkokDate(2025, 4, 26);
    expect(isLastFiveDaysOfMonth()).toBe(true);
  });

  it("returns false on April 25 (25 < 26)", () => {
    setBangkokDate(2025, 4, 25);
    expect(isLastFiveDaysOfMonth()).toBe(false);
  });

  it("returns false on the 1st of a month", () => {
    setBangkokDate(2025, 6, 1);
    expect(isLastFiveDaysOfMonth()).toBe(false);
  });
});
