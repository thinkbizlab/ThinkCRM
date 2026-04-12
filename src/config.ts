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
  R2_SIGNED_URL_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(3600).default(900)
});

export type AppConfig = z.infer<typeof configSchema>;
export const config: AppConfig = configSchema.parse(process.env);
