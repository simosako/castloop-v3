import { expect, test } from "bun:test";
import { checkEpisodeReadiness, checkShowReadiness, parseToml, episodeSchema, type Show } from "../src";

const show: Show = { schema_version: 1, id: "s-01234567", title: "A", description: "Hello", website: "https://example.com", language: "ja", timezone: "Asia/Tokyo", artwork: "cover.jpg", categories: [{ name: "Technology" }], explicit: false };
const cover = { mime: "image/jpeg" as const, width: 1400, height: 1400, color: "rgb", alpha: false };

test("readiness is separate from schema acceptance and checks show metadata and cover", () => {
  expect(checkShowReadiness(show, cover)).toEqual([]);
  const issues = checkShowReadiness({ ...show, website: "http://example.com", categories: [{ name: "Technology", subcategory: "Invented" }] });
  expect(issues.map(issue => issue.path)).toContain("website");
  expect(issues.map(issue => issue.path)).toContain("categories.0");
  expect(issues.map(issue => issue.path)).toContain("artwork");
});

test("episode readiness checks audio, matching identity and time", () => {
  const episode = episodeSchema.parse(parseToml('schema_version = 1\nid = "e-01234567"\nshow_id = "s-01234567"\ntitle = "Title"\ndescription = "Hi"\npublished_at = 2026-01-01T12:00:00'));
  expect(checkEpisodeReadiness(episode, show, { mime: "audio/mpeg", size: 100, durationMs: 1000 })).toEqual([]);
  expect(checkEpisodeReadiness(episode, show).map(issue => issue.path)).toContain("audio");
  expect(checkEpisodeReadiness(episode, { ...show, type: "serial" }).map(issue => issue.path)).toContain("episode_number");
});
