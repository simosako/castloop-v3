/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { canonicalJson, parseToml } from "@castloop/domain";
import type { ShowDO } from "../src";
import { prepareCandidate } from "../src/candidate";
import { applyCandidate } from "../src/publication";
import { checkShow } from "../src/show";

test("builds complete 100-, 1000- and 2000-episode candidates from SQLite and bounded object reads", async () => {
  const showId = "s-fghjkmnp", op = "12345678-1234-4234-8234-123456789abc";
  const objects = new Map<string, { bytes: Uint8Array; etag: string; sha256: string }>();
  let gets = 0, heads = 0;
  const add = async (key: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    const etag = '"fixture"'; objects.set(key, { bytes, etag, sha256 });
    return { key, etag, size: bytes.length, sha256 };
  };
  const bucket = {
    async head(key: string) { heads++; const item = objects.get(key); return item ? { httpEtag: item.etag, size: item.bytes.length, customMetadata: { sha256: item.sha256 } } : null; },
    async get(key: string) { gets++; const item = objects.get(key); return item ? { httpEtag: item.etag, size: item.bytes.length, body: true, arrayBuffer: async () => item.bytes.slice().buffer } : null; },
  } as unknown as R2Bucket;
  const delivered = new Map<string, string>();
  const delivery = {
    async delete(key: string) { delivered.delete(key); },
    async put(key: string, value: string) { delivered.set(key, value); },
  } as unknown as R2Bucket;
  const show = await add(`${showId}/_versions/${op}/show.toml`, `schema_version = 1\nid = "${showId}"\npublish = true\ntitle = "Archive"\ndescription = "Description"\nwebsite = "https://example.com"\nlanguage = "en"\ntimezone = "UTC"\nartwork = "cover.png"\ncategories = [{name="Technology"}]\nexplicit = false\n`);
  const cover = await add(`${showId}/_versions/${op}/cover.png`, "cover");
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance: ShowDO, state) => {
    const sql = state.storage.sql;
    const asset = (ref: typeof show) => sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", ref.key, JSON.stringify({ state: "present", ref }));
    asset(show); asset(cover);
    const control = { record_version: 1, show_id: showId, revision: 1, metadata: show, cover: { logical_name: "cover.png", ref: cover, facts: { mime: "image/png", width: 1400, height: 1400, color: "rgb", alpha: false } }, deleted: false, accepted_at: 1, last_receipt: null,
      current_delivery: { base: "https://delivery.example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
    for (let index = 0; index < 2000; index++) {
      const id = `e-${index.toString(16).padStart(8, "0")}`;
      const text = `schema_version = 1\nid = "${id}"\nshow_id = "${showId}"\npublish = true\ntitle = "Episode ${index}"\ndescription = "Details"\ntimezone = "UTC"\npublished_at = 2020-01-01T00:00:00Z\n`;
      const metadata = await add(`${showId}/${id}/_versions/${op}/episode.toml`, text);
      const audio = await add(`${showId}/${id}/_versions/${op}/audio.mp3`, "audio");
      asset(metadata); asset(audio);
      const parsed = parseToml(text) as { published_at: unknown };
      const guid = `urn:uuid:episode-${index}`;
      const record = { record_version: 1, episode_id: id, guid, metadata, audio: { ref: audio, facts: { mime: "audio/mpeg", duration_ms: 1000 } },
        time: { timezone: "UTC", input_signature: canonicalJson({ published_at: String(parsed.published_at), timezone: "UTC" }), instant_ms: 1577836800000 }, publish: true, deleted: false };
      sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", id, guid, JSON.stringify(record));
      sql.exec("INSERT INTO publication_outcomes VALUES (?, 'pending', ?)", id, JSON.stringify({ target: id, state: "pending", desired_identity: `identity-${index}` }));
      if (index === 99 || index === 999 || index === 1999) {
        if (index === 99) {
          const first = `${showId}/e-00000000/_versions/${op}/episode.toml`;
          const second = `${showId}/e-00000001/_versions/${op}/episode.toml`;
          const savedFirst = objects.get(first)!, savedSecond = objects.get(second)!;
          objects.delete(first); objects.delete(second);
          let active = 0, maxActive = 0;
          const observed = {
            head: (key: string) => bucket.head(key),
            async get(key: string) {
              active++; maxActive = Math.max(active, maxActive);
              try { await Promise.resolve(); return await bucket.get(key); }
              finally { active--; }
            },
          } as unknown as R2Bucket;
          try {
            const checked = await checkShow(state.storage, observed, showId);
            expect(checked.issues.map(issue => issue.path)).toEqual(["episodes.e-00000000.metadata", "episodes.e-00000001.metadata"]);
            expect(maxActive).toBeGreaterThan(1);
            expect(maxActive).toBeLessThanOrEqual(8);
          } finally { objects.set(first, savedFirst); objects.set(second, savedSecond); }
          let changed = false;
          const changing = {
            head: (key: string) => bucket.head(key),
            async get(key: string) {
              if (key === first && !changed) {
                changed = true;
                sql.exec("UPDATE show_control SET revision = 2, record_json = ? WHERE singleton = 1", JSON.stringify({ ...control, revision: 2 }));
              }
              return bucket.get(key);
            },
          } as unknown as R2Bucket;
          try { await expect(checkShow(state.storage, changing, showId)).rejects.toThrow("Show changed during check"); }
          finally { sql.exec("UPDATE show_control SET revision = 1, record_json = ? WHERE singleton = 1", JSON.stringify(control)); }
        }
        gets = 0; heads = 0;
        const start = performance.now();
        const candidate = await prepareCandidate(state.storage, bucket, showId, Date.now());
        try {
          expect(candidate.state).toBe("ready");
          if (candidate.state !== "ready") throw new Error("Archive was not ready");
          expect(candidate.episodes.filter(item => item.state === "eligible")).toHaveLength(index + 1);
          expect(candidate.snapshot?.episodes).toHaveLength(index + 1);
          expect(candidate.feed.match(/<item>/g)).toHaveLength(index + 1);
          expect(candidate.feed).toContain(`urn:uuid:episode-${index}`);
          expect(gets).toBe(index + 2);
          expect(heads).toBe(index + 2);
          expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM source_pins").one().count).toBe(2 * (index + 1) + 2);
          let copies = 0;
          const purges: string[][] = [];
          const groups: number[] = [];
          const result = index === 999 ? "not applied" : await applyCandidate(state.storage, delivery, showId, candidate, async () => { throw new Error("Unexpected direct copy"); }, async paths => { purges.push(paths); }, "acceptance", async items => { groups.push(items.length); copies += items.length; });
          if (index === 99) {
            expect(result).toBe("applied");
            expect(copies).toBe(101);
            expect(groups).toEqual([...Array(25).fill(4), 1]);
            expect(purges).toEqual([[`/${showId}/`], [`/${showId}/feed.xml`]]);
            expect(delivered.get(`${showId}/feed.xml`)).toBe(candidate.feed);
            expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM delivery_refs").one().count).toBe(index + 2);
          } else if (index === 1999) {
            expect(result).toBe("failed");
            expect(copies).toBe(0);
            expect(groups).toEqual([]);
            expect(purges).toEqual([]);
            expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM delivery_refs").one().count).toBe(101);
          } else {
            expect(result).toBe("not applied");
          }
          const rows = {
            episodes: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM episodes").one().count,
            source_assets: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM source_assets").one().count,
            publication_outcomes: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publication_outcomes").one().count,
            delivery_refs: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM delivery_refs").one().count,
          };
          expect(rows.episodes).toBe(index + 1);
          expect(rows.source_assets).toBe(2 * (index + 1) + 2);
          console.log(JSON.stringify({ archive_episodes: index + 1, feed_bytes: new TextEncoder().encode(candidate.feed).length, sql_rows: rows, mock_gets: gets, mock_heads: heads, mock_copies: copies, mock_purge_calls: purges.length, elapsed_ms: Math.round(performance.now() - start), cpu_ms: "not measured", memory_bytes: "not measured" }));
        } finally { candidate.release(); }
        expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM source_pins").one().count).toBe(0);
      }
    }
  });
}, 60_000);
