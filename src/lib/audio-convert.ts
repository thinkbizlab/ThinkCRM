import { spawn } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

/** Returns true if ffmpeg is reachable on PATH (or FFMPEG_PATH). */
export async function isFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, ["-version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Converts any audio/video buffer to an AAC-in-MP4 buffer.
 * Strips video tracks (safe for .mov files from iPhone).
 * Throws if ffmpeg is not available or conversion fails.
 */
export async function convertToMp4(input: Buffer, inputExt: string): Promise<Buffer> {
  // M5: Sanitize extension — only allow a leading dot followed by alphanumerics to prevent
  // path traversal or unexpected characters in the temp file path. Fall back to .bin if invalid.
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(inputExt) ? inputExt : ".bin";
  const id = randomUUID();
  const dir = tmpdir();
  const inPath  = join(dir, `vn-in-${id}${safeExt}`);
  const outPath = join(dir, `vn-out-${id}.mp4`);

  await writeFile(inPath, input);

  try {
    await runFfmpeg([
      "-y",            // overwrite output without asking
      "-i", inPath,    // input file
      "-vn",          // drop video tracks (handles .mov from iPhone)
      "-acodec", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart", // optimise for streaming / playback
      outPath
    ]);
    return await readFile(outPath);
  } finally {
    await Promise.all([
      unlink(inPath).catch(() => {}),
      unlink(outPath).catch(() => {})
    ]);
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
    const errChunks: Buffer[] = [];
    proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = Buffer.concat(errChunks).toString().slice(-500);
        reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      }
    });
  });
}
