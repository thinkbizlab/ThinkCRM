import { existsSync } from "node:fs";
import { chromium, request as playwrightRequest } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const DEMO_LOGIN = {
  tenantSlug: process.env.THINKCRM_TENANT_SLUG || "thinkcrm-demo",
  email: process.env.THINKCRM_EMAIL || "admin@thinkcrm.demo",
  password: process.env.THINKCRM_PASSWORD || "ThinkCRM123!"
};

function resolveBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || undefined;
}

function round(value) {
  return Number((value || 0).toFixed(1));
}

function sumBytes(rows) {
  return rows.reduce((total, row) => total + (row.transferSize || row.encodedBodySize || 0), 0);
}

function classifyResource(name, initiatorType) {
  if (initiatorType === "fetch" || initiatorType === "xmlhttprequest" || name.includes("/api/v1/")) {
    return "api";
  }
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".js") || name.includes("/modules/") || initiatorType === "script") return "js";
  if (/\.(png|jpe?g|webp|gif|svg|ico)$/i.test(name) || initiatorType === "img") return "image";
  if (/\.(woff2?|ttf|otf)$/i.test(name) || initiatorType === "font") return "font";
  return "other";
}

async function login() {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const response = await api.post("/api/v1/auth/login", { data: DEMO_LOGIN });
  if (!response.ok()) {
    throw new Error(`Login failed with ${response.status()}`);
  }
  const json = await response.json();
  await api.dispose();
  if (!json.accessToken) {
    throw new Error("Login succeeded but no access token was returned.");
  }
  return json;
}

async function waitForRouteReady(page, route) {
  if (route.authenticated) {
    await page.waitForFunction(() => {
      const app = document.querySelector("#app-screen");
      const loading = document.querySelector("#app-loading");
      const activeView = document.querySelector(".view.active");
      return app?.classList.contains("active")
        && (!loading || loading.hidden)
        && !!activeView;
    }, null, { timeout: 30000 });

    if (route.path === "/task") {
      await page.waitForSelector("#view-rep-hub.active", { timeout: 30000 });
    }
    if (route.path === "/dashboard") {
      await page.waitForSelector("#view-dashboard.active", { timeout: 30000 });
    }
    if (route.path === "/visits") {
      await page.waitForSelector("#view-visits.active", { timeout: 30000 });
      await page.waitForSelector("#vp-list-container", { timeout: 30000 });
    }
    if (route.path === "/master/customers") {
      await page.waitForSelector("#view-master.active", { timeout: 30000 });
      await page.waitForSelector("#cust-list-mount .cust-list-wrap", { timeout: 30000 });
    }
    if (route.path === "/settings/company") {
      await page.waitForSelector("#view-settings.active", { timeout: 30000 });
    }
  } else {
    await page.waitForSelector("#auth-screen.active", { timeout: 30000 });
    await page.waitForSelector('input[name="tenantSlug"]', { timeout: 30000 });
  }

  await page.waitForTimeout(1000);
}

async function profileRoute(route, authTokens = null) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveBrowserExecutable()
  });
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 960 } });

  await context.addInitScript((tokens) => {
    window.__perfProfile = { lcp: 0, cls: 0 };

    try {
      new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        const last = entries[entries.length - 1];
        if (last) window.__perfProfile.lcp = last.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}

    try {
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (!entry.hadRecentInput) window.__perfProfile.cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}

    if (!tokens) return;
    localStorage.setItem("thinkcrm_token", tokens.accessToken);
    localStorage.setItem("thinkcrm_refresh", tokens.refreshToken || "");
    localStorage.setItem("tenantSlug", tokens.user?.tenantSlug || "thinkcrm-demo");
  }, authTokens);

  const page = await context.newPage();
  await page.goto(route.path, { waitUntil: "load" });
  await waitForRouteReady(page, route);

  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const paints = Object.fromEntries(
      performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime])
    );
    const resources = performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      duration: entry.duration,
      transferSize: entry.transferSize || 0,
      encodedBodySize: entry.encodedBodySize || 0,
      decodedBodySize: entry.decodedBodySize || 0
    }));

    return {
      url: location.href,
      title: document.title,
      appLoadingHidden: document.querySelector("#app-loading")?.hidden ?? null,
      activeView: document.querySelector(".view.active")?.id || null,
      perfProfile: window.__perfProfile || { lcp: 0, cls: 0 },
      navigation: navigation
        ? {
            domContentLoaded: navigation.domContentLoadedEventEnd,
            loadEventEnd: navigation.loadEventEnd,
            responseEnd: navigation.responseEnd,
            transferSize: navigation.transferSize || 0
          }
        : null,
      paints,
      resources
    };
  });

  await browser.close();

  const resources = metrics.resources.map((resource) => ({
    ...resource,
    kind: classifyResource(resource.name, resource.initiatorType)
  }));
  const apiRequests = resources
    .filter((resource) => resource.kind === "api")
    .sort((a, b) => b.duration - a.duration);
  const jsResources = resources.filter((resource) => resource.kind === "js");
  const cssResources = resources.filter((resource) => resource.kind === "css");

  return {
    label: route.label,
    path: route.path,
    authenticated: route.authenticated,
    url: metrics.url,
    activeView: metrics.activeView,
    requestCount: resources.length,
    apiRequestCount: apiRequests.length,
    totalTransferSize: sumBytes(resources),
    jsTransferSize: sumBytes(jsResources),
    cssTransferSize: sumBytes(cssResources),
    domContentLoadedMs: round(metrics.navigation?.domContentLoaded),
    loadEventEndMs: round(metrics.navigation?.loadEventEnd),
    responseEndMs: round(metrics.navigation?.responseEnd),
    firstPaintMs: round(metrics.paints["first-paint"]),
    firstContentfulPaintMs: round(metrics.paints["first-contentful-paint"]),
    lcpMs: round(metrics.perfProfile.lcp),
    cls: round(metrics.perfProfile.cls),
    topApiRequests: apiRequests.slice(0, 8).map((resource) => ({
      path: resource.name.replace(BASE_URL, ""),
      durationMs: round(resource.duration),
      transferSize: resource.transferSize || resource.encodedBodySize || 0
    })),
    topJsResources: jsResources
      .sort((a, b) => (b.transferSize || b.encodedBodySize) - (a.transferSize || a.encodedBodySize))
      .slice(0, 8)
      .map((resource) => ({
        path: resource.name.replace(BASE_URL, ""),
        transferSize: resource.transferSize || resource.encodedBodySize || 0
      }))
  };
}

const routes = [
  { label: "login", path: "/", authenticated: false },
  { label: "repHub", path: "/task", authenticated: true },
  { label: "dashboard", path: "/dashboard", authenticated: true },
  { label: "visits", path: "/visits", authenticated: true },
  { label: "masterCustomers", path: "/master/customers", authenticated: true },
  { label: "settingsCompany", path: "/settings/company", authenticated: true }
];

async function main() {
  const authTokens = await login();
  const results = [];

  for (const route of routes) {
    results.push(await profileRoute(route, route.authenticated ? authTokens : null));
  }

  console.log(JSON.stringify({
    measuredAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    routes: results
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
