import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("standalone binary creates drafts and never overwrites a workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-command-"));
  const binary = resolve(import.meta.dir, "../../../dist/castloop");
  async function run(...args: string[]) {
    const process = Bun.spawn([binary, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return { code, output, error };
  }
  try {
    expect((await run("init")).code).toBe(0);
    const show = await run("show", "new");
    expect(show.code).toBe(0);
    const showId = show.output.match(/s-[0-9abcdefghjkmnpqrstvwxyz]{8}/)?.[0];
    expect(showId).toBeDefined();
    const episode = await run("episode", "new", showId!);
    expect(episode.code).toBe(0);
    expect(episode.output).toContain("episode.toml");
    const before = await readFile(join(root, ".castloop/config.toml"), "utf8");
    expect((await run("init")).code).not.toBe(0);
    expect(await readFile(join(root, ".castloop/config.toml"), "utf8")).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
