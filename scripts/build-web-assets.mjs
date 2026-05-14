// Build-time web asset processor. Runs on Vercel inside `npm run build`,
// after `prisma generate` and before `compress-web-assets.mjs`. It:
//
//   1. Minifies web/styles.css in place via lightningcss.
//   2. Computes a content hash of every asset referenced from index.html
//      (styles.css + app.js + modules/*.js).
//   3. Rewrites every `?v=...` query in index.html to that hash, so the URLs
//      change whenever any source file changes — letting us flip the
//      Cache-Control on those URLs to `immutable` without ever serving stale
//      content.
//
// Local dev (`npm run dev` via tsx watch) skips this entirely, so the source
// files stay untouched. If you run `npm run build` locally, the minified CSS
// and rewritten index.html will show up as git diffs — `git restore` them
// once you're done testing.

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform as lightningcssTransform } from "lightningcss";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const INDEX_HTML = join(WEB_DIR, "index.html");
const STYLES_CSS = join(WEB_DIR, "styles.css");
const APP_JS = join(WEB_DIR, "app.js");
const MODULES_DIR = join(WEB_DIR, "modules");

async function minifyStyles() {
  const source = await readFile(STYLES_CSS);
  const { code, warnings } = lightningcssTransform({
    filename: "styles.css",
    code: source,
    minify: true,
    sourceMap: false,
  });
  for (const w of warnings) console.warn(`[lightningcss] ${w.message}`);
  const savedPct = (((source.length - code.length) / source.length) * 100).toFixed(1);
  await writeFile(STYLES_CSS, code);
  console.log(`minified styles.css: ${source.length} → ${code.length} bytes (-${savedPct}%)`);
}

async function hashAssets() {
  const moduleFiles = (await readdir(MODULES_DIR))
    .filter((f) => f.endsWith(".js"))
    .sort();
  const paths = [STYLES_CSS, APP_JS, ...moduleFiles.map((f) => join(MODULES_DIR, f))];

  const hash = createHash("sha1");
  for (const path of paths) {
    hash.update(await readFile(path));
  }
  return hash.digest("hex").slice(0, 12);
}

async function rewriteIndexHtml(buildId) {
  const html = await readFile(INDEX_HTML, "utf8");
  // Match any `?v=<token>` on /styles.css, /app.js, /modules/<file>.js URLs.
  // Tokens are alphanumeric + dashes/dots/underscores (everything we've ever used).
  const replaced = html.replace(
    /(\/(?:styles\.css|app\.js|modules\/[\w./-]+\.js))\?v=[\w.-]+/g,
    `$1?v=${buildId}`,
  );
  if (replaced === html) {
    console.warn("rewriteIndexHtml: no `?v=` tokens matched — check the regex");
  }
  await writeFile(INDEX_HTML, replaced);
  console.log(`stamped build id ${buildId} into index.html`);
}

await minifyStyles();
const buildId = await hashAssets();
await rewriteIndexHtml(buildId);
