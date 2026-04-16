/**
 * Email notification helper using nodemailer over SMTP.
 * Credentials stored in TenantIntegrationCredential (platform = EMAIL):
 *   clientIdRef     → SMTP host
 *   clientSecretRef → SMTP port (default 587)
 *   webhookTokenRef → From address
 *   apiKeyRef       → SMTP password / API key
 */

import nodemailer from "nodemailer";

export interface EmailNotifyResult {
  ok: boolean;
  message: string;
}

export interface EmailConfig {
  host: string;
  port: number;
  fromAddress: string;
  password: string;
}

export interface EmailFact {
  label: string;
  value: string;
}

export interface EmailCardOptions {
  subject: string;
  title: string;
  facts: EmailFact[];
  footer?: string;
  /** Full URL for the "View Details" CTA button (e.g. https://crm.example.com/visits) */
  detailUrl?: string;
}

function buildHtml(opts: EmailCardOptions): string {
  const rows = opts.facts.map(f => `
    <tr>
      <td style="padding:6px 12px 6px 0;color:#64748b;font-size:13px;white-space:nowrap;vertical-align:top">${f.label}</td>
      <td style="padding:6px 0;font-size:13px;color:#0f172a;vertical-align:top">${f.value}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <!-- Header -->
        <tr>
          <td style="background:#6d28d9;padding:20px 28px">
            <p style="margin:0;color:#ffffff;font-size:17px;font-weight:700">${opts.title}</p>
          </td>
        </tr>
        <!-- Facts -->
        <tr>
          <td style="padding:20px 28px">
            <table width="100%" cellpadding="0" cellspacing="0">
              ${rows}
            </table>
          </td>
        </tr>
        ${opts.detailUrl ? `
        <!-- CTA -->
        <tr>
          <td style="padding:0 28px 20px">
            <a href="${opts.detailUrl}" style="display:inline-block;padding:10px 20px;background:#6d28d9;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;border-radius:6px">View Details →</a>
          </td>
        </tr>` : ""}
        ${opts.footer ? `
        <!-- Footer -->
        <tr>
          <td style="padding:12px 28px 20px;border-top:1px solid #e2e8f0">
            <p style="margin:0;color:#94a3b8;font-size:12px">${opts.footer}</p>
          </td>
        </tr>` : ""}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildText(opts: EmailCardOptions): string {
  const lines = opts.facts.map(f => `${f.label}: ${f.value}`).join("\n");
  return `${opts.title}\n${"─".repeat(40)}\n${lines}${opts.footer ? `\n\n${opts.footer}` : ""}`;
}

export async function sendEmailCard(
  config: EmailConfig,
  to: string,
  opts: EmailCardOptions
): Promise<EmailNotifyResult> {
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: {
        user: config.fromAddress,
        pass: config.password
      }
    });

    await transporter.sendMail({
      from: config.fromAddress,
      to,
      subject: opts.subject,
      text: buildText(opts),
      html: buildHtml(opts)
    });

    return { ok: true, message: "Email sent successfully." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `SMTP error: ${msg.slice(0, 120)}` };
  }
}
