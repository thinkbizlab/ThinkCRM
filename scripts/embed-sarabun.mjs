// Regenerate src/lib/sarabun-font.ts from the TTF source. Run after replacing
// the font in assets/fonts/ — the watermark module reads from the generated
// .ts file (not the .ttf) so it works on Vercel without includeFiles config.
import { readFile, writeFile } from "node:fs/promises";

const ttf = await readFile("assets/fonts/Sarabun-Regular.ttf");
const b64 = ttf.toString("base64");
const out = `// Auto-generated from assets/fonts/Sarabun-Regular.ttf (Apache 2.0).
// Inlined so the watermark module needs zero filesystem access at runtime —
// Vercel's function bundler doesn't reliably include arbitrary asset files
// referenced via import.meta.url, so we ship the bytes inside the JS bundle.
// Regenerate with: node scripts/embed-sarabun.mjs
export const SARABUN_REGULAR_BASE64 = "${b64}";
`;
await writeFile("src/lib/sarabun-font.ts", out);
console.log(`wrote src/lib/sarabun-font.ts (${out.length} bytes, ${b64.length} b64 chars)`);
