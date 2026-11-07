import { expect, test } from "bun:test";
import { parseToml, resolvePublicationTime, Temporal } from "../src";

function date(value: string): Temporal.PlainDateTime | Temporal.ZonedDateTime {
  return parseToml(`date = ${value}`).date as Temporal.PlainDateTime | Temporal.ZonedDateTime;
}

test("resolves local times and checks explicit offsets in every zone", () => {
  expect(resolvePublicationTime(date("2026-01-10T12:00:00"), "Asia/Tokyo"))
    .toBe(resolvePublicationTime(date("2026-01-10T12:00:00+09:00"), "Asia/Tokyo"));
  expect(() => resolvePublicationTime(date("2026-01-10T12:00:00Z"), "Asia/Tokyo")).toThrow();
});

test("rejects New York gaps and ambiguous local times; offsets select overlap", () => {
  expect(() => resolvePublicationTime(date("2026-03-08T02:30:00"), "America/New_York")).toThrow();
  expect(() => resolvePublicationTime(date("2026-11-01T01:30:00"), "America/New_York")).toThrow("specify offset -04:00 or -05:00");
  const first = resolvePublicationTime(date("2026-11-01T01:30:00-04:00"), "America/New_York");
  const second = resolvePublicationTime(date("2026-11-01T01:30:00-05:00"), "America/New_York");
  expect(second - first).toBe(3_600_000);
  expect(() => resolvePublicationTime(date("2026-11-01T01:30:00-06:00"), "America/New_York")).toThrow();
});
