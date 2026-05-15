/**
 * Unified push notification fan-out across all platforms.
 *
 * Wraps `sendApnsToUser` (iOS) and `sendFcmToUser` (Android) so callers don't
 * have to think about which platforms a user has devices on, or which provider
 * is configured. Both helpers no-op cleanly when their provider env vars are
 * unset, so deployments without FCM (or without APNs) keep working.
 */

import { sendApnsToUser } from "./apns-notify.js";
import { sendFcmToUser } from "./fcm-notify.js";

export interface SendPushToUserResult {
  apnsSentCount: number;
  apnsFailedCount: number;
  fcmSentCount: number;
  fcmFailedCount: number;
}

/**
 * Fan out a push to every device registered to a user, across iOS (APNs) and
 * Android (FCM). Runs both providers in parallel and aggregates the counts.
 */
export async function sendPushToUser(opts: {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  badge?: number;
}): Promise<SendPushToUserResult> {
  const [apns, fcm] = await Promise.all([
    sendApnsToUser(opts),
    sendFcmToUser({ userId: opts.userId, title: opts.title, body: opts.body, data: opts.data })
  ]);

  return {
    apnsSentCount: apns.sentCount,
    apnsFailedCount: apns.failedCount,
    fcmSentCount: fcm.sentCount,
    fcmFailedCount: fcm.failedCount
  };
}
