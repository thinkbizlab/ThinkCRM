/**
 * LINE Messaging API — push message helper.
 * Supports sending text and image messages to a LINE group or user chat.
 *
 * Requires a Channel Access Token stored in TenantIntegrationCredential.apiKeyRef
 * for platform = LINE.
 */

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export interface LinePushResult {
  ok: boolean;
  status: number;
  message: string;
}

type LineMessage =
  | { type: "text"; text: string }
  | { type: "image"; originalContentUrl: string; previewImageUrl: string };

export async function sendLinePush(
  channelAccessToken: string,
  to: string,
  messages: LineMessage | LineMessage[]
): Promise<LinePushResult> {
  const payload = Array.isArray(messages) ? messages : [messages];

  const res = await fetch(LINE_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelAccessToken}`
    },
    body: JSON.stringify({ to, messages: payload })
  });

  if (res.ok) {
    return { ok: true, status: res.status, message: "Message sent successfully." };
  }

  let errMsg = `LINE API error ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) errMsg = `LINE API: ${body.message}`;
  } catch {
    // ignore parse failure
  }
  return { ok: false, status: res.status, message: errMsg };
}

import { fmtThaiDateTime } from "./format.js";

// Re-export so existing callers (visits/routes.ts) keep working.
export const formatThaiDateTime = fmtThaiDateTime;

/** Build a Google Maps link from coordinates */
export function googleMapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/** Format minutes as "Xh Ym" */
export function formatDuration(startDate: Date, endDate: Date): string {
  const mins = Math.round((endDate.getTime() - startDate.getTime()) / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

/** Build check-in LINE messages */
export function buildCheckInMessages(opts: {
  appName: string;
  visitNo: string;
  repName: string;
  customerName: string;
  checkInAt: Date;
  objective: string | null;
  lat: number;
  lng: number;
  selfieUrl: string | null;
}): LineMessage[] {
  const dt = formatThaiDateTime(opts.checkInAt);
  const mapUrl = googleMapsLink(opts.lat, opts.lng);
  const objective = opts.objective?.trim() || "—";

  const text =
    `📍 Check-In Notification\n` +
    `${"─".repeat(28)}\n` +
    `🔖 Visit ID   : ${opts.visitNo}\n` +
    `👤 Sales Rep  : ${opts.repName}\n` +
    `🏢 Customer   : ${opts.customerName}\n` +
    `🕐 Check-In   : ${dt}\n` +
    `📝 Objective  : ${objective}\n` +
    `📌 Location   : ${mapUrl}\n` +
    `${"─".repeat(28)}\n` +
    `[${opts.appName}]`;

  const msgs: LineMessage[] = [{ type: "text", text }];

  if (opts.selfieUrl) {
    msgs.push({
      type: "image",
      originalContentUrl: opts.selfieUrl,
      previewImageUrl: opts.selfieUrl
    });
  }

  return msgs;
}

/** Build check-out LINE messages */
export function buildCheckOutMessages(opts: {
  appName: string;
  visitNo: string;
  repName: string;
  customerName: string;
  checkInAt: Date | null;
  checkOutAt: Date;
  result: string | null;
  lat: number;
  lng: number;
}): LineMessage[] {
  const dt = formatThaiDateTime(opts.checkOutAt);
  const duration = opts.checkInAt ? formatDuration(opts.checkInAt, opts.checkOutAt) : "—";
  const mapUrl = googleMapsLink(opts.lat, opts.lng);
  const result = opts.result?.trim() || "—";

  const text =
    `✅ Check-Out Notification\n` +
    `${"─".repeat(28)}\n` +
    `🔖 Visit ID   : ${opts.visitNo}\n` +
    `👤 Sales Rep   : ${opts.repName}\n` +
    `🏢 Customer    : ${opts.customerName}\n` +
    `🕐 Check-Out   : ${dt}\n` +
    `⏱  Duration    : ${duration}\n` +
    `📋 Result      : ${result}\n` +
    `📌 Location    : ${mapUrl}\n` +
    `${"─".repeat(28)}\n` +
    `[${opts.appName}]`;

  return [{ type: "text", text }];
}
