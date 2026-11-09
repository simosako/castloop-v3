import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { episodeIdPattern, episodeSchema, newId, objectRefSchema, parseToml, showIdPattern, showSchema, stringifyToml, type ObjectRef, type Operation } from "@castloop/domain";
import { collectSnapshot } from "./api";
import { UsageError } from "./errors";
import { decidePull, installPulledFile, reservedDraftIds } from "./workspace";

const MAX_TOML_BYTES = 256 * 1024;
export interface MetadataFile { path: string; kind: "show" | "episode"; showId: string; episodeId?: string }
export interface CheckedMetadata extends MetadataFile { bytes: Uint8Array }
export class MetadataPreflightError extends Error {}

/** Preflight every targeted file before any caller begins uploading. */
export async function preflightMetadata(files: MetadataFile[]): Promise<CheckedMetadata[]> {
  const checked: CheckedMetadata[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      if (!showIdPattern.test(file.showId)) throw new Error("Invalid show ID");
      const bytes = await readFile(file.path);
      if (bytes.length > MAX_TOML_BYTES) throw new Error("TOML exceeds 256 KiB");
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = parseToml(source);
      if (file.kind === "show") {
        const show = showSchema.parse(parsed);
        if (show.id !== file.showId) throw new Error("Show ID does not match its path");
      } else {
        if (!file.episodeId || !episodeIdPattern.test(file.episodeId)) throw new Error("Invalid episode ID");
        const episode = episodeSchema.parse(parsed);
        if (episode.id !== file.episodeId || episode.show_id !== file.showId) throw new Error("Episode identity does not match its path");
      }
      checked.push({ ...file, bytes });
    } catch (error) { errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (errors.length) throw new MetadataPreflightError(errors.join("\n"));
  return checked;
}

export interface TimezoneNormalization { original: Uint8Array; normalized: Uint8Array; insertedTimezone: string | null }

/** Prepare a preview; existing episode timezone takes precedence over the show default. */
export function prepareTimezoneNormalization(source: Uint8Array, showTimezone?: string, previousTimezone?: string): TimezoneNormalization {
  if (source.byteLength > MAX_TOML_BYTES) throw new Error("TOML exceeds 256 KiB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  const parsed = parseToml(text);
  const episode = episodeSchema.parse(parsed);
  const timezone = previousTimezone || showTimezone;
  if (episode.timezone !== undefined || !timezone) return { original: source, normalized: source, insertedTimezone: null };
  const normalized = new TextEncoder().encode(stringifyToml({ ...parsed, timezone }));
  if (normalized.byteLength > MAX_TOML_BYTES) throw new Error("Normalized TOML exceeds 256 KiB");
  return { original: source, normalized, insertedTimezone: timezone };
}

/** Apply a preview only after preserving the exact original source as a backup. */
export async function applyTimezoneNormalization(path: string, preview: TimezoneNormalization): Promise<string | null> {
  if (!preview.insertedTimezone) return null;
  const current = await readFile(path);
  if (!current.equals(Buffer.from(preview.original))) throw new Error("Episode TOML changed after normalization preview");
  return installPulledFile(path, preview.normalized, true);
}

interface ReidentificationJournal {
  version: 1; kind: "show" | "episode"; showId: string; oldId: string; newId: string;
  files: { relative: string; original: string; replacement: string }[];
}
const journalPath = (root: string) => join(root, ".castloop", "reidentify.json");

export async function hasInterruptedReidentification(root: string): Promise<boolean> {
  try { await lstat(journalPath(root)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function saveReidentification(root: string, journal: ReidentificationJournal): Promise<void> {
  const destination = journalPath(root), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(journal), { flag: "wx", mode: 0o600 });
    await link(temporary, destination); // Never overwrite an unresolved move.
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}

/** Restore a move interrupted before completion, without overwriting later edits. */
export async function recoverReidentification(root: string): Promise<{ oldId: string; newId: string } | null> {
  let bytes: Buffer;
  try { bytes = await readFile(journalPath(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const j = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ReidentificationJournal;
  if (j.version !== 1 || !showIdPattern.test(j.showId) || !Array.isArray(j.files) || !j.files.length ||
      (j.kind === "show" ? !showIdPattern.test(j.oldId) || !showIdPattern.test(j.newId) || j.showId !== j.oldId :
       j.kind === "episode" ? !episodeIdPattern.test(j.oldId) || !episodeIdPattern.test(j.newId) : true) || j.oldId === j.newId) throw new Error("Invalid ID-change recovery record; inspect .castloop/reidentify.json");
  const parent = j.kind === "show" ? root : join(root, j.showId), oldDir = join(parent, j.oldId), newDir = join(parent, j.newId);
  const exists = async (path: string) => { try { return (await lstat(path)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
  const oldExists = await exists(oldDir), newExists = await exists(newDir);
  if (oldExists && !newExists) { await unlink(journalPath(root)); return { oldId: j.oldId, newId: j.newId }; }
  if (oldExists || !newExists) throw new Error("ID-change recovery found unexpected directories; inspect .castloop/reidentify.json");
  const seen = new Set<string>();
  const entries = await Promise.all(j.files.map(async file => {
    if (!file || typeof file.relative !== "string" || typeof file.original !== "string" || typeof file.replacement !== "string" ||
        !(file.relative === (j.kind === "show" ? "show.toml" : "episode.toml") || (j.kind === "show" && /^e-[0-9abcdefghjkmnpqrstvwxyz]{8}[\\/]episode\.toml$/.test(file.relative))) || seen.has(file.relative)) throw new Error("Invalid ID-change recovery file");
    seen.add(file.relative);
    const original = Buffer.from(file.original, "base64"), replacement = Buffer.from(file.replacement, "base64");
    if (original.length > MAX_TOML_BYTES || replacement.length > MAX_TOML_BYTES || original.toString("base64") !== file.original || replacement.toString("base64") !== file.replacement) throw new Error("Invalid ID-change recovery contents");
    const path = join(newDir, file.relative), current = await readFile(path);
    if (!current.equals(original) && !current.equals(replacement)) throw new Error(`ID-change recovery stopped because ${path} was edited; inspect the recovery record`);
    return { path, current, original };
  }));
  for (const entry of entries) if (!entry.current.equals(entry.original)) await installPulledFile(entry.path, entry.original, false);
  await rename(newDir, oldDir);
  await unlink(journalPath(root));
  return { oldId: j.oldId, newId: j.newId };
}

/** Move an unaccepted Episode draft, preserving all local files and the original TOML. */
export async function reidentifyEpisodeDraft(root: string, showId: string, episodeId: string, expected: Uint8Array): Promise<{ episodeId: string; path: string; bytes: Uint8Array; backup: string }> {
  if (!showIdPattern.test(showId) || !episodeIdPattern.test(episodeId)) throw new Error("Invalid draft identity");
  const dir = join(root, showId, episodeId), path = join(dir, "episode.toml");
  const current = await readFile(path);
  if (!current.equals(Buffer.from(expected))) throw new Error("Episode TOML changed after push preflight");
  const parsed = parseToml(new TextDecoder("utf-8", { fatal: true }).decode(current));
  const episode = episodeSchema.parse(parsed);
  if (episode.id !== episodeId || episode.show_id !== showId) throw new Error("Episode identity does not match its path");
  const reserved = await reservedDraftIds(root, showId);
  for (let attempt = 0; attempt < 10; attempt++) {
    const next = newId("episode"), target = join(root, showId, next);
    if (reserved.has(next)) continue;
    try { await mkdir(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    // The workspace is operated by one CLI at a time. Reserve and then move the
    // directory so MP3 and other local files do not need to be copied.
    await rmdir(target);
    const bytes = new TextEncoder().encode(stringifyToml({ ...parsed, id: next }));
    if (bytes.length > MAX_TOML_BYTES) throw new Error("Reidentified TOML exceeds 256 KiB");
    await saveReidentification(root, { version: 1, kind: "episode", showId, oldId: episodeId, newId: next,
      files: [{ relative: "episode.toml", original: current.toString("base64"), replacement: Buffer.from(bytes).toString("base64") }] });
    const newPath = join(target, "episode.toml");
    try {
      await rename(dir, target);
      if (!(await readFile(newPath)).equals(current)) throw new Error("Episode TOML changed while moving the draft");
      const backup = await installPulledFile(newPath, bytes, true);
      if (!backup) throw new Error("Could not preserve original TOML");
      await unlink(journalPath(root));
      return { episodeId: next, path: newPath, bytes, backup };
    } catch (error) {
      try { await recoverReidentification(root); }
      catch { throw new Error(`Could not finish or roll back Episode ID change; inspect ${target} and .castloop/reidentify.json: ${error instanceof Error ? error.message : String(error)}`); }
      throw error;
    }
  }
  throw new Error("Could not allocate an unused episode ID");
}

/** Reidentify a wholly new Show and its Episode TOML, retaining media and backups. */
export async function reidentifyShowDraft(root: string, showId: string, expectedShow: Uint8Array, expectedEpisodes: { episodeId: string; bytes: Uint8Array }[]): Promise<{ showId: string; show: Uint8Array; episodes: { episodeId: string; bytes: Uint8Array }[]; backups: string[] }> {
  if (!showIdPattern.test(showId) || expectedEpisodes.some(item => !episodeIdPattern.test(item.episodeId)) || new Set(expectedEpisodes.map(item => item.episodeId)).size !== expectedEpisodes.length) throw new Error("Invalid draft identity");
  const dir = join(root, showId);
  const files = [{ relative: "show.toml", expected: expectedShow, episodeId: null as string | null }, ...expectedEpisodes.map(item => ({ relative: join(item.episodeId, "episode.toml"), expected: item.bytes, episodeId: item.episodeId }))];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && episodeIdPattern.test(entry.name) && await readOptional(join(dir, entry.name, "episode.toml")) !== null) found.push(entry.name);
  }
  if (found.length !== expectedEpisodes.length || found.some(id => !expectedEpisodes.some(item => item.episodeId === id))) throw new Error("Episode drafts changed after push preflight");
  const parsed = await Promise.all(files.map(async file => {
    const current = await readFile(join(dir, file.relative));
    if (!current.equals(Buffer.from(file.expected))) throw new Error(`${file.relative} changed after push preflight`);
    const raw = parseToml(new TextDecoder("utf-8", { fatal: true }).decode(current));
    if (file.episodeId) {
      const episode = episodeSchema.parse(raw);
      if (episode.id !== file.episodeId || episode.show_id !== showId) throw new Error("Episode identity does not match its path");
    } else if (showSchema.parse(raw).id !== showId) throw new Error("Show identity does not match its path");
    return raw;
  }));
  const reserved = await reservedDraftIds(root);
  for (let attempt = 0; attempt < 10; attempt++) {
    const next = newId("show"), target = join(root, next);
    if (reserved.has(next)) continue;
    try { await mkdir(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    await rmdir(target);
    const replacements = parsed.map((raw, i) => new TextEncoder().encode(stringifyToml({ ...raw, ...(files[i]!.episodeId ? { show_id: next } : { id: next }) })));
    if (replacements.some(bytes => bytes.length > MAX_TOML_BYTES)) throw new Error("Reidentified TOML exceeds 256 KiB");
    await saveReidentification(root, { version: 1, kind: "show", showId, oldId: showId, newId: next,
      files: files.map((file, i) => ({ relative: file.relative, original: Buffer.from(file.expected).toString("base64"), replacement: Buffer.from(replacements[i]!).toString("base64") })) });
    const backups: string[] = [];
    try {
      await rename(dir, target);
      for (let i = 0; i < files.length; i++) {
        const path = join(target, files[i]!.relative);
        if (!(await readFile(path)).equals(Buffer.from(files[i]!.expected))) throw new Error(`${files[i]!.relative} changed while moving the draft`);
        const backup = await installPulledFile(path, replacements[i]!, true);
        if (!backup) throw new Error("Could not preserve original TOML");
        backups.push(backup);
      }
      await unlink(journalPath(root));
      return { showId: next, show: replacements[0]!, episodes: files.slice(1).map((file, i) => ({ episodeId: file.episodeId!, bytes: replacements[i + 1]! })), backups };
    } catch (error) {
      try { await recoverReidentification(root); }
      catch { throw new Error(`Could not finish or roll back Show ID change; inspect ${target} and .castloop/reidentify.json: ${error instanceof Error ? error.message : String(error)}`); }
      throw error;
    }
  }
  throw new Error("Could not allocate an unused show ID");
}

export interface FileBaseline { sha256: string; ref: ObjectRef; deleted: boolean }
export interface ShowBaseline { revision: number; files: Record<string, FileBaseline> }
interface WorkspaceState { version: 1; shows: Record<string, ShowBaseline> }
interface PullDependencies {
  getPage(cursor?: string): Promise<unknown>;
  readObject(ref: ObjectRef): Promise<{ bytes: Uint8Array; etag: string }>;
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
async function readOptional(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function parseState(value: unknown): WorkspaceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace state");
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !state.shows || typeof state.shows !== "object" || Array.isArray(state.shows)) throw new Error("Invalid workspace state");
  for (const [id, value] of Object.entries(state.shows)) {
    if (!showIdPattern.test(id) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace show state");
    const show = value as Record<string, unknown>;
    if (!Number.isSafeInteger(show.revision) || (show.revision as number) < 0 || !show.files || typeof show.files !== "object" || Array.isArray(show.files)) throw new Error("Invalid workspace show state");
    for (const [path, item] of Object.entries(show.files)) {
      if (!(path === "show.toml" || /^e-[0-9abcdefghjkmnpqrstvwxyz]{8}\/episode\.toml$/.test(path)) || !item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid workspace file state");
      const file = item as Record<string, unknown>;
      if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256) || typeof file.deleted !== "boolean" || !objectRefSchema.safeParse(file.ref).success) throw new Error("Invalid workspace file state");
    }
  }
  return state as unknown as WorkspaceState;
}

export interface ShowPushPlan { showId: string; baseline: ShowBaseline | undefined; show: CheckedMetadata | null; showSource: CheckedMetadata | null; episodes: CheckedMetadata[] }

/** Preflight every targeted TOML before returning any upload plan. */
export async function planMetadataPush(root: string, onlyShow?: string): Promise<ShowPushPlan[]> {
  if (onlyShow !== undefined && !showIdPattern.test(onlyShow)) throw new UsageError("Invalid show ID");
  const state = parseState(JSON.parse(await readFile(join(root, ".castloop", "state.json"), "utf8")));
  const ids = onlyShow ? [onlyShow] : (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && showIdPattern.test(entry.name)).map(entry => entry.name).sort();
  const files: MetadataFile[] = [];
  for (const showId of ids) {
    const showDir = join(root, showId);
    let entries;
    try { entries = await readdir(showDir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !onlyShow) continue; throw error; }
    if (entries.some(entry => entry.isFile() && entry.name === "show.toml")) files.push({ kind: "show", showId, path: join(showDir, "show.toml") });
    for (const entry of entries) {
      if (!entry.isDirectory() || !episodeIdPattern.test(entry.name)) continue;
      const path = join(showDir, entry.name, "episode.toml");
      if (await readOptional(path) !== null) files.push({ kind: "episode", showId, episodeId: entry.name, path });
    }
  }
  const checked = await preflightMetadata(files);
  const plans: ShowPushPlan[] = [];
  for (const showId of ids) {
    const baseline = state.shows[showId];
    const changed = checked.filter(file => file.showId === showId && digest(file.bytes) !== baseline?.files[file.kind === "show" ? "show.toml" : `${file.episodeId}/episode.toml`]?.sha256);
    const show = changed.find(file => file.kind === "show") ?? null;
    if (show && baseline?.files["show.toml"]?.deleted) throw new Error(`${showId}: a deleted show cannot be recreated with push`);
    const episodes = changed.filter(file => file.kind === "episode");
    for (const episode of episodes) if (baseline?.files[`${episode.episodeId}/episode.toml`]?.deleted) throw new Error(`${showId}/${episode.episodeId}: a deleted episode cannot be recreated with push`);
    const showSource = checked.find(file => file.showId === showId && file.kind === "show") ?? null;
    plans.push({ showId, baseline, show, showSource, episodes });
  }
  return plans;
}

/** Pull one consistent metadata snapshot; media bodies are never downloaded. */
export async function pullShow(root: string, showId: string, deps: PullDependencies): Promise<{ revision: number; backups: string[]; tombstones: string[] }> {
  const statePath = join(root, ".castloop", "state.json");
  const state = parseState(JSON.parse(await readFile(statePath, "utf8")));
  const snapshot = await collectSnapshot(showId, deps.getPage);
  const previous = state.shows[showId];
  const entries = [{ relative: "show.toml", ref: snapshot.show.metadata, deleted: snapshot.show.deleted, episodeId: undefined as string | undefined },
    ...snapshot.episodes.map(item => ({ relative: `${item.episode_id}/episode.toml`, ref: item.metadata, deleted: snapshot.show.deleted || item.deleted, episodeId: item.episode_id }))];
  async function download(entry: typeof entries[number]) {
    if (entry.deleted) return { ...entry, bytes: null, sha256: previous?.files[entry.relative]?.sha256 ?? "0".repeat(64) };
    if (entry.ref.size > MAX_TOML_BYTES) throw new Error(`${entry.relative}: TOML exceeds 256 KiB`);
    const object = await deps.readObject(entry.ref);
    if (object.etag !== entry.ref.etag || object.bytes.length !== entry.ref.size) throw new Error(`${entry.relative}: object identity mismatch`);
    const sha256 = digest(object.bytes);
    if (entry.ref.sha256 && sha256 !== entry.ref.sha256) throw new Error(`${entry.relative}: object digest mismatch`);
    const parsed = parseToml(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes));
    if (entry.episodeId) {
      const episode = episodeSchema.parse(parsed);
      if (episode.id !== entry.episodeId || episode.show_id !== showId) throw new Error(`${entry.relative}: episode identity mismatch`);
    } else if (showSchema.parse(parsed).id !== showId) throw new Error(`${entry.relative}: show identity mismatch`);
    return { ...entry, bytes: object.bytes, sha256 };
  }
  const downloads: Awaited<ReturnType<typeof download>>[] = [];
  for (let index = 0; index < entries.length; index += 8) {
    downloads.push(...await Promise.all(entries.slice(index, index + 8).map(download)));
  }

  const files = await Promise.all(downloads.map(async entry => {
    const path = join(root, showId, entry.relative);
    const local = await readOptional(path);
    const decision = decidePull(previous?.files[entry.relative]?.sha256 ?? null, local ? digest(local) : null, entry.bytes ? entry.sha256 : null);
    return { ...entry, path, local, decision, temporary: `${path}.${crypto.randomUUID()}.tmp` };
  }));
  const backups: string[] = [];
  const staged: string[] = [];
  try {
    for (const file of files) {
      if (file.decision !== "install" && file.decision !== "backup-and-install") continue;
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.temporary, file.bytes!, { flag: "wx" });
      staged.push(file.temporary);
    }
    for (const file of files) {
      if (file.decision !== "backup-and-install") continue;
      let saved = false;
      for (let n = 0; n < 1000; n++) {
        const path = `${file.path}.bak${n ? `.${n}` : ""}`;
        try { await copyFile(file.path, path, constants.COPYFILE_EXCL); backups.push(path); saved = true; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      if (!saved) throw new Error(`Could not back up ${file.path}`);
    }
    // Never install a snapshot over edits made while fetching or backing up.
    for (const file of files) {
      if (file.decision !== "install" && file.decision !== "backup-and-install") continue;
      const now = await readOptional(file.path);
      if ((file.local === null) !== (now === null) || (file.local && now && !file.local.equals(now))) throw new Error(`${file.path}: local file changed during pull; run pull again`);
    }
    for (const file of files) {
      if (file.decision === "install" || file.decision === "backup-and-install") await rename(file.temporary, file.path);
    }
    const nextFiles = { ...(previous?.files ?? {}) };
    for (const file of files) nextFiles[file.relative] = { sha256: file.sha256, ref: file.ref, deleted: file.deleted };
    state.shows[showId] = { revision: snapshot.revision, files: nextFiles };
    const stateTemp = `${statePath}.${crypto.randomUUID()}.tmp`;
    staged.push(stateTemp);
    await writeFile(stateTemp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
    await rename(stateTemp, statePath);
  } finally {
    for (const path of staged) await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
  return { revision: snapshot.revision, backups, tombstones: files.filter(file => file.deleted).map(file => file.relative) };
}

/** Advance the local baseline only after a structurally valid acceptance response. */
export async function recordAcceptedOperation(root: string, showId: string, operation: Operation, acceptedRevision: number): Promise<boolean> {
  if (!showIdPattern.test(showId) || acceptedRevision !== operation.expected_revision + 1) throw new Error("Accepted operation identity or revision is invalid");
  if (operation.action === "restore" || operation.action === "restore-resume") return false;
  const path = join(root, ".castloop", "state.json");
  const state = parseState(JSON.parse(await readFile(path, "utf8")));
  const old = state.shows[showId];
  // An operation based on a fresh remote snapshot must not make an older local
  // TOML baseline look current. The administrator must pull that snapshot first.
  if (old && old.revision === acceptedRevision) return true;
  if ((old?.revision ?? 0) !== operation.expected_revision) return false;
  const files = { ...(old?.files ?? {}) };
  if (operation.action === "metadata.batch") {
    if (operation.payload.show) {
      const ref = operation.payload.show.metadata;
      files["show.toml"] = { sha256: ref.sha256, ref, deleted: false };
    }
    for (const episode of operation.payload.episodes) {
      const ref = episode.metadata;
      files[`${episode.episode_id}/episode.toml`] = { sha256: ref.sha256, ref, deleted: false };
    }
  } else if (operation.action === "episode.delete") {
    const key = `${operation.payload.episode_id}/episode.toml`;
    if (files[key]) files[key] = { ...files[key], deleted: true };
  } else if (operation.action === "show.delete") {
    for (const [key, file] of Object.entries(files)) files[key] = { ...file, deleted: true };
  }
  state.shows[showId] = { revision: acceptedRevision, files };
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  return true;
}
