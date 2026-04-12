import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("ThinkCRM API", () => {
  it("returns health status", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/health"
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.status).toBe("ok");
    await app.close();
  });
});
