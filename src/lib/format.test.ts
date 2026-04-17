import { describe, expect, it } from "vitest";
import {
  fmtBaht,
  fmtBahtCurrency,
  fmtThaiDate,
  fmtThaiDateTime,
  fmtThaiMonthYear,
} from "./format.js";

describe("fmtThaiDate", () => {
  it("formats a date in DD/MM/YYYY using th-TH locale (Bangkok timezone)", () => {
    // 2025-04-15 UTC is still 2025-04-15 in Bangkok (UTC+7)
    const date = new Date("2025-04-15T10:00:00.000Z");
    const result = fmtThaiDate(date);
    // th-TH locale separates with "/" and uses Buddhist-era year 2568
    expect(result).toContain("15");
    expect(result).toContain("04");
    // Buddhist year 2568 (CE 2025 + 543)
    expect(result).toContain("2568");
  });

  it("rolls over at midnight Bangkok time (UTC+7)", () => {
    // 2025-01-01 00:30 Bangkok = 2024-12-31 17:30 UTC
    const utcMidnightMinus30 = new Date("2024-12-31T17:30:00.000Z");
    const result = fmtThaiDate(utcMidnightMinus30);
    // Bangkok is already Jan 1 2025 at this moment
    expect(result).toContain("01");
    expect(result).toContain("01");
    expect(result).toContain("2568"); // 2025 CE = 2568 BE
  });
});

describe("fmtThaiDateTime", () => {
  it("includes both date and time parts", () => {
    const date = new Date("2025-06-20T05:00:00.000Z"); // 12:00 Bangkok (UTC+7)
    const result = fmtThaiDateTime(date);
    expect(result).toContain("20");   // day
    expect(result).toContain("06");   // month
    expect(result).toContain("2568"); // Buddhist year
    expect(result).toContain("12");   // hour 12:00
    expect(result).toContain("00");   // minute
  });

  it("uses 24-hour format for PM times", () => {
    // 2025-04-15 14:00 Bangkok = 07:00 UTC
    const date = new Date("2025-04-15T07:00:00.000Z");
    const result = fmtThaiDateTime(date);
    expect(result).toContain("14");
  });
});

describe("fmtThaiMonthYear", () => {
  it("returns a string with the Buddhist-era year", () => {
    const date = new Date("2025-04-01T00:00:00.000Z");
    const result = fmtThaiMonthYear(date);
    // 2025 CE = 2568 BE
    expect(result).toContain("2568");
  });

  it("includes the Thai month name (เมษายน = April)", () => {
    const date = new Date("2025-04-01T00:00:00.000Z");
    const result = fmtThaiMonthYear(date);
    expect(result).toContain("เมษายน");
  });

  it("defaults to the current date when called with no argument", () => {
    // Just verify it returns a non-empty string without throwing
    const result = fmtThaiMonthYear();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("fmtBaht", () => {
  it("formats whole baht with thousands separator, no decimals", () => {
    expect(fmtBaht(1234567)).toBe("1,234,567");
  });

  it("formats zero", () => {
    expect(fmtBaht(0)).toBe("0");
  });

  it("formats negative values", () => {
    const result = fmtBaht(-5000);
    expect(result).toContain("5,000");
  });

  it("rounds fractional values to whole baht", () => {
    // maximumFractionDigits: 0 truncates / rounds
    const result = fmtBaht(1234.9);
    expect(result).not.toContain(".");
  });

  it("formats small positive numbers without separator", () => {
    expect(fmtBaht(999)).toBe("999");
  });
});

describe("fmtBahtCurrency", () => {
  it("includes the ฿ symbol", () => {
    const result = fmtBahtCurrency(1000);
    expect(result).toContain("฿");
  });

  it("formats 1,234,567 with thousands separator", () => {
    const result = fmtBahtCurrency(1234567);
    expect(result).toContain("1,234,567");
  });

  it("formats zero with currency symbol", () => {
    const result = fmtBahtCurrency(0);
    expect(result).toContain("฿");
    expect(result).toContain("0");
  });

  it("has no decimal digits", () => {
    const result = fmtBahtCurrency(1500.75);
    // maximumFractionDigits: 0 — no dot-digits in output
    expect(result).not.toMatch(/\.\d/);
  });
});
