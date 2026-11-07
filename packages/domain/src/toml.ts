import { Temporal } from "@js-temporal/polyfill";
import { parse, stringify } from "smol-toml";

// The parser and validation must use the same constructors across Bun and Workers.
Object.defineProperty(globalThis, "Temporal", { value: Temporal, configurable: true, writable: true });

export function parseToml(source: string): Record<string, unknown> {
  return parse(source, { useLegacyDate: false }) as Record<string, unknown>;
}

export function stringifyToml(value: Record<string, unknown>): string {
  return stringify(value, { strictTemporal: true });
}

export { Temporal };
