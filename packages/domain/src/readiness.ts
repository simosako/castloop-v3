import taxonomy from "./apple-categories.json";
import { renderDescription } from "./html";
import { resolvePublicationTime } from "./time";
import type { Episode, Show } from "./validation";
import { hasInvalidXmlCharacters } from "./xml-characters";

export interface ReadinessIssue { path: string; message: string }
export interface CoverFacts { mime: "image/jpeg" | "image/png"; width: number; height: number; color: string; alpha: boolean }
export interface AudioFacts { mime: "audio/mpeg"; size: number; durationMs: number }

function required(issues: ReadinessIssue[], path: string, value: string | undefined): void {
  if (!value?.trim()) issues.push({ path, message: "Required for publication" });
}
function url(issues: ReadinessIssue[], path: string, value: string | undefined): void {
  if (!value) return;
  try { if (new URL(value).protocol !== "https:") throw new Error(); }
  catch { issues.push({ path, message: "Must be an absolute HTTPS URL" }); }
}
function xmlText(issues: ReadinessIssue[], path: string, value: string | undefined): void {
  if (value && hasInvalidXmlCharacters(value)) issues.push({ path, message: "Contains characters that are not allowed in XML" });
}
function description(issues: ReadinessIssue[], value: string | undefined, max: number, unit: "bytes" | "characters"): void {
  required(issues, "description", value);
  if (!value) return;
  const length = unit === "bytes" ? new TextEncoder().encode(value).length : Array.from(value).length;
  if (length > max) issues.push({ path: "description", message: `Exceeds ${max} ${unit}` });
  try { xmlText(issues, "description", renderDescription(value)); } catch (error) { issues.push({ path: "description", message: error instanceof Error ? error.message : String(error) }); }
}
function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(0); return !/^[+-]/.test(zone); } catch { return false; }
}

/** Readiness errors do not prevent saving a structurally valid draft. */
export function checkShowReadiness(show: Show, cover?: CoverFacts): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  for (const key of ["title", "website", "language", "timezone", "artwork"] as const) required(issues, key, show[key]);
  for (const key of ["title", "website", "language", "author", "copyright", "apple_verification"] as const) xmlText(issues, key, show[key]);
  description(issues, show.description, 4000, "bytes");
  url(issues, "website", show.website);
  if (show.timezone && !validZone(show.timezone)) issues.push({ path: "timezone", message: "Unknown IANA timezone" });
  if (show.explicit === undefined) issues.push({ path: "explicit", message: "Required for publication" });
  if (show.artwork && !/^[^/\\]+\.(?:jpe?g|png)$/i.test(show.artwork)) issues.push({ path: "artwork", message: "Expected a JPEG or PNG basename" });
  if (!show.categories?.length) issues.push({ path: "categories", message: "At least one Apple category is required" });
  for (const [index, item] of (show.categories ?? []).entries()) {
    const categories: Record<string, string[]> = taxonomy.categories;
    if (!Object.hasOwn(categories, item.name) || (item.subcategory !== undefined && !categories[item.name]!.includes(item.subcategory))) {
      issues.push({ path: `categories.${index}`, message: "Unknown Apple category or subcategory" });
    }
  }
  if (!cover || cover.width !== cover.height || cover.width < 1400 || cover.width > 3000 || cover.color !== "rgb" || cover.alpha || !["image/jpeg", "image/png"].includes(cover.mime)) {
    issues.push({ path: "artwork", message: "A square 1400–3000 pixel RGB JPEG/PNG cover without transparency is required" });
  }
  return issues;
}

export function checkEpisodeReadiness(episode: Episode, show: Show, audio?: AudioFacts, options: { acceptedTimeMatches?: boolean } = {}): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  required(issues, "title", episode.title);
  xmlText(issues, "title", episode.title);
  xmlText(issues, "website", episode.website);
  description(issues, episode.description, 10000, "characters");
  url(issues, "website", episode.website);
  if (episode.show_id !== show.id) issues.push({ path: "show_id", message: "Show ID does not match" });
  if (show.type === "serial" && !episode.episode_number) issues.push({ path: "episode_number", message: "Required for serial shows" });
  const timezone = episode.timezone ?? show.timezone;
  if (!timezone || (!options.acceptedTimeMatches && !validZone(timezone))) issues.push({ path: "timezone", message: "A valid IANA timezone is required" });
  if (!episode.published_at) issues.push({ path: "published_at", message: "Required for publication" });
  else if (timezone && !options.acceptedTimeMatches && validZone(timezone)) {
    try { resolvePublicationTime(episode.published_at, timezone); }
    catch (error) { issues.push({ path: "published_at", message: error instanceof Error ? error.message : String(error) }); }
  }
  if (!audio || audio.mime !== "audio/mpeg" || !Number.isSafeInteger(audio.size) || audio.size <= 0 || !Number.isSafeInteger(audio.durationMs) || audio.durationMs <= 0) {
    issues.push({ path: "audio", message: "An inspected nonempty MP3 is required" });
  }
  return issues;
}
