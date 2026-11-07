import { Temporal } from "./toml";

/** Resolve a local wall time strictly, or check the supplied offset against the zone. */
export function resolvePublicationTime(value: Temporal.PlainDateTime | Temporal.ZonedDateTime, timezone: string): number {
  const local = value instanceof Temporal.ZonedDateTime ? value.toPlainDateTime() : value;
  const fields = { timeZone: timezone, year: local.year, month: local.month, day: local.day,
    hour: local.hour, minute: local.minute, second: local.second, millisecond: local.millisecond,
    microsecond: local.microsecond, nanosecond: local.nanosecond };
  let zoned: Temporal.ZonedDateTime;
  if (value instanceof Temporal.ZonedDateTime) {
    zoned = Temporal.ZonedDateTime.from({ ...fields, offset: value.offset }, { offset: "reject" });
  } else {
    try { zoned = Temporal.ZonedDateTime.from(fields, { disambiguation: "reject" }); }
    catch (error) {
      try {
        const earlier = Temporal.ZonedDateTime.from(fields, { disambiguation: "earlier" });
        const later = Temporal.ZonedDateTime.from(fields, { disambiguation: "later" });
        if (earlier.toPlainDateTime().equals(local) && later.toPlainDateTime().equals(local) && earlier.offset !== later.offset) {
          throw new Error(`Ambiguous local datetime; specify offset ${earlier.offset} or ${later.offset}`);
        }
      } catch (detail) {
        if (detail instanceof Error && detail.message.startsWith("Ambiguous local datetime;")) throw detail;
      }
      throw error;
    }
  }
  return zoned.epochMilliseconds;
}
