import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { promptSecret, readConfig, readSecrets, setConfigValue, setSecret } from "../src/config";
import { initWorkspace } from "../src/workspace";

test("workspace configuration excludes credentials; credentials use a separate protected file", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-config-"));
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", "https://example.test");
    await setConfigValue(root, "account_id", "a".repeat(32));
    await setConfigValue(root, "management_bucket", "test-bucket");
    await expect(setConfigValue(root, "admin_token", "not-allowed")).rejects.toThrow();
    await expect(setConfigValue(root, "management_url", "http://example.test")).rejects.toThrow();
    const directory = join(root, "user-config", "castloop");
    await setSecret(directory, "admin_token", "private-token");
    await setSecret(directory, "r2_access_key_id", "test-id");
    expect((await readSecrets(directory, {})).admin_token).toBe("private-token");
    expect((await readSecrets(directory, { CASTLOOP_ADMIN_TOKEN: "override" })).admin_token).toBe("override");
    expect((await readConfig(root)).management_bucket).toBe("test-bucket");
    expect(await readFile(join(root, ".castloop", "config.toml"), "utf8")).not.toContain("private-token");
    if (process.platform !== "win32") expect((await stat(join(directory, "credentials.toml"))).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("secret prompt never echoes input and restores terminal mode on completion or cancellation", async () => {
  function terminal() {
    const input = new PassThrough(), output = new PassThrough();
    const modes: boolean[] = [], shown: string[] = [];
    Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value: boolean) { modes.push(value); return this; } });
    Object.assign(output, { isTTY: true });
    output.on("data", chunk => shown.push(chunk.toString()));
    return { input, output, modes, shown, read: input as unknown as NodeJS.ReadStream, write: output as unknown as NodeJS.WriteStream };
  }
  const success = terminal();
  const answer = promptSecret("token", success.read, success.write);
  success.input.write(Buffer.from("secretX\x7f!\r"));
  expect(await answer).toBe("secret!");
  expect(success.shown.join("")).toBe("token: \n");
  expect(success.modes).toEqual([true, false]);

  for (const sequence of [Buffer.from([4]), Buffer.from([27, 91, 65])]) {
    const cancelled = terminal();
    const pending = promptSecret("token", cancelled.read, cancelled.write);
    cancelled.input.write(sequence);
    await expect(pending).rejects.toThrow("Cancelled");
    expect(cancelled.modes).toEqual([true, false]);
  }
  const ended = terminal();
  const pending = promptSecret("token", ended.read, ended.write);
  ended.input.end();
  await expect(pending).rejects.toThrow("Terminal input ended");
  expect(ended.modes).toEqual([true, false]);
  const broken = terminal();
  Object.assign(broken.input, { setRawMode(value: boolean) { if (!value) throw new Error("Terminal closed"); return this; } });
  const failedRestore = promptSecret("token", broken.read, broken.write);
  broken.input.write(Buffer.from("secret\r"));
  await expect(failedRestore).rejects.toThrow("Terminal closed");
});
