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

const THAI_SHORT_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

/** "14 พ.ค. 2569 14:32" — Thai short month, Buddhist-era year, 24h, in Asia/Bangkok. */
export function fmtThaiShortDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = String(parseInt(get("day"), 10));
  const monthIdx = parseInt(get("month"), 10) - 1;
  const beYear = parseInt(get("year"), 10) + 543;
  const hour = get("hour");
  const minute = get("minute");
  return `${day} ${THAI_SHORT_MONTHS[monthIdx]} ${beYear} ${hour}:${minute}`;
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
