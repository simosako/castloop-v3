/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { operationSchema } from "@castloop/domain";
import type { ShowDO } from "../src";
import { acceptShowMetadata } from "../src/show";
import { prepareCandidate } from "../src/candidate";
import { applyCandidate } from "../src/publication";
import { readShowControl } from "../src/storage";

test("migration preflights, publishes a new feed and commits the new origin; retry keeps the receipt", async () => {
  const showId = "s-defghjkm", episodeId = "e-01234567";
  const guid = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const id = (n: number) => `${n}2345678-1234-4234-8234-123456789abc`;
  const put = async (key: string, body: string) => {
    const bytes = new TextEncoder().encode(body);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    const object = await env.MANAGEMENT_BUCKET.put(key, bytes, { customMetadata: { sha256: digest } });
    return { key, etag: object!.httpEtag, size: bytes.length, sha256: digest };
  };
  const show = await put(`${showId}/_versions/${id(1)}/show.toml`, `schema_version = 1\nid = "${showId}"\npublish = true\ntitle = "Test"\ndescription = "Description"\nwebsite = "https://example.com"\nlanguage = "en"\ntimezone = "UTC"\nartwork = "cover.png"\ncategories = [{name="Technology"}]\nexplicit = false\n`);
  const cover = await put(`${showId}/_versions/${id(2)}/cover.png`, "cover");
  const episode = await put(`${showId}/${episodeId}/_versions/${id(3)}/episode.toml`, `schema_version = 1\nid = "${episodeId}"\nshow_id = "${showId}"\npublish = true\ntitle = "Episode"\ndescription = "Details"\ntimezone = "UTC"\npublished_at = 2020-01-01T00:00:00Z\n`);
  const audio = await put(`${showId}/${episodeId}/_versions/${id(4)}/audio.mp3`, "audio");
  await runInDurableObject(env.SHOWS.getByName(showId), async (instance: ShowDO, state) => {
    const accept = (raw: unknown) => acceptShowMetadata(state.storage, env.MANAGEMENT_BUCKET, "https://delivery.example.test", showId, operationSchema.parse(raw));
    const base = (n: number, expected_revision: number) => ({ protocol_version: 1, operation_id: id(n), expected_revision });
    await accept({ ...base(1, 0), action: "metadata.batch", payload: { show: { mode: "create", metadata: show }, episodes: [] } });
    expect(await instance.publicRoute(showId)).toEqual({ state: "serve", base: null });
    await accept({ ...base(2, 1), action: "cover.set", payload: { logical_name: "cover.png", cover, facts: { mime: "image/png", width: 1400, height: 1400, color: "rgb", alpha: false } } });
    await accept({ ...base(3, 2), action: "metadata.batch", payload: { episodes: [{ mode: "create", episode_id: episodeId, metadata: episode, guid }] } });
    await accept({ ...base(4, 3), action: "audio.set", payload: { episode_id: episodeId, audio, facts: { mime: "audio/mpeg", duration_ms: 1000 } } });
    const candidate = await prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, showId, Date.now());
    if (candidate.state !== "ready") throw new Error("Expected ready show");
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async (source, path) => {
      const object = await env.MANAGEMENT_BUCKET.get(source.key);
      await env.DELIVERY_BUCKET.put(path, await object!.arrayBuffer());
    }, async () => {})).toBe("applied");
    candidate.release();
    const held = readShowControl(state.storage, showId)!;
    held.restore_hold = true;
    held.pending_delivery = { base: "https://unconfigured.example.test", migration_operation_id: id(5), accepted_revision: 4 };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(held));
    const refused = await instance.restoreResume(showId, { protocol_version: 1, operation_id: id(6), expected_revision: 4, confirmed: true });
    expect(refused).toMatchObject({ ok: false, status: 409, code: "identity_conflict" });
    expect(readShowControl(state.storage, showId)).toMatchObject({ revision: 4, restore_hold: true });
    held.restore_hold = false;
    held.pending_delivery = null;
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(held));
    const calls: string[] = [];
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.startsWith("https://api.cloudflare.com/")) return Response.json({ success: true, errors: [] });
      if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "5", "cf-cache-status": "HIT" } });
      return new Response("a", { status: 206, headers: { "content-range": "bytes 0-0/5", "cf-cache-status": "MISS" } });
    });
    const operation = operationSchema.parse({ ...base(5, 4), action: "delivery.set", payload: { target_base: "https://podcasts.example.test", confirmed: true } });
    try {
      const result = await instance.operation(showId, operation);
      expect(result).toMatchObject({ ok: true, data: { acceptance: "accepted", delivery: "applied", accepted_revision: 5 } });
      expect(readShowControl(state.storage, showId)).toMatchObject({ current_delivery: { base: "https://podcasts.example.test", previous_base: "https://delivery.example.test" }, pending_delivery: null });
      expect(await instance.publicRoute(showId)).toEqual({ state: "redirect", base: "https://podcasts.example.test" });
      const feed = await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text();
      expect(feed).toContain(`https://podcasts.example.test/${showId}/${episodeId}/audio.mp3`);
      expect(feed).toContain(`<itunes:new-feed-url>https://podcasts.example.test/${showId}/feed.xml</itunes:new-feed-url>`);
      expect(feed).toContain(guid);
      expect(calls.some(call => call.startsWith("HEAD https://podcasts.example.test/"))).toBe(true);
      expect(calls.filter(call => call.startsWith("POST https://api.cloudflare.com/")).length).toBeGreaterThanOrEqual(2);
      const retry = await instance.operation(showId, operation);
      expect(retry).toMatchObject({ ok: true, data: { acceptance: "already_accepted", accepted_revision: 5 } });
    } finally { transport.mockRestore(); }
  });
});
