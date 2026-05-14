import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const FONT_URL = new URL("../../assets/fonts/Sarabun-Regular.ttf", import.meta.url);

let fontDataUrlPromise: Promise<string> | null = null;
function loadFontDataUrl(): Promise<string> {
  if (!fontDataUrlPromise) {
    fontDataUrlPromise = readFile(fileURLToPath(FONT_URL)).then(
      (buf) => `data:font/ttf;base64,${buf.toString("base64")}`,
    );
  }
  return fontDataUrlPromise;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
  const base = sharp(input).rotate();
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) {
    return base.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  }

  const fontDataUrl = await loadFontDataUrl();
  const fontSize = Math.max(20, Math.round(width * 0.028));
  const lineHeight = Math.round(fontSize * 1.35);
  const padding = fontSize;
  const stroke = Math.max(1.5, fontSize * 0.06);
  const gradientHeight = Math.max(lineHeight * 3, Math.round(height * 0.18));

  const lines: string[] = [opts.timestampLine];
  if (opts.addressLine && opts.addressLine.trim()) {
    lines.push(opts.addressLine.trim());
  }

  const textBottom = height - padding;
  const textElems = lines
    .slice()
    .reverse()
    .map((text, i) => {
      const y = textBottom - i * lineHeight;
      return `<text x="${padding}" y="${y}" class="wm">${escapeXml(text)}</text>`;
    })
    .reverse()
    .join("");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style type="text/css">
      @font-face {
        font-family: "Sarabun";
        src: url("${fontDataUrl}") format("truetype");
        font-weight: 400;
        font-style: normal;
      }
      .wm {
        font-family: "Sarabun", sans-serif;
        font-size: ${fontSize}px;
        fill: #ffffff;
        stroke: #000000;
        stroke-width: ${stroke};
        paint-order: stroke fill;
        stroke-linejoin: round;
      }
    </style>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${height - gradientHeight}" width="${width}" height="${gradientHeight}" fill="url(#shade)"/>
  ${textElems}
</svg>`;

  return base
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}
