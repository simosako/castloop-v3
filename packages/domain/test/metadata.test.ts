import { describe, expect, test } from "bun:test";
import { episodeSchema, newGuid, newId, parseToml, showSchema, stringifyToml, Temporal } from "../src";

describe("metadata acceptance", () => {
  test("accepts incomplete drafts and rejects unknown keys and wrong types", () => {
    expect(showSchema.safeParse(parseToml('schema_version = 1\nid = "s-01234567"')).success).toBe(true);
    expect(showSchema.safeParse(parseToml('schema_version = 1\nid = "s-01234567"\npublsh = true')).success).toBe(false);
    expect(showSchema.safeParse(parseToml('schema_version = 1\nid = "s-01234567"\n[admin]\nunknown = 1')).success).toBe(false);
    expect(showSchema.safeParse(parseToml('schema_version = 1\nid = "s-01234567"\npublish = "true"')).success).toBe(false);
    expect(showSchema.safeParse(parseToml('schema_version = 1\nid = "s-01234567"\ncategories = [{name="Music", extra=1}]')).success).toBe(false);
  });

  test("retains TOML local and offset datetimes and rejects invalid types", () => {
    for (const date of ["2026-11-08T12:00:00", "2026-11-08T12:00:00+09:00"]) {
      const source = `schema_version = 1\nid = "e-01234567"\nshow_id = "s-01234567"\npublished_at = ${date}\n`;
      const first = episodeSchema.parse(parseToml(source));
      const second = episodeSchema.parse(parseToml(stringifyToml(first)));
      expect(String(second.published_at)).toBe(String(first.published_at));
    }
    expect(() => parseToml("t = 2026-02-30T12:00:00")).toThrow();
    expect(episodeSchema.safeParse({ schema_version: 1, id: "e-01234567", show_id: "s-01234567", published_at: Temporal.PlainDate.from("2026-01-01") }).success).toBe(false);
    expect(episodeSchema.safeParse({ schema_version: 1, id: "e-01234567", show_id: "s-01234567", episode_number: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  test("generates short IDs and independent GUIDs", () => {
    expect(newId("show")).toMatch(/^s-[0-9abcdefghjkmnpqrstvwxyz]{8}$/);
    expect(newId("episode")).toMatch(/^e-[0-9abcdefghjkmnpqrstvwxyz]{8}$/);
    expect(newGuid()).toMatch(/^urn:uuid:/);
  });
});
