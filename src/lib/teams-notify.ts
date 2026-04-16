/**
 * Microsoft Teams Incoming Webhook — Adaptive Card helper.
 * Sends a nicely formatted card via a per-team webhook URL.
 * No OAuth needed — the webhook URL is the credential.
 */

import { createHash } from "node:crypto";

export interface TeamsNotifyResult {
  ok: boolean;
  status: number;
  message: string;
}

export interface TeamsFact {
  title: string;
  value: string;
}

export interface TeamsCardOptions {
  /** Headline e.g. "📍 Check-In Notification" */
  title: string;
  /** Optional coloured bar at the top: "good" | "warning" | "attention" | "accent" */
  accentColor?: "good" | "warning" | "attention" | "accent";
  facts: TeamsFact[];
  /** Footer line e.g. "[AppName]" */
  footer?: string;
}

function buildAdaptiveCard(opts: TeamsCardOptions): object {
  const bodyBlocks: object[] = [
    {
      type: "TextBlock",
      text: opts.title,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
      color: opts.accentColor === "good" ? "Good"
           : opts.accentColor === "attention" ? "Attention"
           : opts.accentColor === "warning" ? "Warning"
           : "Default"
    },
    {
      type: "FactSet",
      facts: opts.facts.map(f => ({ title: f.title, value: f.value }))
    }
  ];

  if (opts.footer) {
    bodyBlocks.push({
      type: "TextBlock",
      text: opts.footer,
      isSubtle: true,
      size: "Small",
      spacing: "Small",
      wrap: true
    });
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: bodyBlocks
        }
      }
    ]
  };
}

export async function sendTeamsCard(
  webhookUrl: string,
  opts: TeamsCardOptions
): Promise<TeamsNotifyResult> {
  const payload = buildAdaptiveCard(opts);

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (res.ok) {
    return { ok: true, status: res.status, message: "Message sent successfully." };
  }

  let errMsg = `Teams webhook error ${res.status}`;
  try {
    const body = await res.text();
    if (body) errMsg = `Teams webhook: ${body.slice(0, 120)}`;
  } catch { /* ignore */ }
  return { ok: false, status: res.status, message: errMsg };
}

/** Simple text-only fallback (used for test connection) */
export async function sendTeamsWebhook(
  webhookUrl: string,
  text: string
): Promise<TeamsNotifyResult> {
  return sendTeamsCard(webhookUrl, {
    title: text,
    facts: []
  });
}

// ── Microsoft Graph — proactive personal DM ──────────────────────────────────
//
// This approach is more reliable than Bot Framework because it uses the
// installed app's 1:1 chat directly — no pairwise ID required.
// Requires: Chat.ReadWrite.All + TeamsAppInstallation.ReadForUser.All permissions
// on the MS365 app registration (clientId / clientSecret / tenantId).

export interface GraphDmCredentials {
  /** Azure AD app registration Client ID (MS365 TIC clientIdRef) */
  clientId: string;
  /** Azure AD app registration Client Secret (MS365 TIC clientSecretRef) */
  clientSecret: string;
  /** Azure AD tenant ID (MS365 TIC webhookTokenRef) */
  tenantId: string;
  /** Bot Framework app ID (MS_TEAMS TIC clientIdRef) — used to derive stableTeamsAppId */
  botAppId: string;
}

/** Derives a stable, deterministic UUID from the bot App ID. */
function stableTeamsAppId(botAppId: string): string {
  const h = createHash("sha256").update("thinkcrm-teams-app:" + botAppId).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${(["8","9","a","b"] as const)[parseInt(h[16]!, 16) & 3]}${h.slice(17,20)}-${h.slice(20,32)}`;
}

async function getGraphToken(creds: { clientId: string; clientSecret: string; tenantId: string }): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: "https://graph.microsoft.com/.default"
      })
    }
  );
  const tok = await res.json() as { access_token?: string; error_description?: string };
  if (!tok.access_token) throw new Error(tok.error_description ?? "Graph token request failed");
  return tok.access_token;
}

/**
 * Send a proactive Teams DM via Microsoft Graph API.
 * Uses the installed bot app's 1:1 chat — avoids Bot Framework pairwise ID issues.
 *
 * @param aadObjectId   Raw AAD Object ID of the target user (strip "8:orgid:" prefix before passing)
 * @param creds         MS365 app registration credentials + bot App ID
 * @param text          Message text to send
 * @param cachedChatId  Previously retrieved chatId from UserExternalAccount.metadata — skip lookup if present
 * @returns             Result with optional chatId to cache for future sends
 */
export async function sendTeamsDmViaGraph(
  aadObjectId: string,
  creds: GraphDmCredentials,
  text: string,
  cachedChatId?: string
): Promise<TeamsNotifyResult & { chatId?: string }> {
  try {
    const token = await getGraphToken(creds);
    console.log(`[teams-graph] Token acquired for clientId=${creds.clientId}`);

    let chatId = cachedChatId;

    // ── Slow path: find the installed app and get its chat ────────────────────
    if (!chatId) {
      const externalId = stableTeamsAppId(creds.botAppId);
      console.log(`[teams-graph] Looking up installed app externalId=${externalId} for aadObjectId=${aadObjectId}`);

      const appsUrl = `https://graph.microsoft.com/v1.0/users/${aadObjectId}/teamwork/installedApps` +
        `?$filter=teamsApp/externalId eq '${externalId}'&$expand=teamsApp&$select=id`;

      const appsRes = await fetch(appsUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const appsBody = await appsRes.json() as { value?: Array<{ id: string }> };
      const installId = appsBody.value?.[0]?.id;

      if (!installId) {
        const detail = JSON.stringify(appsBody).slice(0, 300);
        console.warn(`[teams-graph] App not installed for user ${aadObjectId}: ${detail}`);
        return { ok: false, status: appsRes.status, message: `Teams app not installed for user. Push app first via Settings → Integrations → Microsoft Teams. Detail: ${detail}` };
      }

      console.log(`[teams-graph] Found installId=${installId}, fetching chat`);
      const chatRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${aadObjectId}/teamwork/installedApps/${installId}/chat`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const chatBody = await chatRes.json() as { id?: string; error?: { message?: string } };

      if (!chatBody.id) {
        const detail = chatBody.error?.message ?? JSON.stringify(chatBody).slice(0, 200);
        console.warn(`[teams-graph] Could not get chat for installId=${installId}: ${detail}`);
        return { ok: false, status: chatRes.status, message: `Could not get Teams 1:1 chat: ${detail}` };
      }

      chatId = chatBody.id;
      console.log(`[teams-graph] Got chatId=${chatId}`);
    }

    // ── Send the message ──────────────────────────────────────────────────────
    const msgRes = await fetch(`https://graph.microsoft.com/v1.0/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: { contentType: "text", content: text } })
    });

    if (msgRes.ok) {
      console.log(`[teams-graph] Message sent via Graph to chatId=${chatId}`);
      return { ok: true, status: msgRes.status, message: "Direct message sent via Graph.", chatId };
    }

    let errMsg = `Graph DM error ${msgRes.status}`;
    try { const b = await msgRes.text(); if (b) errMsg = `Graph DM (${msgRes.status}): ${b.slice(0, 300)}`; } catch { /* ignore */ }
    console.warn(`[teams-graph] ${errMsg}`);
    return { ok: false, status: msgRes.status, message: errMsg };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[teams-graph] Unexpected error:`, err);
    return { ok: false, status: 0, message };
  }
}

// ── Bot Framework — proactive personal DM ────────────────────────────────────

interface BotCredentials {
  appId: string;
  appPassword: string;
  tenantId: string;
}

/** Acquire a Bot Framework access token using client credentials. */
async function getBotToken(creds: BotCredentials): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.appId,
        client_secret: creds.appPassword,
        scope: "https://api.botframework.com/.default"
      })
    }
  );
  const tok = await res.json() as { access_token?: string; error_description?: string };
  if (!tok.access_token) throw new Error(tok.error_description ?? "Bot token request failed");
  return tok.access_token;
}

/**
 * Send a proactive personal DM to a Teams user via Bot Framework REST API.
 *
 * @param userMri   The user's Teams MRI — "8:orgid:{aadObjectId}" stored in UserExternalAccount
 * @param creds     Bot App ID + Password + Azure AD tenant ID (from MS_TEAMS TIC)
 * @param text      Plain text message to send
 */
/**
 * Bot Framework regional service URLs used as fallback when no stored conversation reference exists.
 * Thailand/SEA is under APAC ("ap").
 */
const BOT_SERVICE_URLS = [
  "https://smba.trafficmanager.net/ap/",    // APAC — Thailand, SEA
  "https://smba.trafficmanager.net/amer/",  // Americas
  "https://smba.trafficmanager.net/apis/",  // Global / legacy
];

async function sendToConversation(
  serviceUrl: string,
  conversationId: string,
  token: string,
  botAppId: string,
  text: string
): Promise<TeamsNotifyResult> {
  const base = serviceUrl.endsWith("/") ? serviceUrl : serviceUrl + "/";
  const url = `${base}v3/conversations/${conversationId}/activities`;
  const msgRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: "message", from: { id: `28:${botAppId}`, name: "ThinkCRM" }, text })
  });
  if (msgRes.ok) return { ok: true, status: msgRes.status, message: "Direct message sent." };
  let errMsg = `Bot DM error ${msgRes.status}`;
  try { const b = await msgRes.text(); if (b) errMsg = `Bot DM (${msgRes.status}): ${b.slice(0, 300)}`; } catch { /* ignore */ }
  return { ok: false, status: msgRes.status, message: errMsg };
}

export interface TeamsConversationRef {
  serviceUrl: string;
  conversationId: string;
}

export async function sendTeamsDirectMessage(
  userMri: string,
  creds: BotCredentials,
  text: string,
  /** Stored conversation reference from when the user opened the bot — preferred over creating a new one */
  convRef?: TeamsConversationRef
): Promise<TeamsNotifyResult> {
  try {
    const token = await getBotToken(creds);
    console.log(`[teams-dm] Token acquired for appId=${creds.appId}`);

    // ── Fast path: use stored conversation reference ──────────────────────────
    if (convRef?.serviceUrl && convRef?.conversationId) {
      console.log(`[teams-dm] Using stored convRef serviceUrl=${convRef.serviceUrl} convId=${convRef.conversationId}`);
      const result = await sendToConversation(convRef.serviceUrl, convRef.conversationId, token, creds.appId, text);
      if (result.ok) return result;
      console.warn(`[teams-dm] Stored convRef failed: ${result.message} — falling back to create-conversation`);
    }

    // ── Slow path: create a new 1:1 conversation ──────────────────────────────
    // Teams Bot Framework uses 29:{aadId} for users and 28:{appId} for bots
    const aadId = userMri.replace(/^8:orgid:/, "").replace(/^29:/, "");
    const teamsUserId = `29:${aadId}`;
    const teamsBotId  = `28:${creds.appId}`;

    const createBody = JSON.stringify({
      bot: { id: teamsBotId, name: "ThinkCRM" },
      members: [{ id: teamsUserId, tenantId: creds.tenantId }],
      channelData: { tenant: { id: creds.tenantId } },
      tenantId: creds.tenantId,
      isGroup: false
    });

    let lastErr = "No service URL succeeded";

    for (const serviceUrl of BOT_SERVICE_URLS) {
      console.log(`[teams-dm] Trying create-conversation serviceUrl=${serviceUrl} userMri=${userMri}`);
      const convRes = await fetch(`${serviceUrl}v3/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: createBody
      });

      const convText = await convRes.text();
      let conv: { id?: string; serviceUrl?: string; error?: { message?: string } } = {};
      try { conv = JSON.parse(convText); } catch { /* ignore */ }

      if (!conv.id) {
        const errMsg = conv.error?.message ?? `Conversation create failed (${convRes.status}): ${convText.slice(0, 200)}`;
        console.warn(`[teams-dm] ${serviceUrl} — ${errMsg}`);
        lastErr = errMsg;
        continue;
      }

      // Use the serviceUrl from the response — the conversation ID is encrypted per-region
      // and can only be used with the exact service URL that issued it
      const sendUrl = conv.serviceUrl ?? serviceUrl;
      console.log(`[teams-dm] Conversation created id=${conv.id} responseServiceUrl=${conv.serviceUrl ?? "(none)"} sendUrl=${sendUrl}`);
      const result = await sendToConversation(sendUrl, conv.id, token, creds.appId, text);
      if (result.ok) return result;
      lastErr = result.message;
    }

    return { ok: false, status: 0, message: lastErr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[teams-dm] Unexpected error:`, err);
    return { ok: false, status: 0, message };
  }
}
