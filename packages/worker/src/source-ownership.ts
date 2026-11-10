import { episodeIdPattern, showIdPattern } from "@castloop/domain/identity";

export type SourceOwner = { showId: string; operationId: string } & (
  | { kind: "show_toml"; episodeId?: never }
  | { kind: "cover"; episodeId?: never }
  | { kind: "episode_toml"; episodeId: string }
  | { kind: "audio"; episodeId: string }
  | { kind: "maintenance"; episodeId?: never }
);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class SourceIdentityError extends Error {}

/** Derive ownership from the key itself, never from R2 user metadata. */
export function assertSourceOwnership(key: string, owner: SourceOwner): void {
  if (!showIdPattern.test(owner.showId) || !uuid.test(owner.operationId)) throw new SourceIdentityError("Invalid source owner");
  if (owner.episodeId && !episodeIdPattern.test(owner.episodeId)) throw new SourceIdentityError("Invalid episode ID");
  const prefix = owner.episodeId ? `${owner.showId}/${owner.episodeId}` : owner.showId;
  const root = `${prefix}/${owner.kind === "maintenance" ? "_maintenance" : "_versions"}/${owner.operationId}/`;
  if (!key.startsWith(root)) throw new SourceIdentityError("Source object owner or preparation operation does not match");
  const filename = key.slice(root.length);
  const allowed = owner.kind === "show_toml" ? filename === "show.toml"
    : owner.kind === "episode_toml" ? filename === "episode.toml"
    : owner.kind === "audio" ? filename === "audio.mp3"
    : owner.kind === "maintenance" ? filename === "restore.json"
    : /^[^/\\]+\.(?:jpe?g|png)$/i.test(filename);
  if (!allowed) throw new SourceIdentityError("Invalid source object name");
}

