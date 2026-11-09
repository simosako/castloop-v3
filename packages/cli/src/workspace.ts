import { constants } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { episodeIdPattern, newId, operationFingerprint, operationSchema, showIdPattern, showSchema, parseToml, type Operation } from "@castloop/domain";
import { episodeTemplate, showTemplate } from "./templates";
import type { RejectedOperationError } from "./api";
import { UsageError } from "./errors";

async function assertWorkspace(root: string): Promise<void> {
  try { await readFile(join(root, ".castloop", "config.toml")); }
  catch { throw new Error("Workspace not initialized; run castloop init first"); }
}

export async function initWorkspace(root: string): Promise<void> {
  await mkdir(join(root, ".castloop")); // Refuse to overwrite existing configuration.
  await writeFile(join(root, ".castloop", "config.toml"), "# Nonsecret installation configuration\n", { flag: "wx" });
  await writeFile(join(root, ".castloop", "state.json"), '{"version":1,"shows":{}}\n', { flag: "wx" });
}

/** IDs remain reserved even if their local directories were removed. */
export async function reservedDraftIds(root: string, showId?: string): Promise<Set<string>> {
  const raw: unknown = JSON.parse(await readFile(join(root, ".castloop", "state.json"), "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid workspace state");
  const state = raw as Record<string, unknown>;
  if (state.version !== 1 || !state.shows || typeof state.shows !== "object" || Array.isArray(state.shows)) throw new Error("Invalid workspace state");
  const ids = new Set<string>();
  for (const [id, value] of Object.entries(state.shows)) {
    if (!showIdPattern.test(id) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace show state");
    const files = (value as Record<string, unknown>).files;
    if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("Invalid workspace show state");
    if (!showId) ids.add(id);
    else if (id === showId) for (const key of Object.keys(files)) {
      const match = /^(e-[0-9abcdefghjkmnpqrstvwxyz]{8})\/episode\.toml$/.exec(key);
      if (match) ids.add(match[1]!);
      else if (key !== "show.toml") throw new Error("Invalid workspace file state");
    }
  }
  let files: string[];
  try { files = await readdir(join(root, ".castloop", "pending")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files = []; }
  for (const filename of files) {
    const id = filename.endsWith(".json") ? filename.slice(0, -5) : "";
    if (!uuidPattern.test(id)) continue;
    const receipt = await readPendingOperation(root, id);
    if (!showId) ids.add(receipt.show_id);
    else if (receipt.show_id === showId && receipt.operation.action === "metadata.batch") {
      for (const episode of receipt.operation.payload.episodes) if (episode.mode === "create") ids.add(episode.episode_id);
    }
  }
  return ids;
}

export async function newShow(root: string, generate: () => string = () => newId("show")): Promise<string> {
  await assertWorkspace(root);
  const reserved = await reservedDraftIds(root);
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = generate();
    if (!showIdPattern.test(id)) throw new Error("Invalid generated show ID");
    if (reserved.has(id)) continue;
    const dir = join(root, id);
    try { await mkdir(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    await writeFile(join(dir, "show.toml"), showTemplate(id), { flag: "wx" });
    return id;
  }
  throw new Error("Could not allocate an unused show ID");
}

export async function newEpisode(root: string, showId: string, generate: () => string = () => newId("episode")): Promise<string> {
  if (!showIdPattern.test(showId)) throw new UsageError("Invalid show ID");
  await assertWorkspace(root);
  const show = showSchema.parse(parseToml(await readFile(join(root, showId, "show.toml"), "utf8")));
  if (show.id !== showId) throw new Error("Show ID does not match the workspace path");
  const reserved = await reservedDraftIds(root, showId);
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = generate();
    if (!episodeIdPattern.test(id)) throw new Error("Invalid generated episode ID");
    if (reserved.has(id)) continue;
    const dir = join(root, showId, id);
    try { await mkdir(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    await writeFile(join(dir, "episode.toml"), episodeTemplate(showId, id), { flag: "wx" });
    return id;
  }
  throw new Error("Could not allocate an unused episode ID");
}

export type PullDecision = "keep" | "install" | "backup-and-install" | "tombstone";

/** Compare a previously fetched baseline, local bytes and the new remote bytes. */
export function decidePull(baseline: string | null, local: string | null, remote: string | null): PullDecision {
  if (remote === null) return "tombstone";
  if (local === null) return "install";
  if (local === remote || remote === baseline) return "keep";
  if (baseline !== null && local === baseline) return "install";
  return "backup-and-install";
}

/** Install one already-staged remote file, preserving a divergent local file first. */
export async function installPulledFile(path: string, contents: Uint8Array, backup: boolean): Promise<string | null> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  let backupPath: string | null = null;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    if (backup) {
      for (let n = 0; n < 1000; n++) {
        const candidate = `${path}.bak${n === 0 ? "" : `.${n}`}`;
        try { await copyFile(path, candidate, constants.COPYFILE_EXCL); backupPath = candidate; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      }
      if (!backupPath) throw new Error("Could not create a unique backup");
    }
    await rename(temporary, path);
    return backupPath;
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

export interface PendingOperation { version: 1; show_id: string; operation: Operation; fingerprint: string }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Persist the exact finalized operation before sending it to the management API. */
export async function savePendingOperation(root: string, showId: string, raw: Operation): Promise<PendingOperation> {
  if (!showIdPattern.test(showId)) throw new Error("Invalid show ID");
  await assertWorkspace(root);
  const operation = operationSchema.parse(raw);
  const receipt: PendingOperation = { version: 1, show_id: showId, operation, fingerprint: await operationFingerprint(showId, operation) };
  const directory = join(root, ".castloop", "pending");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${operation.operation_id}.json`);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    try { await link(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const old = await readPendingOperation(root, operation.operation_id);
      if (old.show_id !== showId || old.fingerprint !== receipt.fingerprint) throw new Error("Pending operation ID already exists with different intent");
    }
  } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  return receipt;
}

export async function readPendingOperation(root: string, operationId: string): Promise<PendingOperation> {
  if (!uuidPattern.test(operationId)) throw new UsageError("Invalid operation ID");
  const bytes = await readFile(join(root, ".castloop", "pending", `${operationId}.json`));
  if (bytes.length > 1024 * 1024) throw new Error("Pending operation is too large");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pending operation");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.show_id !== "string" || !showIdPattern.test(record.show_id) || typeof record.fingerprint !== "string") throw new Error("Invalid pending operation");
  const operation = operationSchema.parse(record.operation);
  if (operation.operation_id !== operationId || await operationFingerprint(record.show_id, operation) !== record.fingerprint) throw new Error("Pending operation identity or fingerprint mismatch");
  return { version: 1, show_id: record.show_id, operation, fingerprint: record.fingerprint };
}

/** A new push must not disguise an earlier, possibly accepted, uncertain request. */
export async function assertNoPendingOperations(root: string, showIds: readonly string[]): Promise<void> {
  if (!showIds.length) return;
  let files: string[];
  try { files = await readdir(join(root, ".castloop", "pending")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of files.sort()) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!uuidPattern.test(id)) continue; // Other receipt types have their own prefix.
    const receipt = await readPendingOperation(root, id);
    if (showIds.includes(receipt.show_id)) throw new Error(`Show ${receipt.show_id} has an unresolved operation; run castloop operation retry ${id} before pushing`);
  }
}

export async function removePendingOperation(root: string, operationId: string): Promise<void> {
  await readPendingOperation(root, operationId);
  await unlink(join(root, ".castloop", "pending", `${operationId}.json`));
}

/** Explicitly stop retrying without destroying the only copy of the request. */
export async function abandonPendingOperation(root: string, operationId: string): Promise<PendingOperation> {
  const receipt = await readPendingOperation(root, operationId);
  const source = join(root, ".castloop", "pending", `${operationId}.json`);
  const directory = join(root, ".castloop", "abandoned"), target = join(directory, `${operationId}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await link(source, target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await readFile(source)).equals(await readFile(target))) throw new Error("An abandoned receipt with different contents already exists");
  }
  await unlink(source);
  return receipt;
}

/** Keep the known server rejection when removing its local receipt fails. */
export class RejectedReceiptCleanupError extends Error {
  constructor(readonly rejection: RejectedOperationError, cause: unknown) {
    super(`Operation was rejected (${rejection.code}: ${rejection.message}); could not remove its local receipt: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function removeRejectedReceipt(root: string, operationId: string, rejection: RejectedOperationError): Promise<void> {
  try { await removePendingOperation(root, operationId); }
  catch (error) { throw new RejectedReceiptCleanupError(rejection, error); }
}
