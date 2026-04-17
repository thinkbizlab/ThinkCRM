/**
 * Vercel Domains API — auto-provision custom domains on Vercel
 * when a tenant verifies their domain, and remove on delete.
 *
 * Requires VERCEL_PROJECT_ID and VERCEL_API_TOKEN env vars.
 * When not configured, operations are no-ops (logged as warnings).
 */

import { config } from "../config.js";

const VERCEL_API = "https://api.vercel.com";

function isConfigured(): boolean {
  return Boolean(config.VERCEL_PROJECT_ID && config.VERCEL_API_TOKEN);
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.VERCEL_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * Add a custom domain to the Vercel project.
 * Vercel auto-provisions SSL for the domain.
 * Idempotent — adding a domain that already exists returns 409, which we ignore.
 */
export async function addVercelDomain(domain: string): Promise<{ added: boolean; error?: string }> {
  if (!isConfigured()) {
    console.warn(`[vercel-domains] Skipped adding "${domain}" — VERCEL_PROJECT_ID or VERCEL_API_TOKEN not configured.`);
    return { added: false, error: "Not configured" };
  }

  try {
    const res = await fetch(`${VERCEL_API}/v10/projects/${config.VERCEL_PROJECT_ID}/domains`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: domain }),
    });

    if (res.ok) {
      console.log(`[vercel-domains] Added "${domain}" to Vercel project.`);
      return { added: true };
    }

    const body = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };

    // 409 = domain already exists on this project — that's fine
    if (res.status === 409) {
      console.log(`[vercel-domains] "${domain}" already exists on Vercel project.`);
      return { added: true };
    }

    const msg = body.error?.message ?? `HTTP ${res.status}`;
    console.error(`[vercel-domains] Failed to add "${domain}": ${msg}`);
    return { added: false, error: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vercel-domains] Error adding "${domain}": ${msg}`);
    return { added: false, error: msg };
  }
}

/**
 * Remove a custom domain from the Vercel project.
 * Idempotent — removing a domain that doesn't exist returns 404, which we ignore.
 */
export async function removeVercelDomain(domain: string): Promise<{ removed: boolean; error?: string }> {
  if (!isConfigured()) {
    console.warn(`[vercel-domains] Skipped removing "${domain}" — VERCEL_PROJECT_ID or VERCEL_API_TOKEN not configured.`);
    return { removed: false, error: "Not configured" };
  }

  try {
    const res = await fetch(`${VERCEL_API}/v10/projects/${config.VERCEL_PROJECT_ID}/domains/${domain}`, {
      method: "DELETE",
      headers: headers(),
    });

    if (res.ok || res.status === 404) {
      console.log(`[vercel-domains] Removed "${domain}" from Vercel project.`);
      return { removed: true };
    }

    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    console.error(`[vercel-domains] Failed to remove "${domain}": ${msg}`);
    return { removed: false, error: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vercel-domains] Error removing "${domain}": ${msg}`);
    return { removed: false, error: msg };
  }
}
