const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
export const showIdPattern = /^s-[0-9abcdefghjkmnpqrstvwxyz]{8}$/;
export const episodeIdPattern = /^e-[0-9abcdefghjkmnpqrstvwxyz]{8}$/;

/** 40 random bits; the server must still reject collisions. */
export function newId(kind: "show" | "episode"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${kind === "show" ? "s" : "e"}-${Array.from(bytes, b => alphabet[b & 31]).join("")}`;
}

export function newGuid(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}
