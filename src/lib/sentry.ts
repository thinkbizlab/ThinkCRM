import * as Sentry from "@sentry/node";
import { config } from "../config.js";

if (config.SENTRY_DSN) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: config.NODE_ENV === "production" ? 0.2 : 1.0,
  });
}

export { Sentry };
