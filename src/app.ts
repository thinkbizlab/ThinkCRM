import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

// Bot Framework JWKS — cached once, jose handles key rotation internally
const BOT_FRAMEWORK_JWKS = createRemoteJWKSet(
  new URL("https://login.botframework.com/v1/.well-known/keys")
);
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
import { syncRoutes } from "./modules/sync/routes.js";
import { cronRoutes } from "./modules/cron/routes.js";
import { startScheduler, WORKER_TAG } from "./lib/scheduler.js";
import { prisma } from "./lib/prisma.js";
import { decryptField, migrateCredentialsEncryption } from "./lib/secrets.js";
import { requireActiveTenant } from "./lib/http.js";

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: config.APP_URL ? true : false });
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // C10: Security headers — helmet with a permissive CSP for the current inline-script-heavy frontend.
  // Tighten the CSP incrementally as inline scripts in web/app.js are moved to external files.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "maps.googleapis.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.NODE_ENV === "production" ? [] : null,
      }
    },
    crossOriginEmbedderPolicy: false // allow maps iframe
  });

  // M2: CORS — accept APP_URL, tenant subdomains, and verified custom domains.
  await app.register(cors, {
    origin: config.NODE_ENV === "development"
      ? true
      : (origin, cb) => {
          if (!origin) return cb(null, true); // non-browser (curl, server-to-server)
          // Always allow APP_URL
          if (config.APP_URL && origin === config.APP_URL) return cb(null, true);
          // Allow *.BASE_DOMAIN subdomains
          if (config.BASE_DOMAIN) {
            try {
              const { hostname } = new URL(origin);
              if (hostname.endsWith(`.${config.BASE_DOMAIN}`)) return cb(null, true);
            } catch { /* malformed origin */ }
          }
          // Allow verified custom domains (async lookup)
          (async () => {
            try {
              const { hostname } = new URL(origin);
              const record = await prisma.tenantCustomDomain.findFirst({
                where: { domain: hostname, status: "VERIFIED" },
                select: { id: true }
              });
              return cb(null, !!record);
            } catch {
              return cb(null, false);
            }
          })();
        },
    credentials: true,
  });

  // C8: Rate limiting — global cap, with a stricter limit on auth routes.
  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
  });

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

  // S1: Reject requests from deactivated tenants on every authenticated route.
  // Runs after requestContextPlugin has set the tenantId from the JWT.
  // No-op for unauthenticated (public) routes.
  app.addHook("preHandler", async (request) => {
    await requireActiveTenant(request);
  });

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

  // M4: Only create and serve uploads dir when R2 is not configured.
  // When R2 is active, local disk is unused — no need to create the directory.
  const isR2Configured = config.R2_ACCOUNT_ID !== "local-account";
  if (!isR2Configured) {
    const uploadsDir = join(process.cwd(), "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    await app.register(fastifyStatic, {
      root: uploadsDir,
      prefix: "/uploads/",
      decorateReply: false
    });
  }

  // C8: Tighter per-route rate limit on auth paths (login, OAuth callbacks, branding probe).
  // Must be added before route registration so the config is picked up by @fastify/rate-limit.
  app.addHook("onRoute", (routeOptions) => {
    if (routeOptions.url?.startsWith("/api/v1/auth/")) {
      routeOptions.config = {
        ...(routeOptions.config as object ?? {}),
        rateLimit: { max: 20, timeWindow: "1 minute" }
      };
    }
  });

  // L7: API versioning strategy — all routes live under /api/v1.
  // Policy: v1 is stable and will not have breaking changes. If a breaking change
  // is ever needed, add a /api/v2 prefix and register new route modules under it,
  // keeping v1 modules alive until all clients have migrated. Domain business logic
  // should live in service helpers (src/lib/), not in route handlers, so it can be
  // shared across versions without duplication.
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
  await app.register(syncRoutes, { prefix: "/api/v1" });
  await app.register(cronRoutes, { prefix: "/api/v1" });

  app.get("/api/v1/config/public", async () => ({
    googleMapsApiKey: config.GOOGLE_MAPS_API_KEY ?? null,
    baseDomain: config.BASE_DOMAIN ?? null
  }));

  // Teams Bot messaging endpoint — Bot Framework sends all channel events here.
  // We handle conversationUpdate so we can store the real serviceUrl + conversationId
  // for each user who installs the bot, enabling reliable proactive DMs.
  app.post("/api/v1/bot/messages", async (request, reply) => {
    // ── Verify Bot Framework JWT ────────────────────────────────────────────────
    const authHeader = request.headers.authorization ?? "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!bearerToken) {
      return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "Missing Authorization header" });
    }
    try {
      const { payload: botPayload } = await jwtVerify(bearerToken, BOT_FRAMEWORK_JWKS, {
        issuer: "https://api.botframework.com",
      });
      // aud is the bot's App ID — confirm it belongs to a configured tenant
      const botAppId = Array.isArray(botPayload.aud) ? botPayload.aud[0] : botPayload.aud;
      if (!botAppId) throw new Error("Missing aud claim");
      // C6: clientIdRef is encrypted — scan MS_TEAMS creds and decrypt to find a match.
      const allBotCreds = await prisma.tenantIntegrationCredential.findMany({
        where: { platform: "MS_TEAMS" },
        select: { id: true, clientIdRef: true }
      });
      const knownBot = allBotCreds.find(c => decryptField(c.clientIdRef) === botAppId);
      if (!knownBot) throw new Error("Unrecognised bot App ID");
    } catch (authErr) {
      app.log.warn({ authErr }, "[bot] Rejected request — invalid Bot Framework token");
      return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "Invalid Bot Framework token" });
    }
    // ── Process Bot Framework activity ─────────────────────────────────────────
    try {
      const body = request.body as Record<string, unknown>;
      const serviceUrl  = body?.serviceUrl  as string | undefined;
      const conversation = body?.conversation as { id?: string } | undefined;
      const channelData  = body?.channelData  as { tenant?: { id?: string } } | undefined;
      const tenantAadId  = channelData?.tenant?.id;

      // Log every incoming event for debugging
      app.log.debug(`[bot] type=${body?.type} serviceUrl=${serviceUrl} convId=${conversation?.id} tenantAadId=${tenantAadId}`);

      async function storeConvRef(fromId: string, aadObjectId?: string) {
        if (!serviceUrl || !conversation?.id) return;
        // The `from.id` IS the correct MRI Teams uses — store it as-is
        const mri = fromId;
        const aadId = aadObjectId ?? fromId.replace(/^8:orgid:/, "");
        app.log.debug(`[bot] storeConvRef mri=${mri} aadId=${aadId}`);

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
          app.log.debug(`[bot] Updated MRI and convRef for user=${acct.userId} mri=${mri} serviceUrl=${serviceUrl}`);
        } else {
          app.log.debug(`[bot] No CRM user found for mri=${mri} — user may not have a Teams account linked yet`);
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
      app.log.error({ err }, "[bot] conversationUpdate handler error");
    }
    return reply.code(200).send();
  });

  // M3: Mark RUNNING runs from THIS process as FAILURE on restart.
  // Filtering by workerTag prevents a restart on one instance from marking another
  // instance's in-progress runs as failed in a multi-instance deployment.
  prisma.cronJobRun.updateMany({
    where: { status: "RUNNING", summary: { startsWith: WORKER_TAG } },
    data: { status: "FAILURE", summary: "Interrupted — server restarted while job was running", completedAt: new Date() }
  }).then(r => { if (r.count > 0) app.log.warn(`[startup] Marked ${r.count} interrupted RUNNING job(s) as FAILURE`) })
    .catch(err => app.log.error({ err }, "[startup] Failed to clean up stuck jobs"));

  // C6: Encrypt any plaintext credential rows left from before encryption was enabled.
  migrateCredentialsEncryption()
    .then(() => app.log.info("[startup] Integration credential encryption check complete"))
    .catch(err => app.log.error({ err }, "[startup] Credential encryption migration failed"));

  // On Vercel, cron jobs are triggered via HTTP endpoints (cronRoutes) instead
  // of in-process node-cron timers which don't persist between invocations.
  if (!process.env.VERCEL) {
    startScheduler().catch(err => app.log.error({ err }, "[scheduler] startup error"));
  }

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
  app.get("/reset-password", async (_, reply) => reply.sendFile("index.html"));
  app.get("/accept-invite", async (_, reply) => reply.sendFile("index.html"));
  app.get("/signup", async (_, reply) => reply.sendFile("index.html"));

  return app;
}

// Vercel auto-detects src/app.ts and expects a default export
// that is either a Fastify instance or a factory function.
export default buildApp;
