import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16).default("thinkcrm-dev-secret-please-change"),
  R2_ACCOUNT_ID: z.string().min(1).default("local-account"),
  R2_ACCESS_KEY_ID: z.string().min(1).default("local-access-key"),
  R2_SECRET_ACCESS_KEY: z.string().min(1).default("local-secret-key"),
  R2_BUCKET: z.string().min(3).max(63).default("thinkcrm-dev"),
  R2_SIGNED_URL_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  // Optional: public bucket URL (e.g. https://pub-xxxx.r2.dev or custom domain).
  // When set, public objects are served directly without signed URLs.
  R2_PUBLIC_URL: z.preprocess(v => (v === "" ? undefined : v), z.string().url().optional()),
  GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.preprocess(v => (v === "" ? undefined : v), z.string().min(1).optional()),
  // Optional: public URL of this app (e.g. https://app.thinkbizcrm.com). Used for deep links in email notifications and OAuth redirect URIs.
  APP_URL: z.preprocess(v => (v === "" ? undefined : v), z.string().url().optional()),
  // Optional: base domain for tenant subdomains (e.g. "thinkbizcrm.com").
  // When set, {slug}.thinkbizcrm.com is automatically resolved to the matching tenant.
  // Requires wildcard DNS (*.thinkbizcrm.com) pointing to this server.
  BASE_DOMAIN: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Optional: Microsoft OAuth (MS365 login). Register an app in Azure AD → App registrations.
  MS365_CLIENT_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  MS365_CLIENT_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Tenant ID for single-tenant apps; use "common" for multi-tenant.
  MS365_TENANT_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()).default("common"),
  // Optional: Google OAuth (Gmail login). Register an app in Google Cloud Console.
  GOOGLE_CLIENT_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Optional in dev; REQUIRED in production. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ENCRYPTION_KEY: z.preprocess(v => (v === "" ? undefined : v), z.string().regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be 64 hex characters").optional()),
  // Optional: system-level SMTP for password reset emails when the tenant has no EMAIL integration.
  SMTP_HOST: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  SMTP_PASS: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  SMTP_FROM: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Optional: Stripe billing. Get keys from dashboard.stripe.com → Developers → API keys.
  STRIPE_SECRET_KEY:    z.preprocess(v => (v === "" ? undefined : v), z.string().startsWith("sk_").optional()),
  STRIPE_WEBHOOK_SECRET:z.preprocess(v => (v === "" ? undefined : v), z.string().startsWith("whsec_").optional()),
  // Stripe Price ID for the default monthly plan (Products → Prices).
  STRIPE_PRICE_ID:      z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Optional: Apple Push Notification service (APNs) for iOS push notifications.
  // Generate a .p8 key file in Apple Developer → Keys → APNs.
  APNS_KEY_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  APNS_TEAM_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  APNS_BUNDLE_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Path to the .p8 private key file, or the key content as a string.
  APNS_KEY_PATH: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Set to "production" for App Store builds; defaults to "development" for TestFlight/dev.
  APNS_ENVIRONMENT: z.enum(["development", "production"]).default("development"),
  // Optional: Vercel Cron secret — protects /api/v1/cron/* endpoints.
  // Auto-set by Vercel when you add cron jobs. Generate your own for non-Vercel deployments.
  CRON_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().min(16).optional()),
});

export type AppConfig = z.infer<typeof configSchema>;
export const config: AppConfig = configSchema.parse(process.env);

// C2: Reject insecure JWT_SECRET values in production.
// Checks both the code default and the .env.example placeholder.
const WEAK_JWT_SECRETS = ["thinkcrm-dev-secret-please-change", "change-me-to-a-random-32-char-string"];
if (config.NODE_ENV === "production" && WEAK_JWT_SECRETS.includes(config.JWT_SECRET)) {
  throw new Error("JWT_SECRET must be set to a strong random value in production. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
}
