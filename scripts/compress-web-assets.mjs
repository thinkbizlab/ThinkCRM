import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createBrotliCompress, createGzip, constants } from "node:zlib";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const MIN_BYTES = 1024;
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml"
]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

async function shouldCompress(path) {
  if (path.endsWith(".br") || path.endsWith(".gz")) return false;
  if (!COMPRESSIBLE_EXTENSIONS.has(extname(path))) return false;
  return (await stat(path)).size >= MIN_BYTES;
}

async function isFresh(source, target) {
  try {
    const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
    return targetStat.mtimeMs >= sourceStat.mtimeMs && targetStat.size > 0;
  } catch {
    return false;
  }
}

async function compressFile(source, target, streamFactory) {
  if (await isFresh(source, target)) return false;
  await pipeline(createReadStream(source), streamFactory(), createWriteStream(target));
  return true;
}

let written = 0;

for await (const file of walk(WEB_DIR)) {
  if (!(await shouldCompress(file))) continue;

  if (await compressFile(
    file,
    `${file}.br`,
    () => createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY
      }
    })
  )) {
    written += 1;
  }

  if (await compressFile(
    file,
    `${file}.gz`,
    () => createGzip({ level: constants.Z_BEST_COMPRESSION })
  )) {
    written += 1;
  }
}

console.log(`Compressed web assets: ${written} file${written === 1 ? "" : "s"} written`);
