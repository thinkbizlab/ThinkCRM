/**
 * k6 load test for ThinkCRM API.
 *
 * Usage:
 *   k6 run k6/load-test.js
 *
 * Environment variables:
 *   K6_BASE_URL       — API base URL (default: http://localhost:3000)
 *   K6_TENANT_SLUG    — tenant workspace slug
 *   K6_ADMIN_EMAIL    — admin email for login
 *   K6_ADMIN_PASSWORD — admin password
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.K6_BASE_URL || "http://localhost:3000";
const TENANT_SLUG = __ENV.K6_TENANT_SLUG || "e2e-test";
const ADMIN_EMAIL = __ENV.K6_ADMIN_EMAIL || "admin@e2e-test.com";
const ADMIN_PASSWORD = __ENV.K6_ADMIN_PASSWORD || "E2eTestPassword!123";

const errorRate = new Rate("errors");
const loginDuration = new Trend("login_duration");
const dashboardDuration = new Trend("dashboard_duration");
const dealsDuration = new Trend("deals_duration");

export const options = {
  stages: [
    { duration: "30s", target: 10 },  // ramp up to 10 concurrent users
    { duration: "1m", target: 10 },   // hold at 10
    { duration: "30s", target: 25 },  // ramp up to 25
    { duration: "1m", target: 25 },   // hold at 25
    { duration: "30s", target: 0 },   // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<2000"],  // 95th percentile under 2s
    errors: ["rate<0.05"],             // error rate under 5%
    login_duration: ["p(95)<3000"],
    dashboard_duration: ["p(95)<2000"],
    deals_duration: ["p(95)<2000"],
  },
};

function login() {
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({
      tenantSlug: TENANT_SLUG,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
  loginDuration.add(Date.now() - start);

  const ok = check(res, {
    "login status 200": (r) => r.status === 200,
    "login returns token": (r) => {
      try { return !!JSON.parse(r.body).token; } catch { return false; }
    },
  });
  errorRate.add(!ok);

  if (res.status !== 200) return null;
  try { return JSON.parse(res.body).token; } catch { return null; }
}

function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
}

export default function () {
  const token = login();
  if (!token) {
    sleep(1);
    return;
  }

  const opts = authHeaders(token);

  group("Dashboard", () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/v1/dashboard/overview`, opts);
    dashboardDuration.add(Date.now() - start);

    const ok = check(res, {
      "dashboard 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  group("Deals", () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/v1/deals`, opts);
    dealsDuration.add(Date.now() - start);

    const ok = check(res, {
      "deals 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  group("Visits", () => {
    const res = http.get(`${BASE_URL}/api/v1/visits`, opts);
    const ok = check(res, {
      "visits 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  group("Customers", () => {
    const res = http.get(`${BASE_URL}/api/v1/customers`, opts);
    const ok = check(res, {
      "customers 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  group("User Profile", () => {
    const res = http.get(`${BASE_URL}/api/v1/auth/me`, opts);
    const ok = check(res, {
      "me 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(1);
}
