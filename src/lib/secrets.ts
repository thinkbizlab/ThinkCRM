/**
 * App-level AES-256-GCM encryption for integration credentials stored in DB.
 *
 * Set ENCRYPTION_KEY to a 64-char hex string (32 bytes) to enable encryption.
 * Without ENCRYPTION_KEY the helpers are transparent passthroughs — safe for dev.
 *
 * Encrypted format: enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 * Unencrypted values (pre-migration rows or dev mode) are returned as-is on decrypt.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";

const ENC_PREFIX = "enc:";
const ALGO = "aes-256-gcm" as const;

function getKey(): Buffer | null {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) return null;
  const buf = Buffer.from(k, "hex");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes / 256 bits).");
  }
  return buf;
}

export function encryptField(value: string | null | undefined): string | null {
  if (value == null) return null;
  const key = getKey();
  if (!key) return value; // dev mode: no key = passthrough
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptField(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!value.startsWith(ENC_PREFIX)) return value; // plaintext (pre-migration row or dev mode)
  const key = getKey();
  if (!key) throw new Error("ENCRYPTION_KEY is required to decrypt stored integration credentials.");
  const rest = value.slice(ENC_PREFIX.length);
  const c1 = rest.indexOf(":");
  const c2 = rest.indexOf(":", c1 + 1);
  if (c1 < 0 || c2 < 0) throw new Error("Malformed encrypted credential value.");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(rest.slice(0, c1), "hex"));
  decipher.setAuthTag(Buffer.from(rest.slice(c1 + 1, c2), "hex"));
  return (
    decipher.update(Buffer.from(rest.slice(c2 + 1), "hex")).toString("utf8") +
    decipher.final("utf8")
  );
}

// ── Generic credential decryptor ─────────────────────────────────────────────

type PartialCred = {
  clientIdRef?: string | null;
  clientSecretRef?: string | null;
  apiKeyRef?: string | null;
  webhookTokenRef?: string | null;
};

export function decryptCredential<T extends PartialCred>(record: T): T;
export function decryptCredential<T extends PartialCred>(record: T | null | undefined): T | null;
export function decryptCredential<T extends PartialCred>(record: T | null | undefined): T | null {
  if (!record) return null;
  const out: Record<string, unknown> = { ...record };
  if ("clientIdRef" in record) out["clientIdRef"] = decryptField(record.clientIdRef);
  if ("clientSecretRef" in record) out["clientSecretRef"] = decryptField(record.clientSecretRef);
  if ("apiKeyRef" in record) out["apiKeyRef"] = decryptField(record.apiKeyRef);
  if ("webhookTokenRef" in record) out["webhookTokenRef"] = decryptField(record.webhookTokenRef);
  return out as T;
}

// ── One-time startup migration ────────────────────────────────────────────────

/**
 * Encrypts any plaintext credential rows in the DB.
 * Safe to call every startup — skips rows that are already encrypted.
 * No-ops when ENCRYPTION_KEY is not set.
 */
export async function migrateCredentialsEncryption(): Promise<void> {
  const key = getKey();
  if (!key) return;

  const rows = await prisma.tenantIntegrationCredential.findMany({
    select: {
      id: true,
      clientIdRef: true,
      clientSecretRef: true,
      apiKeyRef: true,
      webhookTokenRef: true
    }
  });

  for (const row of rows) {
    const needsUpdate =
      (row.clientIdRef != null && !row.clientIdRef.startsWith(ENC_PREFIX)) ||
      (row.clientSecretRef != null && !row.clientSecretRef.startsWith(ENC_PREFIX)) ||
      (row.apiKeyRef != null && !row.apiKeyRef.startsWith(ENC_PREFIX)) ||
      (row.webhookTokenRef != null && !row.webhookTokenRef.startsWith(ENC_PREFIX));

    if (!needsUpdate) continue;

    await prisma.tenantIntegrationCredential.update({
      where: { id: row.id },
      data: {
        ...(row.clientIdRef != null && !row.clientIdRef.startsWith(ENC_PREFIX)
          ? { clientIdRef: encryptField(row.clientIdRef) }
          : {}),
        ...(row.clientSecretRef != null && !row.clientSecretRef.startsWith(ENC_PREFIX)
          ? { clientSecretRef: encryptField(row.clientSecretRef) }
          : {}),
        ...(row.apiKeyRef != null && !row.apiKeyRef.startsWith(ENC_PREFIX)
          ? { apiKeyRef: encryptField(row.apiKeyRef) }
          : {}),
        ...(row.webhookTokenRef != null && !row.webhookTokenRef.startsWith(ENC_PREFIX)
          ? { webhookTokenRef: encryptField(row.webhookTokenRef) }
          : {})
      }
    });
  }
}
