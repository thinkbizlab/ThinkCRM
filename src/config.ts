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
  // Optional: public URL of this app (e.g. https://crm.example.com). Used for deep links in email notifications and OAuth redirect URIs.
  APP_URL: z.preprocess(v => (v === "" ? undefined : v), z.string().url().optional()),
  // Optional: Microsoft OAuth (MS365 login). Register an app in Azure AD → App registrations.
  MS365_CLIENT_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  MS365_CLIENT_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Tenant ID for single-tenant apps; use "common" for multi-tenant.
  MS365_TENANT_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()).default("common"),
  // Optional: Google OAuth (Gmail login). Register an app in Google Cloud Console.
  GOOGLE_CLIENT_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
});

export type AppConfig = z.infer<typeof configSchema>;
export const config: AppConfig = configSchema.parse(process.env);
