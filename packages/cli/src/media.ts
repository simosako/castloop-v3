import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { parseFile } from "music-metadata";
import { imageSize } from "image-size";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const MAX_AUDIO_BYTES = 1024 * 1024 * 1024;

/** Inspect metadata and hash a local file; upload must verify the same digest again. */
export async function inspectAudio(path: string): Promise<{ mime: "audio/mpeg"; size: number; duration_ms: number; sha256: string }> {
  const before = await stat(path);
  if (!before.isFile() || before.size <= 0 || before.size > MAX_AUDIO_BYTES) throw new Error("MP3 must be a nonempty file no larger than 1 GiB");
  const { format } = await parseFile(path, { duration: true, skipCovers: true });
  if (format.container !== "MPEG" || !/^MPEG .* Layer 3$/.test(format.codec ?? "") || !format.hasAudio || format.hasVideo) {
    throw new Error("Expected an MP3 audio file");
  }
  const duration_ms = Math.round((format.duration ?? 0) * 1000);
  if (!Number.isSafeInteger(duration_ms) || duration_ms <= 0) throw new Error("MP3 duration is missing or invalid");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("Audio file changed during inspection; try again");
  }
  return { mime: "audio/mpeg", size: before.size, duration_ms, sha256: hash.digest("hex") };
}

function jpegComponents(bytes: Buffer): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid JPEG header");
  let pos = 2;
  while (pos + 3 < bytes.length) {
    if (bytes[pos++] !== 0xff) throw new Error("Invalid JPEG marker");
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(pos);
    if (length < 2 || pos + length > bytes.length) throw new Error("Invalid JPEG segment");
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) throw new Error("Invalid JPEG frame");
      return bytes[pos + 7]!;
    }
    pos += length;
  }
  throw new Error("JPEG frame not found");
}

export async function inspectCover(path: string): Promise<{ mime: "image/jpeg" | "image/png"; width: number; height: number; color: "rgb"; alpha: false; size: number; sha256: string }> {
  const before = await stat(path);
  if (!before.isFile() || before.size <= 0 || before.size > 20 * 1024 * 1024) throw new Error("Cover must be a nonempty file no larger than 20 MiB");
  const bytes = await readFile(path);
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
    throw new Error("Cover changed during inspection; try again");
  }
  const { type, width, height } = imageSize(bytes);
  if ((type !== "jpg" && type !== "png") || width !== height || width < 1400 || width > 3000) throw new Error("Cover must be a square 1400–3000 pixel JPEG or PNG");
  if (type === "jpg") {
    if (jpegComponents(bytes) !== 3) throw new Error("JPEG must have three color components");
    jpeg.decode(bytes, { maxMemoryUsageInMB: 256 });
  } else {
    // PNG truecolor without an alpha channel. tRNS can add transparency to truecolor.
    if (bytes[25] !== 2) throw new Error("PNG must use RGB without an alpha channel");
    let pos = 8;
    while (pos + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(pos);
      if (pos + length + 12 > bytes.length) throw new Error("Invalid PNG chunk");
      if (bytes.toString("ascii", pos + 4, pos + 8) === "tRNS") throw new Error("PNG transparency is unsupported");
      pos += length + 12;
    }
    PNG.sync.read(bytes, { checkCRC: true });
  }
  return { mime: type === "jpg" ? "image/jpeg" : "image/png", width, height, color: "rgb", alpha: false, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
