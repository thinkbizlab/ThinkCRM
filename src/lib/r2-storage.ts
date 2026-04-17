import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";

const R2_ENDPOINT = `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const DEFAULT_SIGNED_URL_SECONDS = config.R2_SIGNED_URL_EXPIRES_SECONDS;
const OBJECT_KEY_PATTERN = /^[a-zA-Z0-9/_\-\.]+$/;
const MAX_OBJECT_KEY_LENGTH = 512;

function normalizeObjectKey(rawObjectKey: string): string {
  const trimmed = rawObjectKey.trim();
  if (!trimmed) {
    throw new Error("objectKey is required.");
  }

  const withoutLeadingSlash = trimmed.replace(/^\/+/, "");
  if (
    withoutLeadingSlash.includes("..") ||
    withoutLeadingSlash.includes("\\") ||
    withoutLeadingSlash.includes("?") ||
    withoutLeadingSlash.includes("#")
  ) {
    throw new Error("objectKey contains invalid path characters.");
  }
  if (withoutLeadingSlash.length > MAX_OBJECT_KEY_LENGTH) {
    throw new Error("objectKey exceeds maximum length.");
  }
  if (!OBJECT_KEY_PATTERN.test(withoutLeadingSlash)) {
    throw new Error("objectKey may only contain letters, numbers, '/', '_', '-', and '.'.");
  }

  return withoutLeadingSlash;
}

/**
 * Ensures the object key is scoped to the given tenant slug.
 * - r2:// refs must already start with "{tenantSlug}/" (cross-tenant protection).
 * - Raw keys get the "{tenantSlug}/" prefix added automatically.
 */
function parseObjectKeyInput(tenantSlug: string, rawInput: string): string {
  const slugPrefix = `${tenantSlug}/`;
  const trimmed = rawInput.trim();

  if (trimmed.startsWith("r2://")) {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== config.R2_BUCKET) {
      throw new Error("object reference bucket mismatch.");
    }
    const keyFromRef = normalizeObjectKey(parsed.pathname.replace(/^\/+/, ""));
    if (!keyFromRef.startsWith(slugPrefix)) {
      throw new Error("Cross-tenant object access is not allowed.");
    }
    return keyFromRef;
  }

  const normalized = normalizeObjectKey(trimmed);
  if (normalized.startsWith(slugPrefix)) {
    return normalized;
  }
  return `${slugPrefix}${normalized}`;
}

export const isR2Configured =
  config.R2_ACCOUNT_ID !== "local-account" &&
  config.R2_ACCESS_KEY_ID !== "local-access-key" &&
  config.R2_SECRET_ACCESS_KEY !== "local-secret-key";

const r2Client = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY
  }
});

export function buildR2ObjectRef(objectKey: string): string {
  return `r2://${config.R2_BUCKET}/${objectKey}`;
}

/**
 * Returns a direct public HTTPS URL for an object key when R2_PUBLIC_URL is configured.
 * Returns null if public URL is not configured (caller should fall back to presigned URL).
 */
export function buildR2PublicUrl(objectKeyOrRef: string): string | null {
  if (!config.R2_PUBLIC_URL) return null;
  const key = objectKeyOrRef.startsWith("r2://")
    ? objectKeyOrRef.slice(`r2://${config.R2_BUCKET}/`.length)
    : objectKeyOrRef.replace(/^\/+/, "");
  return `${config.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

export function normalizeTenantObjectKey(tenantSlug: string, objectKeyOrRef: string): string {
  return parseObjectKeyInput(tenantSlug, objectKeyOrRef);
}

export async function createR2PresignedUpload(input: {
  tenantSlug: string;
  objectKeyOrRef: string;
  contentType?: string;
  expiresInSeconds?: number;
}) {
  const objectKey = parseObjectKeyInput(input.tenantSlug, input.objectKeyOrRef);
  const command = new PutObjectCommand({
    Bucket: config.R2_BUCKET,
    Key: objectKey,
    ...(input.contentType ? { ContentType: input.contentType } : {})
  });
  const expiresIn = input.expiresInSeconds ?? DEFAULT_SIGNED_URL_SECONDS;
  const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn });
  return {
    objectKey,
    objectRef: buildR2ObjectRef(objectKey),
    uploadUrl,
    requiredHeaders: input.contentType ? { "content-type": input.contentType } : {},
    expiresInSeconds: expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
  };
}

export async function createR2PresignedDownload(input: {
  tenantSlug: string;
  objectKeyOrRef: string;
  expiresInSeconds?: number;
}) {
  const objectKey = parseObjectKeyInput(input.tenantSlug, input.objectKeyOrRef);
  const command = new GetObjectCommand({
    Bucket: config.R2_BUCKET,
    Key: objectKey
  });
  const expiresIn = input.expiresInSeconds ?? DEFAULT_SIGNED_URL_SECONDS;
  const downloadUrl = await getSignedUrl(r2Client, command, { expiresIn });
  return {
    objectKey,
    objectRef: buildR2ObjectRef(objectKey),
    downloadUrl,
    expiresInSeconds: expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
  };
}

export async function deleteR2Object(tenantSlug: string, objectKeyOrRef: string): Promise<void> {
  if (!isR2Configured) return; // no-op in dev
  const objectKey = parseObjectKeyInput(tenantSlug, objectKeyOrRef);
  await r2Client.send(new DeleteObjectCommand({ Bucket: config.R2_BUCKET, Key: objectKey }));
}

export async function uploadBufferToR2(input: {
  tenantSlug: string;
  objectKeyOrRef: string;
  contentType: string;
  data: Buffer;
}) {
  const objectKey = parseObjectKeyInput(input.tenantSlug, input.objectKeyOrRef);

  if (!isR2Configured) {
    // R2 not configured (dev/local) — skip actual upload, return a placeholder ref.
    return {
      objectKey,
      objectRef: `dev://${objectKey}`
    };
  }

  try {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: config.R2_BUCKET,
        Key: objectKey,
        Body: input.data,
        ContentType: input.contentType
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown R2 upload failure.";
    throw new Error(`R2 upload failed: ${message}`);
  }
  return {
    objectKey,
    objectRef: buildR2ObjectRef(objectKey)
  };
}
