import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { episodeSchema, parseToml, showSchema } from "@castloop/domain";
import { decidePull, initWorkspace, installPulledFile, newEpisode, newShow } from "../src/workspace";
import { preflightMetadata } from "../src/metadata";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("initializes a workspace and creates valid unpublished show and episode drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  await initWorkspace(root);
  const showId = await newShow(root);
  const episodeId = await newEpisode(root, showId);
  const show = showSchema.parse(parseToml(await readFile(join(root, showId, "show.toml"), "utf8")));
  const episode = episodeSchema.parse(parseToml(await readFile(join(root, showId, episodeId, "episode.toml"), "utf8")));
  expect(show.publish).toBe(false);
  expect(episode.publish).toBe(false);
  expect(episode.show_id).toBe(show.id);
  await expect(initWorkspace(root)).rejects.toThrow();
  await expect(newEpisode(root, "../../escape")).rejects.toThrow();
});

test("pull decisions preserve divergent edits and tombstones", () => {
  expect(decidePull("a", "a", "a")).toBe("keep");
  expect(decidePull("a", "b", "a")).toBe("keep");
  expect(decidePull("a", "a", "b")).toBe("install");
  expect(decidePull("a", "b", "b")).toBe("keep");
  expect(decidePull("a", "b", "c")).toBe("backup-and-install");
  expect(decidePull(null, "local", "remote")).toBe("backup-and-install");
  expect(decidePull("a", "b", null)).toBe("tombstone");
});

test("install preserves existing backups and original contents on backup failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  const path = join(root, "show.toml");
  await writeFile(path, "local");
  await writeFile(`${path}.bak`, "older");
  expect(await installPulledFile(path, new TextEncoder().encode("remote"), true)).toBe(`${path}.bak.1`);
  expect(await readFile(`${path}.bak`, "utf8")).toBe("older");
  expect(await readFile(`${path}.bak.1`, "utf8")).toBe("local");
  expect(await readFile(path, "utf8")).toBe("remote");
  await expect(installPulledFile(join(root, "missing"), new TextEncoder().encode("x"), true)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("remote");
});

test("preflight validates every targeted TOML and preserves source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  await initWorkspace(root);
  const showId = await newShow(root);
  const episodeId = await newEpisode(root, showId);
  const showPath = join(root, showId, "show.toml");
  const episodePath = join(root, showId, episodeId, "episode.toml");
  const files = [{ path: showPath, kind: "show" as const, showId }, { path: episodePath, kind: "episode" as const, showId, episodeId }];
  const checked = await preflightMetadata(files);
  expect(Buffer.from(checked[0]!.bytes).toString()).toBe(await readFile(showPath, "utf8"));
  await writeFile(episodePath, 'schema_version = 1\nid = "e-01234567"\nshow_id = "s-01234567"\nunknown = true\n');
  await expect(preflightMetadata(files)).rejects.toThrow(episodePath);
});
