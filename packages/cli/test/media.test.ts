import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { inspectAudio, inspectCover } from "../src/media";

test("audio inspection refuses empty and invalid files", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-media-"));
  try {
    const empty = join(root, "empty.mp3");
    const fake = join(root, "fake.mp3");
    await writeFile(empty, "");
    await writeFile(fake, "not an MP3");
    await expect(inspectAudio(empty)).rejects.toThrow();
    await expect(inspectAudio(fake)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio inspection rejects truncated streams with a declared Xing/Info size", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-mp3-size-"));
  try {
    const original = await readFile(resolve(import.meta.dir, "fixture.mp3"));
    const valid = join(root, "valid.mp3");
    await writeFile(valid, original);
    expect((await inspectAudio(valid)).size).toBe(original.length);
    await writeFile(valid, Buffer.concat([original, Buffer.alloc(128)]));
    expect((await inspectAudio(valid)).size).toBe(original.length + 128);
    const audioOffset = 10 + ((original[6]! << 21) | (original[7]! << 14) | (original[8]! << 7) | original[9]!);
    await writeFile(valid, original.subarray(audioOffset));
    expect((await inspectAudio(valid)).size).toBe(original.length - audioOffset);
    const withoutTag = Buffer.from(original);
    withoutTag.write("NONE", withoutTag.indexOf("Info"), "ascii");
    await writeFile(valid, withoutTag);
    expect((await inspectAudio(valid)).size).toBe(original.length);
    const id3v1 = Buffer.alloc(128);
    id3v1.write("TAG");
    Buffer.from([0xff, 0xfb, 0x00, 0xc0]).copy(id3v1, 10); // False MPEG sync inside a valid trailing tag.
    await writeFile(valid, Buffer.concat([original, id3v1]));
    expect((await inspectAudio(valid)).size).toBe(original.length + id3v1.length);
    await writeFile(valid, Buffer.concat([original.subarray(0, original.length - 80), id3v1]));
    await expect(inspectAudio(valid)).rejects.toThrow("MP3 is truncated");
    const damagedWithXing = Buffer.from(original);
    damagedWithXing.fill(0, 645, 749); // Remove an entire middle frame but preserve Xing's original counts.
    await writeFile(valid, damagedWithXing);
    await expect(inspectAudio(valid)).rejects.toThrow("fewer MPEG audio frames");
    await writeFile(valid, Buffer.concat([withoutTag, id3v1]));
    expect((await inspectAudio(valid)).size).toBe(original.length + id3v1.length);
    const badFrame = Buffer.from(withoutTag);
    // Sixth MPEG frame in this fixed-bitrate fixture: change the bitrate index to zero.
    expect(badFrame.subarray(645, 648)).toEqual(Buffer.from([0xff, 0xfb, 0x10]));
    badFrame[647] = badFrame[647]! & 0x0f;
    await writeFile(valid, badFrame);
    await expect(inspectAudio(valid)).rejects.toThrow("invalid or unsupported MPEG audio frame");
    for (const size of [256, 512, 800, 1000]) {
      const truncated = join(root, `${size}.mp3`);
      await writeFile(truncated, original.subarray(0, size));
      await expect(inspectAudio(truncated)).rejects.toThrow("MP3 is truncated");
    }
    const xing = Buffer.from(original);
    const tagOffset = xing.indexOf("Info");
    expect(tagOffset).toBeGreaterThan(0);
    xing.write("Xing", tagOffset, "ascii");
    await writeFile(valid, xing);
    expect((await inspectAudio(valid)).size).toBe(xing.length);
    await writeFile(valid, xing.subarray(0, 800));
    await expect(inspectAudio(valid)).rejects.toThrow("MP3 is truncated");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cover inspection decodes RGB JPEG/PNG and rejects alpha", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-cover-"));
  try {
    const image = new PNG({ width: 1400, height: 1400 });
    image.data.fill(255);
    const png = join(root, "cover.png");
    const alpha = join(root, "alpha.png");
    const jpg = join(root, "cover.jpg");
    await writeFile(png, PNG.sync.write(image, { colorType: 2 }));
    await writeFile(alpha, PNG.sync.write(image, { colorType: 6 }));
    await writeFile(jpg, jpeg.encode({ data: image.data, width: 1400, height: 1400 }, 75).data);
    expect((await inspectCover(png)).mime).toBe("image/png");
    expect((await inspectCover(jpg)).mime).toBe("image/jpeg");
    await expect(inspectCover(alpha)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
