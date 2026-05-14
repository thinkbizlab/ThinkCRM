(function () {
  var hasToken =
    localStorage.getItem("thinkcrm_token") ||
    // OAuth callback — token not yet in storage, but we don't want the login
    // screen to flash while the code-exchange happens.
    /[?&]oauth_code=/.test(location.search);

  if (hasToken) {
    document.documentElement.classList.add("has-token");

    // Speculatively preload the most-likely landing modules so the first
    // navigation after auth feels instant instead of waiting on a 24–72 KB
    // dynamic import. Only fires for authenticated users so logged-out
    // visitors don't pay the bandwidth. Pulls the version param off the
    // styles.css <link> stamped by scripts/build-web-assets.mjs so the
    // preloads share the same immutable cache key as the real imports.
    try {
      var stylesLink = document.querySelector(
        'link[rel="stylesheet"][href*="/styles.css"]'
      );
      var ver = stylesLink
        ? new URL(stylesLink.href, location.origin).searchParams.get("v")
        : null;
      var suffix = ver ? "?v=" + ver : "";
      ["/modules/dashboard.js", "/modules/visits.js"].forEach(function (path) {
        var preload = document.createElement("link");
        preload.rel = "modulepreload";
        preload.href = path + suffix;
        document.head.appendChild(preload);
      });
    } catch (_) {
      // Speculative perf hint — never block boot on failure.
    }
  }

  // Before-first-paint branding hydration. We cache the last-seen tenant
  // branding in localStorage; on subsequent loads we inject the accent colors
  // and app name before the browser paints anything, so themed elements don't
  // flash the default blue before the async /branding/public fetch resolves.
  try {
    const raw = localStorage.getItem("thinkcrm_branding");
    if (!raw) return;
    const b = JSON.parse(raw);
    const primary = typeof b.primaryColor === "string" ? b.primaryColor : null;
    if (!primary) return;
    const secondary = typeof b.secondaryColor === "string" ? b.secondaryColor : null;
    const styleEl = document.createElement("style");
    const decls = [
      `--accent:${primary}`,
      `--accent-dim:${primary}`,
      `--login-accent:${primary}`,
      `--primary:${primary}`
    ];
    if (secondary) decls.push(`--secondary:${secondary}`);
    styleEl.textContent = `:root{${decls.join(";")};}`;
    document.head.appendChild(styleEl);
    if (b.appName) document.title = b.appName;
    document.addEventListener("DOMContentLoaded", function () {
      if (b.appName) {
        const loginName = document.getElementById("login-app-name");
        if (loginName) loginName.textContent = b.appName;
        const brandTitle = document.getElementById("brand-title");
        if (brandTitle) brandTitle.textContent = b.appName;
      }
      // Safe to reveal — colors are already correct from cache.
      document.querySelectorAll(".branding-pending").forEach(function (el) {
        el.classList.remove("branding-pending");
      });
    });
  } catch (_) {
    // Bad/corrupt cache — ignore; the normal async branding fetch still runs.
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {});
  }
})();
