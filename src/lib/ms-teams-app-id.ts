/**
 * Derives a stable, deterministic UUID v4 from the bot App ID.
 * Used as the externalId when uploading the Teams app to the org catalog
 * so the same app can be found by externalId on subsequent deploys.
 *
 * L4: Extracted from settings/routes.ts and teams-notify.ts to eliminate duplication.
 */

import { createHash } from "node:crypto";

export function stableTeamsAppId(botAppId: string): string {
  const h = createHash("sha256").update("thinkcrm-teams-app:" + botAppId).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${(["8","9","a","b"] as const)[parseInt(h[16]!, 16) & 3]}${h.slice(17,20)}-${h.slice(20,32)}`;
}
