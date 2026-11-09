import { XMLParser, XMLValidator } from "fast-xml-parser";

/** Inspect item identity and enclosure together; never execute XML entities. */
export function inspectFeedEpisode(xml: string, guid: string, audioUrl?: string): boolean {
  if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid RSS XML");
  const document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, processEntities: true }).parse(xml) as {
    rss?: { channel?: { item?: unknown } };
  };
  const raw = document.rss?.channel?.item;
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return items.some(rawItem => {
    if (!rawItem || typeof rawItem !== "object") return false;
    const item = rawItem as { guid?: unknown; enclosure?: unknown };
    const identifier = typeof item.guid === "string" ? item.guid : item.guid && typeof item.guid === "object" ? (item.guid as { "#text"?: unknown })["#text"] : undefined;
    if (identifier !== guid) return false;
    if (audioUrl === undefined) return true;
    return !!item.enclosure && typeof item.enclosure === "object" && (item.enclosure as { "@_url"?: unknown })["@_url"] === audioUrl;
  });
}
