import "fastify"; // Vercel Fastify auto-detection requires this import in the entrypoint
import { buildApp } from "./build-app.js";
import { config } from "./config.js";

const app = await buildApp();

// On Vercel, listen() is intercepted by the serverless adapter.
// Awaiting it hangs the module because there's no real port to bind to.
const listenPromise = app.listen({ port: config.PORT, host: "0.0.0.0" });

if (!process.env.VERCEL) {
  try {
    await listenPromise;
    app.log.info(`ThinkCRM API running on port ${config.PORT}`);
  } catch (error) {
    app.log.error(error, "Failed to start server");
    process.exit(1);
  }
}
