import { XMLValidator } from "fast-xml-parser";
import { renderDescription } from "./html";
import type { Episode, Show } from "./validation";
import { hasInvalidXmlCharacters } from "./xml-characters";

export interface FeedEpisode {
  metadata: Episode;
  guid: string;
  publishedAt: number;
  audioBytes: number;
  durationMs: number;
}

export interface FeedInput {
  show: Show;
  baseUrl: string;
  artworkUrl: string;
  episodes: FeedEpisode[];
  builtAt: number;
  newFeedUrl?: string;
}

function xml(value: string): string {
  if (hasInvalidXmlCharacters(value)) throw new Error("Invalid XML character");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function tag(name: string, value: string | number): string { return `<${name}>${xml(String(value))}</${name}>`; }
function cdata(value: string): string {
  xml(value); // Check XML character validity even though text is wrapped in CDATA.
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}
function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value;
}
function https(value: string, field: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${field} must be an absolute HTTPS URL`); }
  if (url.protocol !== "https:") throw new Error(`${field} must be an absolute HTTPS URL`);
  return url.toString();
}
function date(value: number): string {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw new Error("Invalid feed datetime");
  return new Date(value).toUTCString();
}

/** Render one complete RSS document from an already selected eligible episode set. */
export function renderFeed(input: FeedInput): string {
  const { show } = input;
  const base = https(input.baseUrl, "baseUrl").replace(/\/+$/, "");
  const feedUrl = `${base}/${show.id}/feed.xml`;
  const title = required(show.title, "show.title");
  const description = renderDescription(required(show.description, "show.description"));
  const website = https(required(show.website, "show.website"), "show.website");
  const artwork = https(input.artworkUrl, "artworkUrl");
  const language = required(show.language, "show.language");
  if (show.explicit === undefined) throw new Error("show.explicit is required");
  if (!show.categories?.length) throw new Error("show.categories is required");
  const channel: string[] = [tag("title", title), tag("link", website), `<description>${cdata(description)}</description>`,
    tag("language", language), tag("lastBuildDate", date(input.builtAt)), tag("generator", "Castloop"),
    `<atom:link href="${xml(feedUrl)}" rel="self" type="application/rss+xml"/>`,
    `<itunes:image href="${xml(artwork)}"/>`, tag("itunes:explicit", show.explicit ? "true" : "false"),
    tag("itunes:type", show.type ?? "episodic")];
  if (show.author) channel.push(tag("itunes:author", show.author));
  if (show.copyright) channel.push(tag("copyright", show.copyright));
  if (show.complete) channel.push(tag("itunes:complete", "true"));
  if (show.apple_verification) channel.push(tag("itunes:verification", show.apple_verification));
  if (input.newFeedUrl) channel.push(tag("itunes:new-feed-url", https(input.newFeedUrl, "newFeedUrl")));
  for (const category of show.categories) {
    const name = xml(required(category.name, "category.name"));
    channel.push(category.subcategory ? `<itunes:category text="${name}"><itunes:category text="${xml(category.subcategory)}"/></itunes:category>` : `<itunes:category text="${name}"/>`);
  }
  for (const item of [...input.episodes].sort((a, b) => b.publishedAt - a.publishedAt || (a.metadata.id < b.metadata.id ? -1 : a.metadata.id > b.metadata.id ? 1 : 0))) {
    const ep = item.metadata;
    if (ep.show_id !== show.id) throw new Error("Episode belongs to a different show");
    if (!Number.isSafeInteger(item.audioBytes) || item.audioBytes <= 0 || !Number.isSafeInteger(item.durationMs) || item.durationMs <= 0) throw new Error("Invalid audio facts");
    const entry = [tag("title", required(ep.title, "episode.title")), `<description>${cdata(renderDescription(required(ep.description, "episode.description")))}</description>`,
      `<guid isPermaLink="false">${xml(required(item.guid, "episode.guid"))}</guid>`, tag("pubDate", date(item.publishedAt)),
      `<enclosure url="${xml(`${base}/${show.id}/${ep.id}/audio.mp3`)}" length="${item.audioBytes}" type="audio/mpeg"/>`,
      tag("itunes:duration", Math.max(1, Math.round(item.durationMs / 1000))), tag("itunes:explicit", (ep.explicit ?? show.explicit) ? "true" : "false"),
      tag("itunes:episodeType", ep.episode_type ?? "full")];
    if (ep.website) entry.push(tag("link", https(ep.website, "episode.website")));
    if (ep.episode_number) entry.push(tag("itunes:episode", ep.episode_number));
    if (ep.season_number) entry.push(tag("itunes:season", ep.season_number));
    channel.push(`<item>${entry.join("")}</item>`);
  }
  const output = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom"><channel>${channel.join("")}</channel></rss>`;
  const result = XMLValidator.validate(output);
  if (result !== true) throw new Error(`Generated XML is invalid: ${result.err.msg}`);
  return output;
}
