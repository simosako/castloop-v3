import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, showIdPattern, showSchema, parseToml } from "@castloop/domain";
import { episodeTemplate, showTemplate } from "./templates";

async function assertWorkspace(root: string): Promise<void> {
  try { await readFile(join(root, ".castloop", "config.toml")); }
  catch { throw new Error("Workspace not initialized; run castloop init first"); }
}

export async function initWorkspace(root: string): Promise<void> {
  await mkdir(join(root, ".castloop")); // Refuse to overwrite existing configuration.
  await writeFile(join(root, ".castloop", "config.toml"), "# Nonsecret installation configuration\n", { flag: "wx" });
  await writeFile(join(root, ".castloop", "state.json"), '{"version":1,"shows":{}}\n', { flag: "wx" });
}

export async function newShow(root: string): Promise<string> {
  await assertWorkspace(root);
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = newId("show");
    const dir = join(root, id);
    try { await mkdir(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    await writeFile(join(dir, "show.toml"), showTemplate(id), { flag: "wx" });
    return id;
  }
  throw new Error("Could not allocate an unused show ID");
}

export async function newEpisode(root: string, showId: string): Promise<string> {
  if (!showIdPattern.test(showId)) throw new Error("Invalid show ID");
  await assertWorkspace(root);
  const show = showSchema.parse(parseToml(await readFile(join(root, showId, "show.toml"), "utf8")));
  if (show.id !== showId) throw new Error("Show ID does not match the workspace path");
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = newId("episode");
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
