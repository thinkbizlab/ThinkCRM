import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
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
import { startScheduler } from "./lib/scheduler.js";
import { prisma } from "./lib/prisma.js";

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

  const uploadsDir = join(process.cwd(), "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: "/uploads/",
    decorateReply: false
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

  app.get("/api/v1/config/public", async () => ({
    googleMapsApiKey: config.GOOGLE_MAPS_API_KEY ?? null
  }));

  // Teams Bot messaging endpoint — Bot Framework sends all channel events here.
  // We handle conversationUpdate so we can store the real serviceUrl + conversationId
  // for each user who installs the bot, enabling reliable proactive DMs.
  app.post("/api/v1/bot/messages", async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const serviceUrl  = body?.serviceUrl  as string | undefined;
      const conversation = body?.conversation as { id?: string } | undefined;
      const channelData  = body?.channelData  as { tenant?: { id?: string } } | undefined;
      const tenantAadId  = channelData?.tenant?.id;

      // Log every incoming event for debugging
      console.log(`[bot] type=${body?.type} serviceUrl=${serviceUrl} convId=${conversation?.id} tenantAadId=${tenantAadId}`);

      async function storeConvRef(fromId: string, aadObjectId?: string) {
        if (!serviceUrl || !conversation?.id) return;
        // The `from.id` IS the correct MRI Teams uses — store it as-is
        const mri = fromId;
        const aadId = aadObjectId ?? fromId.replace(/^8:orgid:/, "");
        console.log(`[bot] storeConvRef mri=${mri} aadId=${aadId}`);

        // Try to find by exact MRI first, then by aadId suffix
        let acct = await prisma.userExternalAccount.findFirst({
          where: { externalUserId: mri, provider: "MS_TEAMS" }
        });
        if (!acct && aadId) {
          acct = await prisma.userExternalAccount.findFirst({
            where: { externalUserId: `8:orgid:${aadId}`, provider: "MS_TEAMS" }
          });
        }
        if (acct) {
          // Correct the stored MRI to exactly what Teams sends, and store the convRef
          await prisma.userExternalAccount.update({
            where: { id: acct.id },
            data: { externalUserId: mri, metadata: { serviceUrl, conversationId: conversation.id, tenantAadId } }
          });
          console.log(`[bot] Updated MRI and convRef for user=${acct.userId} mri=${mri} serviceUrl=${serviceUrl}`);
        } else {
          console.log(`[bot] No CRM user found for mri=${mri} — user may not have a Teams account linked yet`);
        }
      }

      if (body?.type === "conversationUpdate") {
        const membersAdded = body.membersAdded as Array<{ id: string; aadObjectId?: string }> | undefined;
        const botId = (body.recipient as { id?: string })?.id;
        if (membersAdded?.length) {
          for (const member of membersAdded) {
            if (member.id === botId) continue; // skip bot itself
            await storeConvRef(member.id, member.aadObjectId);
          }
        }
      } else if (body?.type === "message") {
        // When a user sends ANY message to the bot, capture their exact MRI + convRef
        const from = body.from as { id?: string; aadObjectId?: string } | undefined;
        if (from?.id) {
          await storeConvRef(from.id, from.aadObjectId);
        }
      }
    } catch (err) {
      console.error("[bot] conversationUpdate handler error:", err);
    }
    return reply.code(200).send();
  });

  // Mark any runs left in RUNNING state as FAILURE — they were interrupted by a server restart
  prisma.cronJobRun.updateMany({
    where: { status: "RUNNING" },
    data: { status: "FAILURE", summary: "Interrupted — server restarted while job was running", completedAt: new Date() }
  }).then(r => { if (r.count > 0) console.warn(`[startup] Marked ${r.count} interrupted RUNNING job(s) as FAILURE`) })
    .catch(err => console.error("[startup] Failed to clean up stuck jobs:", err));

  startScheduler().catch(err => console.error("[scheduler] startup error:", err));

  app.get("/openapi.json", async () => app.swagger());
  app.get("/", async (_, reply) => reply.sendFile("index.html"));
  app.get("/dashboard", async (_, reply) => reply.sendFile("index.html"));
  app.get("/deals", async (_, reply) => reply.sendFile("index.html"));
  app.get("/visits", async (_, reply) => reply.sendFile("index.html"));
  app.get("/calendar", async (_, reply) => reply.sendFile("index.html"));
  app.get("/integrations", async (_, reply) => reply.sendFile("index.html"));
  app.get("/master/:page", async (_, reply) => reply.sendFile("index.html"));
  app.get("/settings/:page", async (_, reply) => reply.sendFile("index.html"));
  app.get("/settings/scheduled-jobs", async (_, reply) => reply.sendFile("index.html"));
  app.get("/customers/:code", async (_, reply) => reply.sendFile("index.html"));
  app.get("/task", async (_, reply) => reply.sendFile("index.html"));
  app.get("/settings/users/:id", async (_, reply) => reply.sendFile("index.html"));

  return app;
}
