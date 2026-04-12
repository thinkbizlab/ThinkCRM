import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

function assertTenantScopedObjectKey(tenantId: string, objectKey: string): string {
  const expectedPrefix = `tenants/${tenantId}/`;
  if (objectKey.startsWith("tenants/") && !objectKey.startsWith(expectedPrefix)) {
    throw new Error("Cross-tenant object access is not allowed.");
  }
  if (objectKey.startsWith(expectedPrefix)) {
    return objectKey;
  }
  return `${expectedPrefix}${objectKey}`;
}

function parseObjectKeyInput(tenantId: string, rawInput: string): string {
  const trimmed = rawInput.trim();
  if (trimmed.startsWith("r2://")) {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== config.R2_BUCKET) {
      throw new Error("object reference bucket mismatch.");
    }
    const keyFromRef = normalizeObjectKey(parsed.pathname.replace(/^\/+/, ""));
    return assertTenantScopedObjectKey(tenantId, keyFromRef);
  }

  const normalized = normalizeObjectKey(trimmed);
  return assertTenantScopedObjectKey(tenantId, normalized);
}

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

export function normalizeTenantObjectKey(tenantId: string, objectKeyOrRef: string): string {
  return parseObjectKeyInput(tenantId, objectKeyOrRef);
}

export async function createR2PresignedUpload(input: {
  tenantId: string;
  objectKeyOrRef: string;
  contentType?: string;
  expiresInSeconds?: number;
}) {
  const objectKey = parseObjectKeyInput(input.tenantId, input.objectKeyOrRef);
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
  tenantId: string;
  objectKeyOrRef: string;
  expiresInSeconds?: number;
}) {
  const objectKey = parseObjectKeyInput(input.tenantId, input.objectKeyOrRef);
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

export async function uploadBufferToR2(input: {
  tenantId: string;
  objectKeyOrRef: string;
  contentType: string;
  data: Buffer;
}) {
  const objectKey = parseObjectKeyInput(input.tenantId, input.objectKeyOrRef);
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
