import { canonicalJson } from "./contracts";
import { checkEpisodeReadiness, type AudioFacts, type ReadinessIssue } from "./readiness";
import type { Episode, Show } from "./validation";

export interface SelectionEpisode {
  metadata: Episode;
  deleted: boolean;
  audio?: AudioFacts;
  time: { timezone: string; input_signature: string; instant_ms: number } | null;
  /** True only for a failed outcome with the same current target identity. */
  failed: boolean;
}

export type EpisodeSelection =
  | { state: "withdraw" }
  | { state: "invalid"; issues: ReadinessIssue[] }
  | { state: "scheduled"; at: number }
  | { state: "failed" }
  | { state: "eligible"; at: number };

/** Classify one accepted episode without re-resolving its recorded release time. */
export function selectEpisode(show: Show, episode: SelectionEpisode, now: number, retryFailed = false): EpisodeSelection {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid selection time");
  if (episode.deleted || episode.metadata.publish !== true) return { state: "withdraw" };
  const time = episode.time;
  const timezone = episode.metadata.timezone ?? time?.timezone ?? show.timezone;
  const signature = episode.metadata.published_at && timezone
    ? canonicalJson({ published_at: String(episode.metadata.published_at), timezone }) : null;
  const matches = !!time && !!signature && time.input_signature === signature && time.timezone === timezone && Number.isSafeInteger(time.instant_ms) && time.instant_ms >= 0;
  const issues = checkEpisodeReadiness({ ...episode.metadata, ...(timezone ? { timezone } : {}) }, show, episode.audio, { acceptedTimeMatches: matches });
  if (!matches && !issues.some(issue => issue.path === "published_at")) issues.push({ path: "published_at", message: "Accepted publication time is missing or inconsistent" });
  if (issues.length) return { state: "invalid", issues };
  // Failed targets are retried only by an explicit recovery, including when
  // their scheduled release has not yet arrived.
  if (episode.failed && !retryFailed) return { state: "failed" };
  if (time!.instant_ms > now) return { state: "scheduled", at: time!.instant_ms };
  return { state: "eligible", at: time!.instant_ms };
}
