/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { inspectFeedEpisode, operationSchema } from "@castloop/domain";
import type { ShowDO } from "../src";
import { acceptShowMetadata } from "../src/show";
import { prepareCandidate } from "../src/candidate";
import { applyCandidate } from "../src/publication";

test("metadata and audio updates preserve GUID and do not recopy another Episode", async () => {
  const showId = "s-jkmnpqrs", first = "e-01234567", second = "e-12345678";
  const guid1 = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", guid2 = "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const op = (n: number) => `${n}2345678-1234-4234-8234-123456789abc`;
  const put = async (key: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    const stored = await env.MANAGEMENT_BUCKET.put(key, bytes, { customMetadata: { sha256 } });
    return { key, etag: stored!.httpEtag, size: bytes.length, sha256 };
  };
  const episodeText = (id: string, title: string) => `schema_version = 1\nid = "${id}"\nshow_id = "${showId}"\npublish = true\ntitle = "${title}"\ndescription = "Details"\ntimezone = "UTC"\npublished_at = 2020-01-01T00:00:00Z\n`;
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance: ShowDO, state) => {
    const accept = (n: number, revision: number, action: string, payload: object) => acceptShowMetadata(state.storage, env.MANAGEMENT_BUCKET, "https://delivery.example.test", showId,
      operationSchema.parse({ protocol_version: 1, operation_id: op(n), expected_revision: revision, action, payload }));
    const show = await put(`${showId}/_versions/${op(1)}/show.toml`, `schema_version = 1\nid = "${showId}"\npublish = true\ntitle = "Show"\ndescription = "Description"\nwebsite = "https://example.com"\nlanguage = "en"\ntimezone = "UTC"\nartwork = "cover.png"\ncategories = [{name="Technology"}]\nexplicit = false\n`);
    await accept(1, 0, "metadata.batch", { show: { mode: "create", metadata: show }, episodes: [] });
    const cover = await put(`${showId}/_versions/${op(2)}/cover.png`, "cover");
    await accept(2, 1, "cover.set", { logical_name: "cover.png", cover, facts: { mime: "image/png", width: 1400, height: 1400, color: "rgb", alpha: false } });
    const meta1 = await put(`${showId}/${first}/_versions/${op(3)}/episode.toml`, episodeText(first, "Original"));
    const meta2 = await put(`${showId}/${second}/_versions/${op(3)}/episode.toml`, episodeText(second, "Other"));
    await accept(3, 2, "metadata.batch", { episodes: [{ mode: "create", episode_id: first, metadata: meta1, guid: guid1 }, { mode: "create", episode_id: second, metadata: meta2, guid: guid2 }] });
    const audio1 = await put(`${showId}/${first}/_versions/${op(4)}/audio.mp3`, "old audio");
    const audio2 = await put(`${showId}/${second}/_versions/${op(5)}/audio.mp3`, "other audio");
    await accept(4, 3, "audio.set", { episode_id: first, audio: audio1, facts: { mime: "audio/mpeg", duration_ms: 1000 } });
    await accept(5, 4, "audio.set", { episode_id: second, audio: audio2, facts: { mime: "audio/mpeg", duration_ms: 1000 } });
    const copies: string[] = [];
    const publish = async () => {
      const candidate = await prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, showId, Date.now());
      if (candidate.state !== "ready") throw new Error("Expected a ready candidate");
      try {
        expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async (source, path) => {
          copies.push(path);
          const object = await env.MANAGEMENT_BUCKET.get(source.key);
          await env.DELIVERY_BUCKET.put(path, await object!.arrayBuffer());
        }, async () => {})).toBe("applied");
        return candidate.feed;
      } finally { candidate.release(); }
    };
    await publish();
    const original = `${showId}/${first}/audio.mp3`, other = `${showId}/${second}/audio.mp3`;
    expect(await (await env.DELIVERY_BUCKET.get(original))!.text()).toBe("old audio");
    copies.length = 0;
    const edited = await put(`${showId}/${first}/_versions/${op(6)}/episode.toml`, episodeText(first, "Updated"));
    await accept(6, 5, "metadata.batch", { episodes: [{ mode: "update", episode_id: first, metadata: edited }] });
    const updatedFeed = await publish();
    expect(updatedFeed).toContain("<title>Updated</title>");
    expect(inspectFeedEpisode(updatedFeed, guid1, `https://delivery.example.test/${original}`)).toBe(true);
    expect(copies).toEqual([]);
    const replacement = await put(`${showId}/${first}/_versions/${op(7)}/audio.mp3`, "new audio");
    await accept(7, 6, "audio.set", { episode_id: first, audio: replacement, facts: { mime: "audio/mpeg", duration_ms: 2000 } });
    const replacedFeed = await publish();
    expect(inspectFeedEpisode(replacedFeed, guid1, `https://delivery.example.test/${original}`)).toBe(true);
    expect(inspectFeedEpisode(replacedFeed, guid2, `https://delivery.example.test/${other}`)).toBe(true);
    expect(copies).toEqual([original]);
    expect(await (await env.DELIVERY_BUCKET.get(original))!.text()).toBe("new audio");
    expect(await (await env.DELIVERY_BUCKET.get(other))!.text()).toBe("other audio");
  });
});
