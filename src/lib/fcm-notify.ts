/**
 * Firebase Cloud Messaging (FCM) helper.
 *
 * Mirrors the public surface of apns-notify.ts so callers can be platform-agnostic
 * (`sendPushToUser`). Uses the FCM HTTP v1 API authenticated with a Google OAuth-2
 * access token signed from a service-account JWT (RS256). The access token is
 * cached for ~50 min, the same pattern apns-notify uses for its APNs JWT.
 *
 * @see https://firebase.google.com/docs/cloud-messaging/migrate-v1
 */

import { createSign } from "node:crypto";
import { config } from "../config.js";
import { prisma } from "./prisma.js";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// ── OAuth-2 access token (cached, refreshed every 50 min — Google caps at 60 min) ──

let cachedAccessToken: string | null = null;
let cachedAccessTokenAt = 0;
const TOKEN_TTL_MS = 50 * 60 * 1000;

async function getFcmAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && now - cachedAccessTokenAt < TOKEN_TTL_MS) return cachedAccessToken;

  const clientEmail = config.FCM_CLIENT_EMAIL;
  const privateKey = loadFcmPrivateKey();
  if (!clientEmail || !privateKey) {
    throw new Error("FCM is not configured (FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY required).");
  }

  const iat = Math.floor(now / 1000);
  const jwtClaim = {
    iss: clientEmail,
    scope: FCM_SCOPE,
    aud: FCM_TOKEN_ENDPOINT,
    iat,
    exp: iat + 3600
  };

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(jwtClaim)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(privateKey).toString("base64url");
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(FCM_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`FCM token exchange failed: ${res.status} ${text}`);
  }
  const body = await res.json() as { access_token?: string };
  if (!body.access_token) {
    throw new Error("FCM token exchange returned no access_token.");
  }
  cachedAccessToken = body.access_token;
  cachedAccessTokenAt = now;
  return cachedAccessToken;
}

/**
 * Resolve the service-account private key from FCM_PRIVATE_KEY. The Vercel
 * env-var dashboard sometimes stores newlines as literal `\n` two-character
 * sequences — normalise those back to real newlines, same as apns-notify.
 */
function loadFcmPrivateKey(): string | null {
  const inline = config.FCM_PRIVATE_KEY;
  if (!inline) return null;
  return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
}

// ── Public API ──────────────────────────────────────────────────────────────────

export interface FcmPushOptions {
  /** FCM registration token (opaque string from Android Firebase SDK). */
  deviceToken: string;
  /** Notification title. */
  title: string;
  /** Notification body text. */
  body: string;
  /** Custom data payload the app receives when opened. FCM requires string values. */
  data?: Record<string, unknown>;
}

export interface FcmPushResult {
  ok: boolean;
  statusCode: number;
  /** FCM error code from the response body, e.g. UNREGISTERED, INVALID_ARGUMENT. */
  reason?: string;
}

/** Whether FCM is configured and available. */
export function isFcmConfigured(): boolean {
  return !!(config.FCM_PROJECT_ID && config.FCM_CLIENT_EMAIL && config.FCM_PRIVATE_KEY);
}

/**
 * Send a push notification to a single Android device.
 * Returns `{ ok, statusCode, reason }`.
 */
export async function sendFcmPush(opts: FcmPushOptions): Promise<FcmPushResult> {
  const projectId = config.FCM_PROJECT_ID;
  if (!projectId) throw new Error("FCM_PROJECT_ID is not configured.");

  const accessToken = await getFcmAccessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  // FCM v1 requires string-typed data values — coerce here so callers don't
  // have to think about it.
  const stringData: Record<string, string> | undefined = opts.data
    ? Object.fromEntries(
        Object.entries(opts.data).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
      )
    : undefined;

  const message: Record<string, unknown> = {
    token: opts.deviceToken,
    notification: { title: opts.title, body: opts.body },
    ...(stringData ? { data: stringData } : {}),
    android: {
      priority: "HIGH",
      notification: { sound: "default" }
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ message })
  });

  if (res.ok) return { ok: true, statusCode: res.status };

  const body = await res.json().catch(() => ({})) as {
    error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> };
  };
  const reason = body.error?.details?.[0]?.errorCode ?? body.error?.status ?? body.error?.message;
  return { ok: false, statusCode: res.status, reason };
}

export interface SendFcmToUserResult {
  sentCount: number;
  failedCount: number;
}

/**
 * Fan out an FCM push to every Android device registered to a user.
 * No-op when FCM isn't configured. Drops device tokens FCM reports as
 * permanently invalid (UNREGISTERED / INVALID_ARGUMENT) so they don't get
 * retried indefinitely — same self-healing pattern as apns-notify.
 */
export async function sendFcmToUser(opts: {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<SendFcmToUserResult> {
  if (!isFcmConfigured()) return { sentCount: 0, failedCount: 0 };

  const devices = await prisma.userDevice.findMany({
    where: { userId: opts.userId, platform: "ANDROID" },
    select: { id: true, deviceToken: true }
  });
  if (devices.length === 0) return { sentCount: 0, failedCount: 0 };

  let sentCount = 0;
  let failedCount = 0;

  await Promise.all(devices.map(async (d) => {
    try {
      const r = await sendFcmPush({
        deviceToken: d.deviceToken,
        title: opts.title,
        body: opts.body,
        data: opts.data
      });
      if (r.ok) {
        sentCount += 1;
        return;
      }
      failedCount += 1;
      // FCM marks dead tokens as UNREGISTERED (the device uninstalled / wiped
      // app data) or INVALID_ARGUMENT (the token shape is wrong). Either way
      // it'll never succeed — prune it.
      if (r.reason === "UNREGISTERED" || r.reason === "INVALID_ARGUMENT" || r.statusCode === 404) {
        await prisma.userDevice.delete({ where: { id: d.id } }).catch(() => {});
      } else {
        console.warn(`[fcm] push failed user=${opts.userId} status=${r.statusCode} reason=${r.reason ?? "?"}`);
      }
    } catch (err) {
      failedCount += 1;
      console.error(`[fcm] push error user=${opts.userId}:`, err);
    }
  }));

  return { sentCount, failedCount };
}
