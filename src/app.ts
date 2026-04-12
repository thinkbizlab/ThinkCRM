import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { healthRoutes } from "./modules/health/routes.js";
import { tenantRoutes } from "./modules/tenants/routes.js";
import { requestContextPlugin } from "./plugins/request-context.js";
import { masterDataRoutes } from "./modules/master-data/routes.js";
import { dealRoutes } from "./modules/deals/routes.js";
import { visitRoutes } from "./modules/visits/routes.js";
import { integrationRoutes } from "./modules/integrations/routes.js";
import { aiRoutes } from "./modules/ai/routes.js";
import { dashboardRoutes } from "./modules/dashboard/routes.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { apiFirstRoutes } from "./modules/api-first/routes.js";
import { config } from "./config.js";
import { authRoutes } from "./modules/auth/routes.js";
import { billingRoutes } from "./modules/billing/routes.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  const __dirname = dirname(fileURLToPath(import.meta.url));

  await app.register(sensible);
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024
    }
  });
  await app.register(jwt, {
    secret: config.JWT_SECRET
  });
  await app.register(requestContextPlugin);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "ThinkCRM API",
        version: "1.0.0"
      }
    }
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs"
  });
  await app.register(fastifyStatic, {
    root: join(__dirname, "..", "web"),
    prefix: "/"
  });

  await app.register(healthRoutes, { prefix: "/api/v1" });
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(tenantRoutes, { prefix: "/api/v1" });
  await app.register(masterDataRoutes, { prefix: "/api/v1" });
  await app.register(dealRoutes, { prefix: "/api/v1" });
  await app.register(visitRoutes, { prefix: "/api/v1" });
  await app.register(billingRoutes, { prefix: "/api/v1" });
  await app.register(integrationRoutes, { prefix: "/api/v1" });
  await app.register(aiRoutes, { prefix: "/api/v1" });
  await app.register(dashboardRoutes, { prefix: "/api/v1" });
  await app.register(settingsRoutes, { prefix: "/api/v1" });
  await app.register(apiFirstRoutes, { prefix: "/api/v1" });

  app.get("/openapi.json", async () => app.swagger());
  app.get("/", async (_, reply) => reply.sendFile("index.html"));
  app.get("/master/:page", async (_, reply) => reply.sendFile("index.html"));

  return app;
}
