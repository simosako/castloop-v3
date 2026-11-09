import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { parseFile, parseStream } from "music-metadata";
import { imageSize } from "image-size";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { UsageError } from "./errors";

const MAX_AUDIO_BYTES = 1024 * 1024 * 1024;

/** Check an authoritative Xing/Info byte count when present in the first frame. */
async function checkDeclaredMpegSize(path: string, fileSize: number): Promise<void> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(10);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length) return;
    let start = 0;
    if (header.toString("ascii", 0, 3) === "ID3") {
      if (header.subarray(6, 10).some(byte => byte & 0x80)) return;
      start = 10 + ((header[6]! << 21) | (header[7]! << 14) | (header[8]! << 7) | header[9]!);
      if (header[3] === 4 && (header[5]! & 0x10)) start += 10;
    }
    if (start >= fileSize) return;
    const first = Buffer.alloc(64);
    const read = (await file.read(first, 0, first.length, start)).bytesRead;
    if (read < 4 || first[0] !== 0xff || (first[1]! & 0xe0) !== 0xe0) return;
    const version = (first[1]! >> 3) & 3, layer = (first[1]! >> 1) & 3;
    const bitrate = first[2]! >> 4, sampleRate = (first[2]! >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || sampleRate === 3) return;
    const mono = (first[3]! >> 6) === 3;
    const sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const offset = 4 + sideInfo;
    if (read < offset + 8 || !["Xing", "Info"].includes(first.toString("ascii", offset, offset + 4))) return;
    const flags = first.readUInt32BE(offset + 4);
    if (!(flags & 2)) return;
    const sizeOffset = offset + 8 + ((flags & 1) ? 4 : 0);
    if (read < sizeOffset + 4) return;
    const rates = [44100, 48000, 32000];
    const sampleHz = rates[sampleRate]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const bitrates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const frameSize = Math.floor((version === 3 ? 144000 : 72000) * bitrates[bitrate]! / sampleHz) + ((first[2]! >> 1) & 1);
    if (sizeOffset + 4 > frameSize) return;
    const declaredSize = first.readUInt32BE(sizeOffset);
    // ID3v1 is a fixed 128-byte trailer, not part of Xing's MPEG byte count.
    // Counting it as audio can hide a shorter-than-declared final frame.
    let audioEnd = fileSize;
    if (fileSize - start >= 128) {
      const marker = Buffer.alloc(3);
      if ((await file.read(marker, 0, marker.length, fileSize - 128)).bytesRead === 3 && marker.equals(Buffer.from("TAG"))) audioEnd -= 128;
    }
    if (declaredSize > audioEnd - start) throw new UsageError("MP3 is truncated: its declared audio data exceeds the file size");
    const declaredFrames = flags & 1 ? first.readUInt32BE(offset + 8) : 0;
    if (declaredFrames >= 4 && declaredSize > frameSize) {
      // parseFile normally stops after the Xing header and cannot see damaged
      // later frame headers. Scan only the declared MPEG bytes after that frame,
      // keeping trailing ID3 or other tags out of the frame count.
      const source = createReadStream(path, { start: start + frameSize, end: start + declaredSize - 1 });
      try {
        const scanned = await parseStream(source, { mimeType: "audio/mpeg", size: declaredSize - frameSize }, { duration: true, skipCovers: true });
        const samples = scanned.format.numberOfSamples;
        const samplesPerFrame = version === 3 ? 1152 : 576;
        if (scanned.format.container === "MPEG" && /^MPEG .* Layer 3$/.test(scanned.format.codec ?? "") && scanned.format.sampleRate === sampleHz &&
            Number.isSafeInteger(samples) && samples! < declaredFrames * samplesPerFrame) {
          throw new UsageError("Invalid MP3: fewer MPEG audio frames were found than declared in its Xing/Info header");
        }
      } finally { source.destroy(); }
    }
  } finally { await file.close(); }
}

/** Inspect metadata and hash a local file; upload must verify the same digest again. */
export async function inspectAudio(path: string): Promise<{ mime: "audio/mpeg"; size: number; duration_ms: number; sha256: string }> {
  const before = await stat(path);
  if (!before.isFile() || before.size <= 0 || before.size > MAX_AUDIO_BYTES) throw new UsageError("MP3 must be a nonempty file no larger than 1 GiB");
  let format: Awaited<ReturnType<typeof parseFile>>["format"];
  let warnings: Awaited<ReturnType<typeof parseFile>>["quality"]["warnings"];
  try { const metadata = await parseFile(path, { duration: true, skipCovers: true }); format = metadata.format; warnings = metadata.quality.warnings; }
  catch (error) {
    if (error && typeof error === "object" && "syscall" in error) throw error;
    throw new UsageError(`Invalid MP3: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (format.container !== "MPEG" || !/^MPEG .* Layer 3$/.test(format.codec ?? "") || !format.hasAudio || format.hasVideo) {
    throw new UsageError("Expected an MP3 audio file");
  }
  // music-metadata can recover a partial duration after an invalid MPEG frame.
  // Do not ignore this specific audio-header error; unrelated tag warnings may
  // still describe playable audio and must not be treated as frame corruption.
  if (warnings.some(warning => warning.message === "Parse error: Cannot determine bit-rate" || /^Frame \d+corrupt: negative frameDataLeft$/.test(warning.message))) {
    throw new UsageError("Invalid MP3: an invalid or unsupported MPEG audio frame was detected");
  }
  await checkDeclaredMpegSize(path, before.size);
  const duration_ms = Math.round((format.duration ?? 0) * 1000);
  if (!Number.isSafeInteger(duration_ms) || duration_ms <= 0) throw new UsageError("MP3 duration is missing or invalid");
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
  if (!before.isFile() || before.size <= 0 || before.size > 20 * 1024 * 1024) throw new UsageError("Cover must be a nonempty file no larger than 20 MiB");
  const bytes = await readFile(path);
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
    throw new Error("Cover changed during inspection; try again");
  }
  let dimensions: ReturnType<typeof imageSize>;
  try { dimensions = imageSize(bytes); }
  catch (error) { throw new UsageError(`Invalid cover image: ${error instanceof Error ? error.message : String(error)}`); }
  const { type, width, height } = dimensions;
  if ((type !== "jpg" && type !== "png") || width !== height || width < 1400 || width > 3000) throw new UsageError("Cover must be a square 1400–3000 pixel JPEG or PNG");
  try {
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
  } catch (error) { throw new UsageError(`Invalid cover image: ${error instanceof Error ? error.message : String(error)}`); }
  return { mime: type === "jpg" ? "image/jpeg" : "image/png", width, height, color: "rgb", alpha: false, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
