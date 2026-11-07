import { readFile } from "node:fs/promises";
import { episodeIdPattern, episodeSchema, parseToml, showIdPattern, showSchema } from "@castloop/domain";

const MAX_TOML_BYTES = 256 * 1024;
export interface MetadataFile { path: string; kind: "show" | "episode"; showId: string; episodeId?: string }
export interface CheckedMetadata extends MetadataFile { bytes: Uint8Array }

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
  if (errors.length) throw new Error(errors.join("\n"));
  return checked;
}
