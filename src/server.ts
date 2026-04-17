import "fastify"; // Vercel Fastify auto-detection requires this import in the entrypoint
import { buildApp } from "./build-app.js";
import { config } from "./config.js";

const app = await buildApp();

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(`ThinkCRM API running on port ${config.PORT}`);
} catch (error) {
  app.log.error(error, "Failed to start server");
  process.exit(1);
}
