import { config } from "../config.js";
import { prisma } from "./prisma.js";

/**
 * Returns the best public base URL for a tenant, resolved by priority:
 *   1. Verified custom domain  → https://crm.customer.com
 *   2. Subdomain (if BASE_DOMAIN set) → https://{slug}.thinkbizcrm.com
 *   3. APP_URL fallback → https://app.thinkbizcrm.com
 *
 * Used for email deep links, invite URLs, password reset links, etc.
 */
export async function getTenantUrl(tenantId: string, tenantSlug?: string): Promise<string> {
  // 1. Check for a verified custom domain
  const customDomain = await prisma.tenantCustomDomain.findUnique({
    where: { tenantId },
    select: { domain: true, status: true }
  });
  if (customDomain?.status === "VERIFIED") {
    return `https://${customDomain.domain}`;
  }

  // 2. Subdomain if BASE_DOMAIN is configured
  if (config.BASE_DOMAIN) {
    const slug = tenantSlug ?? (await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true }
    }))?.slug;
    if (slug) {
      return `https://${slug}.${config.BASE_DOMAIN}`;
    }
  }

  // 3. Fallback to APP_URL
  return (config.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
