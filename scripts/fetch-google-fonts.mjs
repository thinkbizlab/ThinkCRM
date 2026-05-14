// One-time downloader: fetches the Google Fonts CSS for the families this app
// uses, downloads every woff2 file referenced inside, and rewrites the CSS to
// point at local /fonts/google/<file>.woff2 URLs. Run with `node scripts/
// fetch-google-fonts.mjs` whenever the font families or weights change.
//
// The output is committed (web/fonts/google/*.woff2 + web/fonts/google.css)
// so production never makes a request to fonts.googleapis.com or
// fonts.gstatic.com — saves 2 DNS lookups + 2 TLS handshakes per cold load.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GOOGLE_CSS_URL =
  "https://fonts.googleapis.com/css2" +
  "?family=Montserrat:wght@300;400;500;600;700" +
  "&family=Noto+Sans+Thai:wght@300;400;500;600;700" +
  "&display=swap";

// Modern Chrome UA so Google returns the woff2 variant (legacy UAs get TTF).
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const FONTS_DIR = fileURLToPath(new URL("../web/fonts/google/", import.meta.url));
const FONTS_CSS = fileURLToPath(new URL("../web/fonts/google.css", import.meta.url));

await mkdir(FONTS_DIR, { recursive: true });

const cssRes = await fetch(GOOGLE_CSS_URL, { headers: { "user-agent": UA } });
if (!cssRes.ok) throw new Error(`Google Fonts CSS fetch failed: ${cssRes.status}`);
let css = await cssRes.text();

// Find every gstatic woff2 URL and download it. Filename is the last path
// segment; Google's filenames already include the family+weight+subset hash
// so collisions are essentially impossible.
const urls = [...css.matchAll(/https:\/\/fonts\.gstatic\.com\/[^)\s]+\.woff2/g)].map((m) => m[0]);
const unique = [...new Set(urls)];
console.log(`found ${unique.length} unique woff2 files`);

let downloaded = 0;
let bytes = 0;
for (const url of unique) {
  const filename = url.split("/").pop();
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`woff2 fetch failed: ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(join(FONTS_DIR, filename), buf);
  bytes += buf.length;
  downloaded++;
  // Rewrite every occurrence of the absolute URL to the local path.
  css = css.replaceAll(url, `/fonts/google/${filename}`);
}

await writeFile(FONTS_CSS, css);
console.log(
  `downloaded ${downloaded} files (${(bytes / 1024).toFixed(1)} KB), wrote ${FONTS_CSS}`,
);
