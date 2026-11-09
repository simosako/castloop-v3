import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseToml, stringifyToml } from "@castloop/domain";
import { UsageError } from "./errors";

const configKeys = ["management_url", "account_id", "management_bucket", "delivery_bucket", "r2_endpoint"] as const;
const secretKeys = ["admin_token", "r2_access_key_id", "r2_secret_access_key"] as const;
export type ConfigKey = typeof configKeys[number];
export type SecretKey = typeof secretKeys[number];
type Config = Partial<Record<ConfigKey, string>>;
type Secrets = Partial<Record<SecretKey, string>>;

function parseStringTable<K extends string>(text: string, keys: readonly K[]): Partial<Record<K, string>> {
  const object = parseToml(text);
  for (const [key, value] of Object.entries(object)) {
    if (!keys.includes(key as K) || typeof value !== "string") throw new Error(`Invalid configuration field: ${key}`);
  }
  return object as Partial<Record<K, string>>;
}
function validateConfigValue(key: ConfigKey, value: string): void {
  if (!value) throw new Error(`${key} cannot be empty`);
  if (key === "account_id" && !/^[a-f0-9]{32}$/.test(value)) throw new Error("account_id must be 32 lowercase hexadecimal characters");
  if ((key === "management_bucket" || key === "delivery_bucket") && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) throw new Error("Invalid R2 bucket name");
  if (key === "management_url" || key === "r2_endpoint") {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${key} must be an origin URL`); }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error(`${key} must be an HTTPS origin or local HTTP origin`);
  }
}
async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
export async function readConfig(root: string): Promise<Config> {
  const values = parseStringTable(await readFile(join(root, ".castloop", "config.toml"), "utf8"), configKeys);
  for (const key of configKeys) if (values[key] !== undefined) validateConfigValue(key, values[key]!);
  return values;
}
export async function setConfigValue(root: string, key: string, value: string): Promise<void> {
  if (!configKeys.includes(key as ConfigKey)) throw new UsageError(`Unknown configuration key: ${key}`);
  try { validateConfigValue(key as ConfigKey, value); }
  catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  const values = await readConfig(root);
  values[key as ConfigKey] = value;
  await atomicWrite(join(root, ".castloop", "config.toml"), stringifyToml(values), 0o600);
}
export function credentialsDirectory(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(environment.XDG_CONFIG_HOME || join(homedir(), ".config"), "castloop");
}
export async function setSecret(directory: string, key: string, value: string): Promise<void> {
  if (!secretKeys.includes(key as SecretKey) || !value || /[\r\n\0]/.test(value)) throw new Error("Invalid credential name or value");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "credentials.toml");
  let values: Secrets = {};
  try { values = parseStringTable(await readFile(path, "utf8"), secretKeys); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  values[key as SecretKey] = value;
  await atomicWrite(path, stringifyToml(values), 0o600);
  if (process.platform !== "win32") await chmod(path, 0o600);
}
export async function readSecrets(directory: string, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<Secrets> {
  let values: Secrets = {};
  try { values = parseStringTable(await readFile(join(directory, "credentials.toml"), "utf8"), secretKeys); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { admin_token: environment.CASTLOOP_ADMIN_TOKEN ?? values.admin_token,
    r2_access_key_id: environment.CASTLOOP_R2_ACCESS_KEY_ID ?? values.r2_access_key_id,
    r2_secret_access_key: environment.CASTLOOP_R2_SECRET_ACCESS_KEY ?? values.r2_secret_access_key };
}

/** Read one secret without echo; noninteractive users can use environment overrides. */
export async function promptSecret(label: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new Error("A terminal is required; use environment variables for noninteractive use");
  const wasRaw = input.isRaw;
  output.write(`${label}: `);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      try { input.setRawMode(wasRaw); }
      catch (restoreError) { error ??= restoreError instanceof Error ? restoreError : new Error("Could not restore terminal mode"); }
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onEnd = () => finish(new Error("Terminal input ended before the credential was entered"));
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3 || byte === 4 || byte === 27) { finish(new Error("Cancelled")); return; }
        if (byte === 13 || byte === 10) { finish(); return; }
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}
