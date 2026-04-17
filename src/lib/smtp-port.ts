/**
 * Safe SMTP port extractor.
 *
 * Integration credentials store the SMTP port in clientSecretRef (overloaded field).
 * parseInt() silently returns NaN for non-numeric strings, which causes nodemailer
 * to fall back to port 0 and fail. This helper validates and returns a safe default.
 */

export function smtpPort(raw: string | null | undefined): number {
  const n = raw == null ? NaN : parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 587;
  return n;
}
