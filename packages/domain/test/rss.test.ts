import { expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import { inspectFeedEpisode, renderDescription, renderFeed, type FeedInput } from "../src";

const input: FeedInput = {
  show: { schema_version: 1, id: "s-01234567", title: "A & B", description: "Hello <strong>world</strong>", website: "https://example.com", language: "ja", explicit: false, categories: [{ name: "Technology" }] },
  baseUrl: "https://pod.example.com", artworkUrl: "https://pod.example.com/s-01234567/covers/1.jpg", builtAt: 0,
  episodes: [{ metadata: { schema_version: 1, id: "e-01234567", show_id: "s-01234567", title: "First <episode>", description: "Text ]]&gt; end" }, guid: "urn:uuid:stable", publishedAt: 1000, audioBytes: 500, durationMs: 13500 }],
};

test("renders full RSS with escaped text, stable GUID, media facts and CDATA", () => {
  const output = renderFeed(input);
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(output);
  expect(parsed.rss.channel.title).toBe("A &amp; B");
  expect(parsed.rss.channel.item.guid["#text"]).toBe("urn:uuid:stable");
  expect(parsed.rss.channel.item.enclosure["@_length"]).toBe("500");
  expect(output).toContain("]]&gt; end");
  expect(output).toContain("First &lt;episode&gt;");
});

test("keeps administrator contact private while publishing the show author", () => {
  const output = renderFeed({ ...input, show: { ...input.show, author: "Public Presenter",
    admin: { name: "Private Administrator", email: "private-admin@example.com" } } });
  const channel = new XMLParser({ ignoreAttributes: false }).parse(output).rss.channel;
  expect(channel["itunes:author"]).toBe("Public Presenter");
  expect(output).not.toContain("Private Administrator");
  expect(output).not.toContain("private-admin@example.com");
  expect(channel["itunes:owner"]).toBeUndefined();
});

test("feed inspection matches GUID and enclosure within the same item", () => {
  const audio = "https://pod.example.com/s-01234567/e-01234567/audio.mp3";
  const feed = renderFeed(input);
  expect(inspectFeedEpisode(feed, "urn:uuid:stable", audio)).toBe(true);
  expect(inspectFeedEpisode(feed, "urn:uuid:stable", `${audio}-other`)).toBe(false);
  expect(inspectFeedEpisode(feed, "urn:uuid:missing")).toBe(false);
  expect(inspectFeedEpisode(`<rss><channel><item><description><![CDATA[urn:uuid:stable ${audio}]]></description></item></channel></rss>`, "urn:uuid:stable", audio)).toBe(false);
  expect(() => inspectFeedEpisode("<!DOCTYPE rss><rss/>", "id")).toThrow("Invalid RSS");
  expect(() => inspectFeedEpisode("<rss>", "id")).toThrow("Invalid RSS");
});

test("rejects dangerous or unsupported descriptions and keeps allowed markup", () => {
  expect(renderDescription('<p>Hi <a href="https://example.com">there</a><!-- hidden --></p>')).toBe('<p>Hi <a href="https://example.com">there</a></p>');
  for (const html of ['<script>alert(1)</script>', '<a href="javascript:alert(1)">x</a>', '<p onclick="x">x</p>', '<svg><path></path></svg>', '<html><p>x</p></html>', '<!doctype html>']) {
    expect(() => renderDescription(html)).toThrow();
  }
});

test("refuses incomplete metadata and mismatched episodes", () => {
  expect(() => renderFeed({ ...input, show: { ...input.show, title: " " } })).toThrow();
  expect(() => renderFeed({ ...input, episodes: [{ ...input.episodes[0]!, metadata: { ...input.episodes[0]!.metadata, show_id: "s-76543210" } }] })).toThrow();
});

test("rejects invalid XML characters without rejecting valid supplementary characters", () => {
  expect(() => renderFeed({ ...input, show: { ...input.show, title: "Invalid\u0001" } })).toThrow("Invalid XML character");
  expect(() => renderFeed({ ...input, show: { ...input.show, title: "Invalid\ud800" } })).toThrow("Invalid XML character");
  expect(renderFeed({ ...input, show: { ...input.show, title: "Podcast 🎙️" } })).toContain("Podcast 🎙️");
});

test("renders a complete thousand-episode archive with stable GUIDs and enclosures", () => {
  const episodes = Array.from({ length: 1000 }, (_, index) => ({ ...input.episodes[0]!,
    metadata: { ...input.episodes[0]!.metadata, id: `e-${index.toString(16).padStart(8, "0")}`, title: `Episode ${index}` },
    guid: `urn:archive:${index}`, publishedAt: index * 1000 }));
  const output = renderFeed({ ...input, episodes });
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(output);
  expect(parsed.rss.channel.item).toHaveLength(1000);
  expect(parsed.rss.channel.item[0].guid["#text"]).toBe("urn:archive:999");
  expect(parsed.rss.channel.item[999].guid["#text"]).toBe("urn:archive:0");
  expect(parsed.rss.channel.item[0].enclosure["@_url"]).toContain("/e-000003e7/audio.mp3");
});
