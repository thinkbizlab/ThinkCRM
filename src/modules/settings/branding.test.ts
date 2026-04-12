import { UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

describe("tenant branding settings", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  async function setupAdminContext() {
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: {
        name: `Tenant ${suffix}`,
        slug: `tenant-${suffix}`
      }
    });
    const admin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `admin-${suffix}@example.com`,
        fullName: "Admin User",
        role: UserRole.ADMIN,
        passwordHash: hashPassword("Password123!")
      }
    });
    const token = await app.jwt.sign({
      tenantId: tenant.id,
      userId: admin.id,
      role: admin.role,
      email: admin.email
    });
    return { tenantId: tenant.id, token };
  }

  function buildMultipartBody(fields: Array<{ name: string; value: string; filename?: string; contentType?: string }>) {
    const boundary = `----thinkcrm-test-${randomUUID()}`;
    const body = fields
      .map((field) => {
        if (field.filename) {
          return [
            `--${boundary}`,
            `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"`,
            `Content-Type: ${field.contentType || "application/octet-stream"}`,
            "",
            field.value
          ].join("\r\n");
        }
        return [`--${boundary}`, `Content-Disposition: form-data; name="${field.name}"`, "", field.value].join(
          "\r\n"
        );
      })
      .join("\r\n");

    return {
      body: `${body}\r\n--${boundary}--\r\n`,
      contentType: `multipart/form-data; boundary=${boundary}`
    };
  }

  it("saves branding colors and accepts tenant upload paths", async () => {
    const { tenantId, token } = await setupAdminContext();
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/tenants/${tenantId}/branding`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        logoUrl: `/uploads/${tenantId}/logo.png`,
        primaryColor: "#abc",
        secondaryColor: "#123456",
        themeMode: "DARK"
      }
    });

    expect(putRes.statusCode).toBe(200);
    const branding = putRes.json();
    expect(branding.logoUrl).toBe(`/uploads/${tenantId}/logo.png`);
    expect(branding.primaryColor).toBe("#aabbcc");
    expect(branding.secondaryColor).toBe("#123456");
    expect(branding.themeMode).toBe("DARK");
  });

  it("rejects invalid branding colors", async () => {
    const { tenantId, token } = await setupAdminContext();
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/tenants/${tenantId}/branding`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        primaryColor: "blue",
        secondaryColor: "#0f172a",
        themeMode: "LIGHT"
      }
    });

    expect(putRes.statusCode).toBe(400);
    expect(putRes.json().message).toContain("primaryColor must be hex");
  });

  it("rejects unsupported logo file types", async () => {
    const { tenantId, token } = await setupAdminContext();
    const multipart = buildMultipartBody([
      {
        name: "file",
        filename: "logo.txt",
        contentType: "text/plain",
        value: "not an image"
      }
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${tenantId}/branding/logo`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Unsupported logo file type");
  });
});
