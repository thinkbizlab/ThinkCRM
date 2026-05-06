/**
 * Apple Push Notification service (APNs) helper.
 *
 * Uses the HTTP/2-based APNs provider API with a .p8 token-based auth key.
 * Requires: APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_KEY_PATH.
 *
 * @see https://developer.apple.com/documentation/usernotifications/sending-push-notifications-using-command-line-tools
 */

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { config } from "../config.js";
import { prisma } from "./prisma.js";

// ── APNs JWT token (cached, refreshed every 50 min — Apple requires < 60 min) ──

let cachedJwt: string | null = null;
let cachedJwtAt = 0;
const JWT_TTL_MS = 50 * 60 * 1000;

function getApnsJwt(): string {
  const now = Date.now();
  if (cachedJwt && now - cachedJwtAt < JWT_TTL_MS) return cachedJwt;

  const keyId = config.APNS_KEY_ID;
  const teamId = config.APNS_TEAM_ID;
  if (!keyId || !teamId) {
    throw new Error("APNs is not configured (APNS_KEY_ID and APNS_TEAM_ID required).");
  }

  const key = loadApnsPrivateKey();
  if (!key) {
    throw new Error("APNs is not configured (set APNS_PRIVATE_KEY or APNS_KEY_PATH).");
  }
  const iat = Math.floor(now / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: teamId, iat })).toString("base64url");
  const signingInput = `${header}.${payload}`;

  const sign = createSign("SHA256");
  sign.update(signingInput);
  const derSig = sign.sign(key);
  // Convert DER-encoded ECDSA signature to raw r||s (64 bytes) for JWT ES256
  const sig = derToRaw(derSig);

  cachedJwt = `${signingInput}.${sig.toString("base64url")}`;
  cachedJwtAt = now;
  return cachedJwt;
}

/**
 * Resolve the .p8 private key from APNS_PRIVATE_KEY (PEM string in env, preferred
 * on Vercel / other serverless hosts) or fall back to reading APNS_KEY_PATH from
 * disk (preferred for local dev). The Vercel env-var dashboard sometimes stores
 * newlines as literal `\n` two-character sequences — normalize those back.
 */
function loadApnsPrivateKey(): string | null {
  const inline = config.APNS_PRIVATE_KEY;
  if (inline) return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  const keyPath = config.APNS_KEY_PATH;
  if (keyPath) return readFileSync(keyPath, "utf8");
  return null;
}

/** Convert a DER-encoded ECDSA signature to the raw 64-byte r||s format used by JWT ES256. */
function derToRaw(der: Buffer): Buffer {
  // DER: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  let offset = 2; // skip 0x30 + total len
  offset += 1; // skip 0x02
  const rLen = der[offset]!;
  offset += 1;
  const r = der.subarray(offset, offset + rLen);
  offset += rLen;
  offset += 1; // skip 0x02
  const sLen = der[offset]!;
  offset += 1;
  const s = der.subarray(offset, offset + sLen);

  const raw = Buffer.alloc(64);
  // r and s may have a leading 0x00 pad for positive sign — strip it
  r.subarray(r.length - 32).copy(raw, 0);
  s.subarray(s.length - 32).copy(raw, 32);
  return raw;
}

// ── Public API ──────────────────────────────────────────────────────────────────

export interface ApnsPushOptions {
  /** APNs device token (hex string from iOS). */
  deviceToken: string;
  /** Notification title. */
  title: string;
  /** Notification body text. */
  body: string;
  /** Badge count (optional). */
  badge?: number;
  /** Custom data payload the app receives when opened. */
  data?: Record<string, unknown>;
  /** APNs push type — default "alert". */
  pushType?: "alert" | "background";
}

export interface ApnsPushResult {
  ok: boolean;
  statusCode: number;
  reason?: string;
}

const APNS_HOST: Record<string, string> = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com"
};

/** Whether APNs is configured and available. */
export function isApnsConfigured(): boolean {
  return !!(
    config.APNS_KEY_ID
    && config.APNS_TEAM_ID
    && config.APNS_BUNDLE_ID
    && (config.APNS_PRIVATE_KEY || config.APNS_KEY_PATH)
  );
}

/**
 * Send a push notification to a single iOS device.
 * Returns `{ ok, statusCode, reason }`.
 */
export async function sendApnsPush(opts: ApnsPushOptions): Promise<ApnsPushResult> {
  const bundleId = config.APNS_BUNDLE_ID;
  if (!bundleId) throw new Error("APNS_BUNDLE_ID is not configured.");

  const jwt = getApnsJwt();
  const host = APNS_HOST[config.APNS_ENVIRONMENT] ?? APNS_HOST.development!;
  const url = `${host}/3/device/${opts.deviceToken}`;
  const pushType = opts.pushType ?? "alert";

  const apnsPayload: Record<string, unknown> = {
    aps: {
      alert: { title: opts.title, body: opts.body },
      sound: "default",
      ...(opts.badge != null ? { badge: opts.badge } : {})
    },
    ...(opts.data ?? {})
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": pushType,
      "apns-priority": pushType === "alert" ? "10" : "5",
      "content-type": "application/json"
    },
    body: JSON.stringify(apnsPayload)
  });

  if (res.ok) return { ok: true, statusCode: res.status };

  const body = await res.json().catch(() => ({})) as { reason?: string };
  return { ok: false, statusCode: res.status, reason: body.reason };
}

export interface SendApnsToUserResult {
  sentCount: number;
  failedCount: number;
}

/**
 * Fan out an APNs push to every iOS device registered to a user.
 * No-op when APNs isn't configured. Drops device tokens Apple reports as
 * permanently invalid (410 Unregistered, BadDeviceToken) so they don't get
 * retried indefinitely.
 */
export async function sendApnsToUser(opts: {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  badge?: number;
}): Promise<SendApnsToUserResult> {
  if (!isApnsConfigured()) return { sentCount: 0, failedCount: 0 };

  const devices = await prisma.userDevice.findMany({
    where: { userId: opts.userId, platform: "IOS" },
    select: { id: true, deviceToken: true }
  });
  if (devices.length === 0) return { sentCount: 0, failedCount: 0 };

  let sentCount = 0;
  let failedCount = 0;

  await Promise.all(devices.map(async (d) => {
    try {
      const r = await sendApnsPush({
        deviceToken: d.deviceToken,
        title: opts.title,
        body: opts.body,
        data: opts.data,
        ...(opts.badge != null ? { badge: opts.badge } : {})
      });
      if (r.ok) {
        sentCount += 1;
        return;
      }
      failedCount += 1;
      if (r.statusCode === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered") {
        await prisma.userDevice.delete({ where: { id: d.id } }).catch(() => {});
      } else {
        console.warn(`[apns] push failed user=${opts.userId} status=${r.statusCode} reason=${r.reason ?? "?"}`);
      }
    } catch (err) {
      failedCount += 1;
      console.error(`[apns] push error user=${opts.userId}:`, err);
    }
  }));

  return { sentCount, failedCount };
}
