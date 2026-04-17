/**
 * L5: Shared Thai locale formatters.
 * Centralises date / currency / number formatting previously duplicated
 * across digest-notify, kpi-alert-notify, line-notify and deals/routes.
 */

const TZ = "Asia/Bangkok";

/** DD/MM/YYYY */
export function fmtThaiDate(date: Date): string {
  return date.toLocaleDateString("th-TH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: TZ,
  });
}

/** DD/MM/YYYY HH:MM (24h) */
export function fmtThaiDateTime(date: Date): string {
  return date.toLocaleString("th-TH", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "เมษายน 2569" — long month + Buddhist-era year */
export function fmtThaiMonthYear(date: Date = new Date()): string {
  return date.toLocaleDateString("th-TH", {
    month: "long",
    year: "numeric",
    timeZone: TZ,
  });
}

/** Whole-number baht: "1,234,567" (no decimals, no ฿ symbol) */
export function fmtBaht(value: number): string {
  return new Intl.NumberFormat("th-TH", {
    style: "decimal",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/** Currency string: "฿1,234,567" (no decimals) */
export function fmtBahtCurrency(value: number): string {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 0,
  }).format(value);
}
