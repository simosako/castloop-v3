import { expect, test } from "bun:test";
import { canonicalJson, episodeSchema, parseToml, selectEpisode, showSchema, type SelectionEpisode } from "../src";

test("eligible episodes use the accepted instant and future episodes are scheduled", () => {
  const show = showSchema.parse({ schema_version: 1, id: "s-01234567", timezone: "America/New_York" });
  const metadata = episodeSchema.parse(parseToml('schema_version = 1\nid = "e-01234567"\nshow_id = "s-01234567"\npublish = true\ntitle = "Title"\ndescription = "Description"\ntimezone = "Asia/Tokyo"\npublished_at = 2026-11-01T12:00:00+09:00'));
  const at = Date.parse("2026-11-01T03:00:00Z");
  const episode: SelectionEpisode = { metadata, deleted: false, audio: { mime: "audio/mpeg", size: 100, durationMs: 1000 }, failed: false,
    time: { timezone: "Asia/Tokyo", input_signature: canonicalJson({ published_at: String(metadata.published_at), timezone: "Asia/Tokyo" }), instant_ms: at } };
  expect(selectEpisode(show, episode, at - 1)).toEqual({ state: "scheduled", at });
  expect(selectEpisode(show, episode, at)).toEqual({ state: "eligible", at });
  expect(selectEpisode(show, { ...episode, failed: true }, at)).toEqual({ state: "failed" });
  expect(selectEpisode(show, { ...episode, failed: true }, at, true)).toEqual({ state: "eligible", at });
  expect(selectEpisode(show, { ...episode, deleted: true }, at)).toEqual({ state: "withdraw" });
  expect(selectEpisode(show, { ...episode, metadata: { ...metadata, publish: false } }, at)).toEqual({ state: "withdraw" });
  expect(selectEpisode(show, { ...episode, audio: undefined }, at)).toMatchObject({ state: "invalid", issues: expect.arrayContaining([expect.objectContaining({ path: "audio" })]) });
  expect(selectEpisode(show, { ...episode, time: { ...episode.time!, input_signature: "stale" } }, at)).toMatchObject({ state: "invalid", issues: expect.arrayContaining([expect.objectContaining({ path: "published_at" })]) });
});
