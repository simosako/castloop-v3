import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
