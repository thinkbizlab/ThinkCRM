import type sharpDefault from "sharp";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SARABUN_REGULAR_BASE64 } from "./sarabun-font.js";

// `sharp` pulls in ~16 MB of native libvips bindings. We deliberately lazy-load
// it on first call so cold starts for non-checkin requests (the 95% case) don't
// pay the import cost. With Fluid Compute's instance reuse the import is
// effectively one-time per warm instance.
type SharpFactory = typeof sharpDefault;
let sharpPromise: Promise<SharpFactory> | undefined;
function loadSharp(): Promise<SharpFactory> {
  if (!sharpPromise) {
    // Node's CJS interop wraps the dynamic-import namespace as
    // `{ default: sharp, ...staticMethods }`, but TS under NodeNext narrows
    // `typeof import("sharp")` to just the callable. Reach for `.default` at
    // runtime; cast through `unknown` to keep the type-check happy.
    sharpPromise = import("sharp").then(
      (m) => (m as unknown as { default: SharpFactory }).default,
    );
  }
  return sharpPromise;
}

// Persist the embedded Sarabun font to disk so sharp's text() API (which uses
// Pango + fontconfig under the hood) can load it by absolute path. The
// earlier SVG @font-face approach with a data: URL was unreliable on
// librsvg/Pango on Vercel's Linux build — Thai glyphs rendered as tofu boxes
// because the font wasn't actually being picked up. Writing to /tmp is fine
// on Fluid Compute: it persists across requests on a warm instance and the
// existsSync check skips the write after the first call.
let fontPathPromise: Promise<string> | undefined;
function ensureSarabunFontFile(): Promise<string> {
  if (!fontPathPromise) {
    fontPathPromise = (async () => {
      const dir = join(tmpdir(), "thinkcrm-fonts");
      await mkdir(dir, { recursive: true });
      const fontPath = join(dir, "Sarabun-Regular.ttf");
      if (!existsSync(fontPath)) {
        await writeFile(fontPath, Buffer.from(SARABUN_REGULAR_BASE64, "base64"));
      }
      return fontPath;
    })();
  }
  return fontPathPromise;
}

function pangoEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type WatermarkOptions = {
  /** Camera shutter time (UTC). The caller formats it before passing in. */
  timestampLine: string;
  /** Optional second line — joined road + subdistrict + district. */
  addressLine: string | null;
};

/**
 * Burn a two-line watermark (timestamp + Thai address) onto the bottom-left of
 * a JPEG/PNG buffer. EXIF orientation is honored before drawing so the
 * watermark always lands at the visual bottom. Always returns a JPEG buffer.
 */
export async function applyCheckInWatermark(
  input: Buffer,
  opts: WatermarkOptions,
): Promise<Buffer> {
  const sharp = await loadSharp();
  const fontPath = await ensureSarabunFontFile();
  const base = sharp(input).rotate();
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) {
    return base.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  }

  const fontSize = Math.max(20, Math.round(width * 0.028));
  const padding = fontSize;
  const gradientHeight = Math.max(Math.round(fontSize * 1.35 * 3), Math.round(height * 0.18));

  const lines: string[] = [opts.timestampLine];
  if (opts.addressLine && opts.addressLine.trim()) {
    lines.push(opts.addressLine.trim());
  }

  // Pango DPI is calibrated so that font size in "points" maps to our desired
  // pixel size: pixels = points * dpi / 72. We want the visible glyph height
  // to be `fontSize` px, so pass that as points and force dpi=72.
  const pangoMarkup = lines
    .map((line) => `<span foreground="white">${pangoEscape(line)}</span>`)
    .join("\n");

  // sharp's text() API rasterises Pango markup via libvips → HarfBuzz with a
  // direct font-file path, sidestepping the @font-face/data-URL pitfalls that
  // made Thai glyphs render as tofu on Vercel. The output is an RGBA buffer
  // we composite onto the photo.
  const textImage = sharp({
    text: {
      text: pangoMarkup,
      font: `Sarabun ${fontSize}`,
      fontfile: fontPath,
      dpi: 72,
      rgba: true
    }
  });
  const textBuffer = await textImage.png().toBuffer();
  const textMeta = await sharp(textBuffer).metadata();
  const textHeight = textMeta.height ?? Math.round(fontSize * 1.35 * lines.length);

  // Black-to-transparent gradient bar at the bottom for legibility — text
  // alone over a bright sky would be hard to read.
  const gradientSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${height - gradientHeight}" width="${width}" height="${gradientHeight}" fill="url(#shade)"/>
</svg>`;

  return base
    .composite([
      { input: Buffer.from(gradientSvg), top: 0, left: 0 },
      {
        input: textBuffer,
        left: padding,
        top: Math.max(0, height - padding - textHeight)
      }
    ])
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}
