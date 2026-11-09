import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { episodeSchema, parseToml, showSchema } from "@castloop/domain";
import { abandonPendingOperation, assertNoPendingOperations, decidePull, initWorkspace, installPulledFile, newEpisode, newShow, readPendingOperation, removePendingOperation, savePendingOperation } from "../src/workspace";
import { applyTimezoneNormalization, planMetadataPush, preflightMetadata, prepareTimezoneNormalization, pullShow, recordAcceptedOperation, recoverReidentification, reidentifyEpisodeDraft, reidentifyShowDraft } from "../src/metadata";
import type { Operation } from "@castloop/domain";

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

test("new drafts do not reuse synced or pending IDs when local directories are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-reserved-ids-")); dirs.push(root);
  await initWorkspace(root);
  const oldShow = "s-01234567", newShowId = "s-12345678", oldEpisode = "e-01234567", pendingEpisode = "e-23456789", newEpisodeId = "e-3456789a";
  const ref = { key: "key", etag: '"etag"', size: 1, sha256: "a".repeat(64) };
  const file = { sha256: ref.sha256, ref, deleted: true };
  const statePath = join(root, ".castloop", "state.json");
  await writeFile(statePath, JSON.stringify({ version: 1, shows: { [oldShow]: { revision: 1, files: { "show.toml": file } } } }));
  const showCandidates = [oldShow, newShowId];
  expect(await newShow(root, () => showCandidates.shift()!)).toBe(newShowId);
  await expect(readFile(join(root, oldShow, "show.toml"))).rejects.toThrow();
  await writeFile(statePath, JSON.stringify({ version: 1, shows: {
    [oldShow]: { revision: 1, files: { "show.toml": file } },
    [newShowId]: { revision: 1, files: { "show.toml": file, [`${oldEpisode}/episode.toml`]: file } },
  } }));
  await savePendingOperation(root, newShowId, { protocol_version: 1, operation_id: "12345678-1234-4234-8234-123456789abc", expected_revision: 1, action: "metadata.batch",
    payload: { episodes: [{ mode: "create", episode_id: pendingEpisode, metadata: ref, guid: "urn:uuid:test" }] } });
  const episodeCandidates = [oldEpisode, pendingEpisode, newEpisodeId];
  expect(await newEpisode(root, newShowId, () => episodeCandidates.shift()!)).toBe(newEpisodeId);
  await expect(readFile(join(root, newShowId, oldEpisode, "episode.toml"))).rejects.toThrow();
  await expect(readFile(join(root, newShowId, pendingEpisode, "episode.toml"))).rejects.toThrow();
});

test("reidentifying an Episode preserves its local media and original TOML", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-reidentify-")); dirs.push(root);
  await initWorkspace(root);
  const show = await newShow(root), episode = await newEpisode(root, show);
  const path = join(root, show, episode, "episode.toml");
  await writeFile(path, `schema_version = 1\nid = "${episode}"\nshow_id = "${show}"\ntitle = "Example"\npublished_at = 2026-11-01T12:00:00+09:00\n# keep this in backup\n`);
  await writeFile(join(root, show, episode, "local.mp3"), "audio");
  const original = await readFile(path);
  await expect(reidentifyEpisodeDraft(root, show, episode, Buffer.from("stale"))).rejects.toThrow("changed after");
  expect(await readFile(path)).toEqual(original);
  const changed = await reidentifyEpisodeDraft(root, show, episode, original);
  expect(changed.episodeId).not.toBe(episode);
  expect(await readFile(changed.backup)).toEqual(original);
  expect(await readFile(join(root, show, changed.episodeId, "local.mp3"), "utf8")).toBe("audio");
  const metadata = episodeSchema.parse(parseToml(await readFile(changed.path, "utf8")));
  expect(metadata).toMatchObject({ id: changed.episodeId, show_id: show, title: "Example" });
  expect(String(metadata.published_at)).toContain("2026-11-01T12:00:00+09:00");
  await expect(readFile(path)).rejects.toThrow();
});

test("reidentifying a Show updates Episode ownership and preserves original files", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-show-reidentify-")); dirs.push(root);
  await initWorkspace(root);
  const show = await newShow(root), episode = await newEpisode(root, show);
  const showPath = join(root, show, "show.toml"), episodePath = join(root, show, episode, "episode.toml");
  const showBytes = await readFile(showPath), episodeBytes = await readFile(episodePath);
  await writeFile(join(root, show, episode, "local.mp3"), "audio");
  await expect(reidentifyShowDraft(root, show, showBytes, [])).rejects.toThrow("Episode drafts changed");
  expect(await readFile(showPath)).toEqual(showBytes);
  const changed = await reidentifyShowDraft(root, show, showBytes, [{ episodeId: episode, bytes: episodeBytes }]);
  expect(changed.showId).not.toBe(show);
  expect(showSchema.parse(parseToml(await readFile(join(root, changed.showId, "show.toml"), "utf8"))).id).toBe(changed.showId);
  expect(episodeSchema.parse(parseToml(await readFile(join(root, changed.showId, episode, "episode.toml"), "utf8"))).show_id).toBe(changed.showId);
  expect(await readFile(join(root, changed.showId, episode, "local.mp3"), "utf8")).toBe("audio");
  expect(await readFile(changed.backups[0]!)).toEqual(showBytes);
  expect(await readFile(changed.backups[1]!)).toEqual(episodeBytes);
});

test("a failed Show reidentification restores already changed TOML and the original directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-show-reidentify-failure-")); dirs.push(root);
  await initWorkspace(root);
  const show = await newShow(root), episode = await newEpisode(root, show);
  const showPath = join(root, show, "show.toml"), episodePath = join(root, show, episode, "episode.toml");
  const showBytes = await readFile(showPath), episodeBytes = await readFile(episodePath);
  for (let i = 0; i < 1000; i++) await writeFile(`${episodePath}.bak${i ? `.${i}` : ""}`, "existing backup");
  await expect(reidentifyShowDraft(root, show, showBytes, [{ episodeId: episode, bytes: episodeBytes }])).rejects.toThrow("Could not create a unique backup");
  expect(await readFile(showPath)).toEqual(showBytes);
  expect(await readFile(episodePath)).toEqual(episodeBytes);
  expect(await readFile(`${episodePath}.bak`, "utf8")).toBe("existing backup");
});

test("interrupted Show ID change restores mixed TOML, but never overwrites later edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-id-recovery-")); dirs.push(root);
  await initWorkspace(root);
  const show = await newShow(root), episode = await newEpisode(root, show), next = "s-01234567";
  const originalShow = await readFile(join(root, show, "show.toml")), originalEpisode = await readFile(join(root, show, episode, "episode.toml"));
  const changedShow = Buffer.from(originalShow.toString().replace(show, next));
  const changedEpisode = Buffer.from(originalEpisode.toString().replace(show, next));
  await writeFile(join(root, show, episode, "audio.mp3"), "audio");
  const record = { version: 1, kind: "show", showId: show, oldId: show, newId: next, files: [
    { relative: "show.toml", original: originalShow.toString("base64"), replacement: changedShow.toString("base64") },
    { relative: join(episode, "episode.toml"), original: originalEpisode.toString("base64"), replacement: changedEpisode.toString("base64") },
  ] };
  await writeFile(join(root, ".castloop", "reidentify.json"), JSON.stringify(record));
  await rename(join(root, show), join(root, next));
  await writeFile(join(root, next, "show.toml"), changedShow);
  await writeFile(join(root, next, episode, "episode.toml"), "administrator edit");
  await expect(recoverReidentification(root)).rejects.toThrow("was edited");
  expect(await readFile(join(root, next, "show.toml"))).toEqual(changedShow);
  expect(await readFile(join(root, next, episode, "episode.toml"), "utf8")).toBe("administrator edit");
  await writeFile(join(root, next, episode, "episode.toml"), originalEpisode);
  expect(await recoverReidentification(root)).toEqual({ oldId: show, newId: next });
  expect(await readFile(join(root, show, "show.toml"))).toEqual(originalShow);
  expect(await readFile(join(root, show, episode, "episode.toml"))).toEqual(originalEpisode);
  expect(await readFile(join(root, show, episode, "audio.mp3"), "utf8")).toBe("audio");
  expect(await recoverReidentification(root)).toBeNull();
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

test("pull stages a consistent snapshot, preserves divergent local edits and does not fetch tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  await initWorkspace(root);
  const showId = "s-01234567";
  const episodeId = "e-01234567";
  const path = join(root, showId, "show.toml");
  const content = (title: string) => Buffer.from(`schema_version = 1\nid = "${showId}"\ntitle = "${title}"\n`);
  const epBytes = Buffer.from(`schema_version = 1\nid = "${episodeId}"\nshow_id = "${showId}"\n`);
  const ref = (key: string, bytes: Buffer) => ({ key, etag: '"etag"', size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  let showBytes = content("original");
  let revision = 1;
  let deleted = false;
  let fetched = 0;
  const deps = {
    async getPage() { return { protocol_version: 1, show_id: showId, revision, show: { metadata: ref("show", showBytes), deleted: false }, episodes: [{ episode_id: episodeId, metadata: ref("episode", epBytes), guid: "opaque", deleted }], next_cursor: null }; },
    async readObject(object: { key: string; etag: string }) { fetched++; return { etag: object.etag, bytes: object.key === "show" ? showBytes : epBytes }; },
  };
  await pullShow(root, showId, deps);
  expect(await readFile(path, "utf8")).toBe(showBytes.toString());
  const local = content("local edit");
  await writeFile(path, local);
  revision = 2;
  showBytes = content("remote edit");
  deleted = true;
  fetched = 0;
  const result = await pullShow(root, showId, deps);
  expect(await readFile(path, "utf8")).toBe(showBytes.toString());
  expect(await readFile(`${path}.bak`, "utf8")).toBe(local.toString());
  expect(result.tombstones).toEqual([`${episodeId}/episode.toml`]);
  expect(fetched).toBe(1);
  expect(JSON.parse(await readFile(join(root, ".castloop/state.json"), "utf8")).shows[showId].revision).toBe(2);
});

test("revision drift between pages leaves local files and baseline unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  await initWorkspace(root);
  const showId = "s-01234567";
  const baseline = await readFile(join(root, ".castloop/state.json"), "utf8");
  const ref = { key: "show", etag: '"etag"', size: 1, sha256: "a".repeat(64) };
  const deps = {
    async getPage(cursor?: string) { return { protocol_version: 1, show_id: showId, revision: cursor ? 2 : 1, show: { metadata: ref, deleted: false },
      episodes: cursor ? [] : [{ episode_id: "e-01234567", metadata: ref, guid: "opaque", deleted: false }], next_cursor: cursor ? null : "next" }; },
    async readObject() { throw new Error("must not read objects before all pages are verified"); },
  };
  await expect(pullShow(root, showId, deps)).rejects.toThrow("changed during pull");
  expect(await readFile(join(root, ".castloop/state.json"), "utf8")).toBe(baseline);
  await expect(readFile(join(root, showId, "show.toml"))).rejects.toThrow();
});

test("a later backup failure leaves every pulled file and baseline unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  await initWorkspace(root);
  const showId = "s-01234567", episodeId = "e-01234567";
  const showPath = join(root, showId, "show.toml"), episodePath = join(root, showId, episodeId, "episode.toml");
  const show = (title: string) => Buffer.from(`schema_version = 1\nid = "${showId}"\ntitle = "${title}"\n`);
  const episode = (title: string) => Buffer.from(`schema_version = 1\nid = "${episodeId}"\nshow_id = "${showId}"\ntitle = "${title}"\n`);
  const ref = (key: string, bytes: Buffer) => ({ key, etag: '"etag"', size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  let revision = 1, showBytes = show("original"), episodeBytes = episode("original");
  const deps = {
    async getPage() { return { protocol_version: 1, show_id: showId, revision, show: { metadata: ref("show", showBytes), deleted: false },
      episodes: [{ episode_id: episodeId, metadata: ref("episode", episodeBytes), guid: "opaque", deleted: false }], next_cursor: null }; },
    async readObject(object: { key: string; etag: string }) { return { etag: object.etag, bytes: object.key === "show" ? showBytes : episodeBytes }; },
  };
  await pullShow(root, showId, deps);
  const baseline = await readFile(join(root, ".castloop/state.json"));
  const localShow = show("local"), localEpisode = episode("local");
  await writeFile(showPath, localShow);
  await writeFile(episodePath, localEpisode);
  await Promise.all(Array.from({ length: 1000 }, (_, n) => mkdir(`${episodePath}.bak${n ? `.${n}` : ""}`)));
  revision = 2; showBytes = show("remote"); episodeBytes = episode("remote");
  await expect(pullShow(root, showId, deps)).rejects.toThrow("Could not back up");
  expect(await readFile(showPath)).toEqual(localShow);
  expect(await readFile(episodePath)).toEqual(localEpisode);
  expect(await readFile(`${showPath}.bak`)).toEqual(localShow);
  expect(await readFile(join(root, ".castloop/state.json"))).toEqual(baseline);
});

test("timezone normalization preserves the existing episode zone and backs up original bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  const path = join(root, "episode.toml");
  const original = Buffer.from('# Keep this comment\nschema_version = 1\nid = "e-01234567"\nshow_id = "s-01234567"\npublished_at = 2026-11-01T01:30:00-04:00\n');
  await writeFile(path, original);
  const preview = prepareTimezoneNormalization(original, "Asia/Tokyo", "America/New_York");
  expect(preview.insertedTimezone).toBe("America/New_York");
  expect(await applyTimezoneNormalization(path, preview)).toBe(`${path}.bak`);
  expect(await readFile(`${path}.bak`)).toEqual(original);
  const episode = episodeSchema.parse(parseToml(await readFile(path, "utf8")));
  expect(episode.timezone).toBe("America/New_York");
  expect(String(episode.published_at)).toContain("-04:00");
  const alreadyNormalized = await readFile(path);
  const unchanged = prepareTimezoneNormalization(alreadyNormalized, "Asia/Tokyo");
  expect(unchanged.insertedTimezone).toBeNull();
  expect(Buffer.from(unchanged.normalized)).toEqual(alreadyNormalized);
  await writeFile(path, original);
  const stalePreview = prepareTimezoneNormalization(original, "Asia/Tokyo");
  await writeFile(path, "changed");
  await expect(applyTimezoneNormalization(path, stalePreview)).rejects.toThrow("changed after");
  expect(await readFile(path, "utf8")).toBe("changed");
});

test("pending receipts preserve exact retry intent and reject tampering or ID reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  await initWorkspace(root);
  const operation: Operation = { protocol_version: 1, operation_id: "12345678-1234-4234-8234-123456789abc", expected_revision: 0, action: "show.delete", payload: { confirmed: true } };
  const saved = await savePendingOperation(root, "s-01234567", operation);
  await expect(assertNoPendingOperations(root, ["s-abcdefgh"])).resolves.toBeUndefined();
  await expect(assertNoPendingOperations(root, ["s-01234567"])).rejects.toThrow(`operation retry ${operation.operation_id}`);
  expect(await readPendingOperation(root, operation.operation_id)).toEqual(saved);
  expect(await savePendingOperation(root, "s-01234567", operation)).toEqual(saved);
  await expect(savePendingOperation(root, "s-01234567", { ...operation, expected_revision: 1 })).rejects.toThrow("different intent");
  await expect(readPendingOperation(root, "../escape")).rejects.toThrow("Invalid operation ID");
  const path = join(root, ".castloop", "pending", `${operation.operation_id}.json`);
  const tampered = JSON.parse(await readFile(path, "utf8"));
  tampered.operation.expected_revision = 4;
  await writeFile(path, JSON.stringify(tampered));
  await expect(readPendingOperation(root, operation.operation_id)).rejects.toThrow("fingerprint mismatch");
  await expect(assertNoPendingOperations(root, ["s-01234567"])).rejects.toThrow("fingerprint mismatch");
  await writeFile(path, JSON.stringify(saved));
  await removePendingOperation(root, operation.operation_id);
  await expect(assertNoPendingOperations(root, ["s-01234567"])).resolves.toBeUndefined();
  await expect(readFile(path)).rejects.toThrow();
});

test("abandoning preserves a receipt and refuses to overwrite a different record", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-abandon-")); dirs.push(root);
  await initWorkspace(root);
  const operation: Operation = { protocol_version: 1, operation_id: "12345678-1234-4234-8234-123456789abc", expected_revision: 0, action: "show.delete", payload: { confirmed: true } };
  const saved = await savePendingOperation(root, "s-01234567", operation);
  const directory = join(root, ".castloop", "abandoned"), path = join(directory, `${operation.operation_id}.json`);
  await mkdir(directory);
  await writeFile(path, "different");
  await expect(abandonPendingOperation(root, operation.operation_id)).rejects.toThrow("different contents");
  expect(await readPendingOperation(root, operation.operation_id)).toEqual(saved);
  await rm(path);
  expect(await abandonPendingOperation(root, operation.operation_id)).toEqual(saved);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
  await expect(readPendingOperation(root, operation.operation_id)).rejects.toThrow();
  await expect(assertNoPendingOperations(root, ["s-01234567"])).resolves.toBeUndefined();
});

test("accepted operations advance only the remote baseline without overwriting local edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  await initWorkspace(root);
  const showId = await newShow(root);
  const path = join(root, showId, "show.toml");
  const local = await readFile(path, "utf8");
  const ref = { key: `${showId}/_versions/test/show.toml`, etag: '"etag"', size: 5, sha256: "a".repeat(64) };
  const operation: Operation = { protocol_version: 1, operation_id: "12345678-1234-4234-8234-123456789abc", expected_revision: 0, action: "metadata.batch", payload: { show: { mode: "create", metadata: ref }, episodes: [] } };
  await recordAcceptedOperation(root, showId, operation, 1);
  const state = JSON.parse(await readFile(join(root, ".castloop", "state.json"), "utf8"));
  expect(state.shows[showId]).toMatchObject({ revision: 1, files: { "show.toml": { sha256: ref.sha256, ref, deleted: false } } });
  expect(await readFile(path, "utf8")).toBe(local);
  await expect(recordAcceptedOperation(root, showId, operation, 3)).rejects.toThrow("revision");
  const staleDelete: Operation = { protocol_version: 1, operation_id: "22345678-1234-4234-8234-123456789abc", expected_revision: 5, action: "show.delete", payload: { confirmed: true } };
  expect(await recordAcceptedOperation(root, showId, staleDelete, 6)).toBe(false);
  expect(JSON.parse(await readFile(join(root, ".castloop", "state.json"), "utf8")).shows[showId].revision).toBe(1);
});

test("push preflight groups changed show and episode metadata in one show plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-test-")); dirs.push(root);
  await initWorkspace(root);
  const showId = await newShow(root);
  expect((await planMetadataPush(root, showId))[0]?.show).not.toBeNull();
  const episodeId = await newEpisode(root, showId);
  const plan = (await planMetadataPush(root, showId))[0]!;
  expect(plan.show).not.toBeNull();
  expect(plan.episodes.map(file => file.episodeId)).toEqual([episodeId]);
});
