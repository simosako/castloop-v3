import { z } from "zod";
import { episodeIdPattern, showIdPattern } from "./identity";
import { Temporal } from "./toml";

const showId = z.string().regex(showIdPattern);
const episodeId = z.string().regex(episodeIdPattern);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().optional();
const category = z.strictObject({ name: z.string(), subcategory: text });
const admin = z.strictObject({ name: text, email: text });
const dateTime = z.custom<Temporal.PlainDateTime | Temporal.ZonedDateTime>(
  value => value instanceof Temporal.PlainDateTime || value instanceof Temporal.ZonedDateTime,
  "Expected a TOML local or offset datetime",
);

export const showSchema = z.strictObject({
  schema_version: z.literal(1), id: showId, publish: z.boolean().optional(),
  title: text, description: text, website: text, language: text, author: text,
  artwork: text, categories: z.array(category).optional(), explicit: z.boolean().optional(),
  timezone: text, type: z.enum(["episodic", "serial"]).optional(), copyright: text,
  complete: z.boolean().optional(), apple_verification: text, admin: admin.optional(),
});

export const episodeSchema = z.strictObject({
  schema_version: z.literal(1), id: episodeId, show_id: showId,
  publish: z.boolean().optional(), title: text, description: text,
  published_at: dateTime.optional(), timezone: text, website: text,
  explicit: z.boolean().optional(), episode_number: positiveInteger.optional(),
  season_number: positiveInteger.optional(), episode_type: z.enum(["full", "bonus", "trailer"]).optional(),
});

export type Show = z.infer<typeof showSchema>;
export type Episode = z.infer<typeof episodeSchema>;
