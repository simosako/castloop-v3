import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initWorkspace, newEpisode, newShow, savePendingOperation } from "../src/workspace";
import { setConfigValue } from "../src/config";
import { recordAcceptedOperation } from "../src/metadata";
import type { Operation } from "@castloop/domain";
import { PNG } from "pngjs";

test("command syntax and invalid IDs use usage exit codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-usage-"));
  const binary = resolve(import.meta.dir, "../../../dist/castloop");
  async function run(...args: string[]) {
    const child = Bun.spawn([binary, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config") } });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output, error };
  }
  try {
    expect((await run("--help")).code).toBe(0);
    expect((await run("--version")).code).toBe(0);
    const missing = await run("episode", "new");
    expect(missing.code).toBe(2);
    expect(missing.error.match(/missing required argument/g)).toHaveLength(1);
    expect((await run("no-such-command")).code).toBe(2);
    expect((await run("init")).code).toBe(0);
    expect((await run("config", "set", "account_id", "invalid")).code).toBe(2);
    expect((await run("episode", "new", "bad")).code).toBe(2);
    expect((await run("cleanup", "--older-than", "invalid")).code).toBe(2);
    for (const args of [["pull", "--show", "bad"], ["push", "--show", "bad"], ["check", "--show", "bad"], ["inventory", "--show", "bad"], ["export", "out.json", "--show", "bad"], ["restore-resume", "bad"], ["recover", "bad"], ["episode", "delete", "bad", "bad", "--yes"], ["operation", "retry", "bad"]]) {
      const result = await run(...args, "--json");
      expect({ code: result.code, reported: JSON.parse(result.output).exit_code }).toEqual({ code: 2, reported: 2 });
    }
    for (const args of [["pull", "--show", ""], ["push", "--show", ""], ["check", "--show", ""], ["inventory", "--show", ""], ["export", "out.json", "--show", ""], ["cleanup", "--show", "", "--older-than", "1", "--apply", "--yes"]]) {
      const result = await run(...args, "--json");
      expect({ code: result.code, reported: JSON.parse(result.output).exit_code }).toEqual({ code: 2, reported: 2 });
    }
    const invalidMedia = join(root, "invalid.mp3");
    await writeFile(invalidMedia, "not an mp3");
    const media = await run("episode", "upload-audio", "s-01234567", "e-01234567", invalidMedia, "--json");
    expect({ code: media.code, reported: JSON.parse(media.output).exit_code }).toEqual({ code: 2, reported: 2 });
    const truncated = join(root, "truncated.mp3");
    await writeFile(truncated, (await readFile(join(import.meta.dir, "fixture.mp3"))).subarray(0, 800));
    const shortAudio = await run("episode", "upload-audio", "s-01234567", "e-01234567", truncated, "--json");
    expect({ code: shortAudio.code, body: JSON.parse(shortAudio.output) }).toMatchObject({ code: 2, body: { acceptance: "not_submitted", error: { message: expect.stringContaining("MP3 is truncated") } } });
    const absent = await run("episode", "upload-audio", "s-01234567", "e-01234567", join(root, "missing.mp3"), "--json");
    expect({ code: absent.code, reported: JSON.parse(absent.output).exit_code }).toEqual({ code: 1, reported: 1 });
    const snapshot = join(root, "invalid.json");
    await writeFile(snapshot, "{");
    const restore = await run("restore", snapshot, "--yes", "--json");
    expect({ code: restore.code, reported: JSON.parse(restore.output).exit_code }).toEqual({ code: 2, reported: 2 });
    expect((await run("check", "--show", "s-01234567")).code).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

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

test("push rejects any malformed TOML before uploading or normalizing another Show", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-push-preflight-"));
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response(null, { status: 500 }); } });
  try {
    await initWorkspace(root);
    const first = await newShow(root), second = await newShow(root);
    const episode = await newEpisode(root, second), file = join(root, second, episode, "episode.toml");
    const firstShow = join(root, first, "show.toml"), initial = await readFile(firstShow, "utf8");
    for (const [key, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, key!, value!);
    for (const body of [`schema_version = 1\nid = "${episode}"\nshow_id = "${second}"\ntitle = [\n`,
      `schema_version = 1\nid = "${episode}"\nshow_id = "${second}"\npublish = "true"\n`]) {
      await writeFile(file, body);
      const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "push"], { cwd: root, stdout: "pipe", stderr: "pipe",
        env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(2);
      expect(error).toContain("episode.toml");
      expect(requests).toBe(0);
      expect(await readFile(file, "utf8")).toBe(body);
      expect(await readFile(firstShow, "utf8")).toBe(initial);
    }
    const json = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "push", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
    const [jsonCode, jsonOut, jsonErr] = await Promise.all([json.exited, new Response(json.stdout).text(), new Response(json.stderr).text()]);
    expect(jsonCode).toBe(2);
    expect(jsonErr).toBe("");
    expect(JSON.parse(jsonOut)).toMatchObject({ version: 1, shows: [], exit_code: 2, error: { message: expect.stringContaining("episode.toml") } });
    expect(requests).toBe(0);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("standalone push retains and replays the exact intent after an uncertain response", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-push-command-"));
  let stored: Uint8Array<ArrayBuffer> | undefined;
  let sha = "";
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/operations")) {
      const operation = await request.json() as { operation_id: string; expected_revision: number };
      requests.push(operation);
      if (requests.length <= 2) return Response.json({ error: "uncertain" }, { status: 503 });
      return Response.json({ protocol_version: 1, operation_id: operation.operation_id, accepted_revision: operation.expected_revision + 1, acceptance: "already_accepted", validation_issues: [], delivery: "failed" });
    }
    if (request.method === "PUT") {
      if (stored || request.headers.get("if-none-match") !== "*") return new Response(null, { status: 412 });
      stored = new Uint8Array(await request.arrayBuffer());
      sha = request.headers.get("x-amz-meta-sha256") ?? "";
      return new Response(null, { headers: { etag: '"etag"' } });
    }
    if (request.method === "HEAD" && stored) return new Response(null, { headers: { etag: '"etag"', "content-length": String(stored.length), "x-amz-meta-sha256": sha } });
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    const showId = await newShow(root);
    await setConfigValue(root, "management_url", server.url.origin);
    await setConfigValue(root, "r2_endpoint", server.url.origin);
    await setConfigValue(root, "account_id", "a".repeat(32));
    await setConfigValue(root, "management_bucket", "test-bucket");
    const binary = resolve(import.meta.dir, "../../../dist/castloop");
    const environment = { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" };
    async function run(...args: string[]) {
      const process = Bun.spawn([binary, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: environment });
      const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return { code, output, error };
    }
    const first = await run("push", "--show", showId, "--json");
    expect(first.code).toBe(1);
    expect(first.error).toBe("");
    const [receipt] = await readdir(join(root, ".castloop", "pending"));
    expect(receipt).toMatch(/\.json$/);
    const id = receipt!.slice(0, -5);
    expect(JSON.parse(first.output)).toMatchObject({ version: 1, exit_code: 1, shows: [{ show_id: showId, operation_id: id, acceptance: "unknown", receipt_retained: true }] });
    const repeatedPush = await run("push", "--show", showId, "--json");
    expect(repeatedPush.code).toBe(1);
    expect(JSON.parse(repeatedPush.output).error.message).toContain(`operation retry ${id}`);
    expect(requests).toHaveLength(1);
    const uncertain = await run("operation", "retry", id, "--json");
    expect(uncertain.code).toBe(1);
    expect(uncertain.error).toBe("");
    expect(JSON.parse(uncertain.output)).toMatchObject({ version: 1, show_id: showId, operation_id: id, acceptance: "unknown", exit_code: 1 });
    const retry = await run("operation", "retry", id, "--json");
    expect(retry.code).toBe(1);
    expect(retry.error).toBe("");
    expect(JSON.parse(retry.output)).toMatchObject({ version: 1, show_id: showId, result: { operation_id: id, accepted_revision: 1,
      acceptance: "already_accepted", validation_issues: [], delivery: "failed" }, exit_code: 1 });
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toEqual(requests[0]);
    expect((await readdir(join(root, ".castloop", "pending"))).length).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".castloop", "state.json"), "utf8")).shows[showId].revision).toBe(1);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("abandoning an uncertain operation requires confirmation and retains its local record", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-abandon-command-"));
  try {
    await initWorkspace(root);
    const showId = await newShow(root), operationId = "12345678-1234-4234-8234-123456789abc";
    await savePendingOperation(root, showId, { protocol_version: 1, operation_id: operationId, expected_revision: 0, action: "show.delete", payload: { confirmed: true } });
    async function run(...args: string[]) {
      const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "operation", "abandon", operationId, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return { code, body: JSON.parse(output) };
    }
    expect(await run("--json")).toMatchObject({ code: 4, body: { abandoned: false } });
    expect(await readFile(join(root, ".castloop", "pending", `${operationId}.json`))).toBeDefined();
    expect(await run("--json", "--yes")).toMatchObject({ code: 0, body: { operation_id: operationId, show_id: showId, abandoned: true } });
    expect(JSON.parse(await readFile(join(root, ".castloop", "abandoned", `${operationId}.json`), "utf8"))).toMatchObject({ show_id: showId, operation: { operation_id: operationId } });
    await expect(readFile(join(root, ".castloop", "pending", `${operationId}.json`))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retry reports accepted but pending withdrawal as incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-retry-pending-"));
  const showId = "s-01234567", operationId = "12345678-1234-4234-8234-123456789abc";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const operation = await request.json() as { operation_id: string };
    return Response.json({ protocol_version: 1, operation_id: operation.operation_id, accepted_revision: 2, acceptance: "already_accepted", validation_issues: [], delivery: "pending" });
  } });
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", server.url.origin);
    await savePendingOperation(root, showId, { protocol_version: 1, operation_id: operationId, expected_revision: 1, action: "show.delete", payload: { confirmed: true } });
    const process = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "operation", "retry", operationId, "--json"], {
      cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" },
    });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect({ code, error }).toEqual({ code: 1, error: "" });
    expect(JSON.parse(output)).toMatchObject({ show_id: showId, result: { acceptance: "already_accepted", delivery: "pending" }, exit_code: 1 });
    expect(await readdir(join(root, ".castloop", "pending"))).toEqual([]);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("preserves a known rejection when removing its local receipt fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-rejected-receipt-"));
  const pending = join(root, ".castloop", "pending"), objects = new Map<string, { size: number; digest: string }>();
  let blockRemoval = true;
  let targetId = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/snapshot")) return Response.json({ protocol_version: 1, show_id: targetId, revision: 1, show: { metadata: { key: "key", etag: '"etag"', size: 1, sha256: "a".repeat(64) }, deleted: false }, episodes: [], next_cursor: null });
    if (url.pathname.endsWith("/operations")) {
      const operation = await request.json() as { operation_id: string };
      if (blockRemoval) await chmod(pending, 0o500);
      return Response.json({ protocol_version: 1, operation_id: operation.operation_id, acceptance: "rejected", issues: [{ code: "revision_conflict", path: "revision", message: "Stale revision", severity: "error" }] }, { status: 409 });
    }
    if (request.method === "PUT") { const bytes = await request.arrayBuffer(); objects.set(url.pathname, { size: bytes.byteLength, digest: request.headers.get("x-amz-meta-sha256") ?? "" }); return new Response(null, { headers: { etag: '"etag"' } }); }
    const object = objects.get(url.pathname);
    if (request.method === "HEAD" && object) return new Response(null, { headers: { etag: '"etag"', "content-length": String(object.size), "x-amz-meta-sha256": object.digest } });
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    const showId = await newShow(root); targetId = showId;
    for (const [key, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, key!, value!);
    async function run(...args: string[]) {
      const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "push", "--show", showId, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output, error };
    }
    const failed = await run("--json");
    expect({ code: failed.code, error: failed.error, body: JSON.parse(failed.output) }).toMatchObject({ code: 1, error: "", body: { shows: [{ acceptance: "rejected", receipt_retained: true, error: { code: "revision_conflict", status: 409, message: expect.stringContaining("could not remove its local receipt") } }] } });
    await chmod(pending, 0o700);
    expect((await readdir(pending)).filter(file => file.endsWith(".json"))).toHaveLength(1);
    blockRemoval = false;
    const rejected = await run("--json");
    expect({ code: rejected.code, error: rejected.error, body: JSON.parse(rejected.output) }).toMatchObject({ code: 1, error: "", body: { error: { message: expect.stringContaining("unresolved operation") } } });
    const [receipt] = (await readdir(pending)).filter(file => file.endsWith(".json"));
    const retryChild = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "operation", "retry", receipt!.slice(0, -5), "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
    const [retryCode, retryOutput, retryError] = await Promise.all([retryChild.exited, new Response(retryChild.stdout).text(), new Response(retryChild.stderr).text()]);
    expect({ code: retryCode, error: retryError, body: JSON.parse(retryOutput) }).toMatchObject({ code: 3, error: "", body: { acceptance: "rejected", receipt_retained: false, error: { code: "revision_conflict", status: 409 } } });
    expect((await readdir(pending)).filter(file => file.endsWith(".json"))).toHaveLength(0);
    blockRemoval = true;
    const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "show", "delete", showId, "--yes", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, error, body: JSON.parse(output) }).toMatchObject({ code: 1, error: "", body: { acceptance: "rejected", receipt_retained: true, error: { code: "revision_conflict", status: 409 } } });
  } finally { await chmod(pending, 0o700).catch(() => {}); server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("reports accepted metadata when a subsequent local baseline update fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-accepted-local-failure-"));
  const statePath = join(root, ".castloop", "state.json");
  let stored: Uint8Array<ArrayBuffer> | undefined, digest = "", requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/operations")) {
      const operation = await request.json() as { operation_id: string; expected_revision: number };
      requests++;
      if (requests === 1) await writeFile(statePath, "invalid local state");
      return Response.json({ protocol_version: 1, operation_id: operation.operation_id, accepted_revision: operation.expected_revision + 1, acceptance: requests === 1 ? "accepted" : "already_accepted", validation_issues: [{ code: "publication_invalid", path: "show.title", message: "Required for publication", severity: "error" }], delivery: "applied" });
    }
    if (request.method === "PUT") { stored = new Uint8Array(await request.arrayBuffer()); digest = request.headers.get("x-amz-meta-sha256") ?? ""; return new Response(null, { headers: { etag: '"etag"' } }); }
    if (request.method === "HEAD" && stored) return new Response(null, { headers: { etag: '"etag"', "content-length": String(stored.length), "x-amz-meta-sha256": digest } });
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    const showId = await newShow(root), originalState = await readFile(statePath, "utf8");
    for (const [key, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, key!, value!);
    async function run(...args: string[]) {
      const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output, error };
    }
    const first = await run("push", "--show", showId);
    expect(first.code).toBe(1);
    const [receipt] = await readdir(join(root, ".castloop", "pending"));
    const id = receipt!.slice(0, -5);
    expect(first.error).toContain(`Operation ${id} was accepted at revision 1; delivery: applied`);
    expect(first.error).toContain("show.title: Required for publication");
    expect(first.error).toContain(`castloop operation retry ${id}`);
    const retryFailure = await run("operation", "retry", id);
    expect(retryFailure.code).toBe(1);
    expect(retryFailure.error).toContain(`Operation ${id} was accepted at revision 1; delivery: applied`);
    expect(retryFailure.error).toContain(`castloop operation retry ${id}`);
    const retryJson = await run("operation", "retry", id, "--json");
    expect({ code: retryJson.code, body: JSON.parse(retryJson.output) }).toMatchObject({ code: 1, body: { acceptance: "already_accepted", receipt_retained: true, result: { accepted_revision: 1, delivery: "applied" } } });
    await writeFile(statePath, originalState);
    const retry = await run("operation", "retry", id, "--json");
    expect({ code: retry.code, body: JSON.parse(retry.output) }).toMatchObject({ code: 2, body: { result: { acceptance: "already_accepted", accepted_revision: 1 }, baseline_updated: true } });
    expect((await readdir(join(root, ".castloop", "pending"))).length).toBe(0);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("standalone pull connects to local management and S3 endpoints without downloading media", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-pull-command-"));
  const showId = "s-01234567";
  const source = `schema_version = 1\nid = "${showId}"\npublish = false\n`;
  const sha256 = createHash("sha256").update(source).digest("hex");
  const key = `${showId}/_versions/12345678-1234-4234-8234-123456789abc/show.toml`;
  let s3Requests = 0;
  let snapshotFailure = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `/v1/shows/${showId}/snapshot`) {
      if (request.headers.get("authorization") !== "Bearer admin-test") return new Response(null, { status: 401 });
      if (snapshotFailure) return Response.json({ message: "Show changed during pull" }, { status: 409 });
      return Response.json({ protocol_version: 1, show_id: showId, revision: 1,
        show: { metadata: { key, etag: '"etag"', size: Buffer.byteLength(source), sha256 }, deleted: false }, episodes: [], next_cursor: null });
    }
    if (url.pathname === `/test-bucket/${key}`) {
      s3Requests++;
      if (request.headers.get("if-match") !== '"etag"') return new Response(null, { status: 412 });
      return new Response(source, { headers: { etag: '"etag"', "content-length": String(Buffer.byteLength(source)) } });
    }
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", server.url.origin);
    await setConfigValue(root, "r2_endpoint", server.url.origin);
    await setConfigValue(root, "account_id", "a".repeat(32));
    await setConfigValue(root, "management_bucket", "test-bucket");
    const process = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "pull", "--show", showId], {
      cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" },
    });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(output).toContain(`Pulled ${showId}`);
    expect(await readFile(join(root, showId, "show.toml"), "utf8")).toBe(source);
    expect(s3Requests).toBe(1);
    async function runJson() {
      const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "pull", "--show", showId, "--json"], {
        cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" },
      });
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, result: JSON.parse(output), error };
    }
    expect(await runJson()).toEqual({ code: 0, error: "", result: { version: 1, shows: [{ show_id: showId, revision: 1, backups: [], tombstones: [] }], exit_code: 0 } });
    snapshotFailure = true;
    const failed = await runJson();
    expect(failed).toMatchObject({ code: 1, error: "", result: { version: 1, shows: [{ show_id: showId, error: { message: expect.any(String) } }], exit_code: 1 } });
    expect(await readFile(join(root, showId, "show.toml"), "utf8")).toBe(source);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("standalone push normalizes a new episode and sends a single metadata batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-episode-push-"));
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; sha256: string }>();
  let accepted: { payload: { episodes: { episode_id: string; guid: string; metadata: { key: string } }[] } } | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/operations")) {
      const operation = await request.json() as { operation_id: string; expected_revision: number; payload: { episodes: { episode_id: string; guid: string; metadata: { key: string } }[] } };
      accepted = operation;
      return Response.json({ protocol_version: 1, operation_id: operation.operation_id, accepted_revision: operation.expected_revision + 1, acceptance: "accepted", validation_issues: [], delivery: "pending" });
    }
    if (request.method === "PUT") {
      if (objects.has(url.pathname)) return new Response(null, { status: 412 });
      objects.set(url.pathname, { bytes: new Uint8Array(await request.arrayBuffer()), sha256: request.headers.get("x-amz-meta-sha256") ?? "" });
      return new Response(null, { headers: { etag: '"etag"' } });
    }
    const object = objects.get(url.pathname);
    if (request.method === "HEAD" && object) return new Response(null, { headers: { etag: '"etag"', "content-length": String(object.bytes.length), "x-amz-meta-sha256": object.sha256 } });
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    const showId = await newShow(root);
    const showBody = await readFile(join(root, showId, "show.toml"));
    const ref = { key: `${showId}/_versions/example/show.toml`, etag: '"etag"', size: showBody.length, sha256: createHash("sha256").update(showBody).digest("hex") };
    const showOp: Operation = { protocol_version: 1, operation_id: "12345678-1234-4234-8234-123456789abc", expected_revision: 0, action: "metadata.batch", payload: { show: { mode: "create", metadata: ref }, episodes: [] } };
    await recordAcceptedOperation(root, showId, showOp, 1);
    const episodeId = await newEpisode(root, showId);
    const episodePath = join(root, showId, episodeId, "episode.toml");
    const original = await readFile(episodePath, "utf8");
    for (const [key, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, key!, value!);
    const process = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "push", "--show", showId, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
    const [code, error, output] = await Promise.all([process.exited, new Response(process.stderr).text(), new Response(process.stdout).text()]);
    expect({ code, error }).toEqual({ code: 1, error: "" });
    expect(JSON.parse(output)).toMatchObject({ version: 1, exit_code: 1, shows: [{ show_id: showId, result: { acceptance: "accepted", accepted_revision: 2, delivery: "pending" } }],
      normalizations: [{ path: episodePath, timezone: "Asia/Tokyo", backup: `${episodePath}.bak` }] });
    expect(accepted?.payload.episodes).toHaveLength(1);
    expect(accepted?.payload.episodes[0]?.episode_id).toBe(episodeId);
    expect(accepted?.payload.episodes[0]?.guid).toMatch(/^urn:uuid:/);
    expect(await readFile(`${episodePath}.bak`, "utf8")).toBe(original);
    expect(await readFile(episodePath, "utf8")).toContain('timezone = "Asia/Tokyo"');
    const entry = [...objects.entries()][0]!;
    expect(new TextDecoder().decode(entry[1].bytes)).toContain('timezone = "Asia/Tokyo"');
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("push regenerates only a confirmed new Episode collision and preserves local files", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-episode-collision-"));
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; sha256: string }>();
  const sent: { operation_id: string; expected_revision: number; payload: { episodes: { episode_id: string; guid: string }[] } }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/operations")) {
      const operation = await request.json() as typeof sent[number]; sent.push(operation);
      if (sent.length === 1) return Response.json({ protocol_version: 1, operation_id: operation.operation_id, acceptance: "rejected", issues: [{ code: "identity_conflict", path: `episodes.${operation.payload.episodes[0]!.episode_id}.id`, message: "in use", severity: "error" }] }, { status: 409 });
      return Response.json({ protocol_version: 1, operation_id: operation.operation_id, accepted_revision: operation.expected_revision + 1, acceptance: "accepted", validation_issues: [], delivery: "applied" });
    }
    if (request.method === "PUT") {
      objects.set(url.pathname, { bytes: new Uint8Array(await request.arrayBuffer()), sha256: request.headers.get("x-amz-meta-sha256") ?? "" });
      return new Response(null, { headers: { etag: '"etag"' } });
    }
    const object = objects.get(url.pathname);
    if (request.method === "HEAD" && object) return new Response(null, { headers: { etag: '"etag"', "content-length": String(object.bytes.length), "x-amz-meta-sha256": object.sha256 } });
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    const show = await newShow(root), showBody = await readFile(join(root, show, "show.toml"));
    const ref = { key: `${show}/_versions/example/show.toml`, etag: '"etag"', size: showBody.length, sha256: createHash("sha256").update(showBody).digest("hex") };
    await recordAcceptedOperation(root, show, { protocol_version: 1, operation_id: "12345678-1234-4234-8234-123456789abc", expected_revision: 0, action: "metadata.batch", payload: { show: { mode: "create", metadata: ref }, episodes: [] } }, 1);
    const episode = await newEpisode(root, show);
    await writeFile(join(root, show, episode, "audio.mp3"), "audio retained");
    for (const [key, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, key!, value!);
    const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "push", "--show", show, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.payload.episodes[0]!.episode_id).toBe(episode);
    const next = sent[1]!.payload.episodes[0]!.episode_id;
    expect(next).not.toBe(episode);
    expect(sent[1]!.operation_id).not.toBe(sent[0]!.operation_id);
    expect(JSON.parse(output)).toMatchObject({ id_changes: [{ show_id: show, old_episode_id: episode, new_episode_id: next }], exit_code: 0 });
    expect(await readFile(join(root, show, next, "audio.mp3"), "utf8")).toBe("audio retained");
    expect(await readFile(join(root, show, next, "episode.toml.bak.1"), "utf8")).toContain(episode);
    expect(await readFile(join(root, show, next, "episode.toml"), "utf8")).toContain(next);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("push recovers an interrupted Episode ID change before reading metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-interrupted-id-"));
  try {
    await initWorkspace(root);
    const show = await newShow(root), episode = await newEpisode(root, show), next = "e-01234567";
    const original = await readFile(join(root, show, episode, "episode.toml"));
    const replacement = Buffer.from(original.toString().replace(episode, next));
    await writeFile(join(root, ".castloop", "reidentify.json"), JSON.stringify({ version: 1, kind: "episode", showId: show, oldId: episode, newId: next,
      files: [{ relative: "episode.toml", original: original.toString("base64"), replacement: replacement.toString("base64") }] }));
    await rename(join(root, show, episode), join(root, show, next));
    await writeFile(join(root, show, next, "episode.toml"), replacement);
    const blocked = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "episode", "upload-audio", show, episode, "unused.mp3", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [blockedCode, blockedOutput] = await Promise.all([blocked.exited, new Response(blocked.stdout).text()]);
    expect(blockedCode).toBe(1);
    expect(JSON.parse(blockedOutput).error.message).toContain("operation recover-local");
    expect(await readFile(join(root, show, next, "episode.toml"))).toEqual(replacement);
    const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "push", "--show", show, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config") } });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(1); // No remote credentials are configured.
    expect(JSON.parse(output).error.message).toContain("configured before push");
    expect(await readFile(join(root, show, episode, "episode.toml"))).toEqual(original);
    await expect(readFile(join(root, ".castloop", "reidentify.json"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recover-local restores an interrupted move without contacting a server", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-local-recovery-command-"));
  try {
    await initWorkspace(root);
    const show = await newShow(root), episode = await newEpisode(root, show), next = "e-01234567";
    const original = await readFile(join(root, show, episode, "episode.toml"));
    const replacement = Buffer.from(original.toString().replace(episode, next));
    await writeFile(join(root, ".castloop", "reidentify.json"), JSON.stringify({ version: 1, kind: "episode", showId: show, oldId: episode, newId: next,
      files: [{ relative: "episode.toml", original: original.toString("base64"), replacement: replacement.toString("base64") }] }));
    await rename(join(root, show, episode), join(root, show, next));
    await writeFile(join(root, show, next, "episode.toml"), replacement);
    const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "operation", "recover-local", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ recovered: { oldId: episode, newId: next }, exit_code: 0 });
    expect(await readFile(join(root, show, episode, "episode.toml"))).toEqual(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("push verifies an occupied Show ID and retries with a new ID and updated Episode", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-show-collision-"));
  const objects = new Map<string, { size: number; sha256: string }>();
  const sent: { show: string; operation_id: string; expected_revision: number; payload: { episodes: { episode_id: string }[] } }[] = [];
  let oldShow = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/snapshot")) return Response.json({ protocol_version: 1, show_id: oldShow, revision: 2, show: { metadata: { key: "old", etag: '"etag"', size: 1, sha256: "a".repeat(64) }, deleted: false }, episodes: [], next_cursor: null });
    if (url.pathname.endsWith("/operations")) {
      const operation = await request.json() as Omit<typeof sent[number], "show">;
      sent.push({ ...operation, show: url.pathname.split("/")[3]! });
      if (sent.length === 1) return Response.json({ protocol_version: 1, operation_id: operation.operation_id, acceptance: "rejected", issues: [{ code: "revision_conflict", path: "", message: "changed", severity: "error" }] }, { status: 409 });
      return Response.json({ protocol_version: 1, operation_id: operation.operation_id, accepted_revision: 1, acceptance: "accepted", validation_issues: [], delivery: "applied" });
    }
    if (request.method === "PUT") { const bytes = await request.arrayBuffer(); objects.set(url.pathname, { size: bytes.byteLength, sha256: request.headers.get("x-amz-meta-sha256") ?? "" }); return new Response(null, { headers: { etag: '"etag"' } }); }
    const object = objects.get(url.pathname);
    if (request.method === "HEAD" && object) return new Response(null, { headers: { etag: '"etag"', "content-length": String(object.size), "x-amz-meta-sha256": object.sha256 } });
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    oldShow = await newShow(root);
    const episode = await newEpisode(root, oldShow);
    await writeFile(join(root, oldShow, episode, "local.mp3"), "audio");
    for (const [key, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, key!, value!);
    const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "push", "--show", oldShow, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(sent).toHaveLength(2);
    const next = sent[1]!.show;
    expect(next).not.toBe(oldShow);
    expect(sent[1]!.operation_id).not.toBe(sent[0]!.operation_id);
    expect(JSON.parse(output)).toMatchObject({ show_id_changes: [{ old_show_id: oldShow, new_show_id: next }], exit_code: 0 });
    expect(await readFile(join(root, next, episode, "local.mp3"), "utf8")).toBe("audio");
    expect(await readFile(join(root, next, episode, "episode.toml"), "utf8")).toContain(`show_id = "${next}"`);
    expect(await readFile(join(root, next, "show.toml.bak"), "utf8")).toContain(oldShow);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("deletion requires confirmation and reports pending withdrawal", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-delete-command-"));
  const showId = "s-01234567";
  const episodeId = "e-01234567";
  const ref = { key: "key", etag: '"etag"', size: 5, sha256: "a".repeat(64) };
  let revision = 1;
  let uncertain = false;
  const sent: { operation_id: string; action: string; payload: { confirmed: boolean } }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return Response.json({ protocol_version: 1, show_id: showId, revision, show: { metadata: ref, deleted: false },
      episodes: [{ episode_id: episodeId, metadata: ref, guid: "opaque", deleted: false }], next_cursor: null });
    const operation = await request.json() as { operation_id: string; action: string; payload: { confirmed: boolean } };
    sent.push(operation); revision++;
    if (uncertain) return Response.json({ error: "unknown" }, { status: 503 });
    return Response.json({ protocol_version: 1, operation_id: operation.operation_id, accepted_revision: revision, acceptance: "accepted", validation_issues: [], delivery: "pending" });
  } });
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", server.url.origin);
    const binary = resolve(import.meta.dir, "../../../dist/castloop");
    const environment = { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" };
    async function run(...args: string[]) {
      const process = Bun.spawn([binary, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: environment });
      const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return { code, output, error };
    }
    expect((await run("episode", "delete", showId, episodeId)).code).toBe(4);
    const noConfirmation = await run("episode", "delete", showId, episodeId, "--json");
    expect(noConfirmation.code).toBe(4);
    expect(noConfirmation.error).toBe("");
    expect(JSON.parse(noConfirmation.output)).toMatchObject({ acceptance: "not_submitted", exit_code: 4 });
    expect(sent).toHaveLength(0);
    const result = await run("episode", "delete", showId, episodeId, "--yes", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ show_id: showId, episode_id: episodeId, exit_code: 1, result: { acceptance: "accepted", delivery: "pending", accepted_revision: 2 } });
    expect(sent[0]).toMatchObject({ action: "episode.delete", payload: { episode_id: episodeId, confirmed: true } });
    const showResult = await run("show", "delete", showId, "--yes");
    expect(showResult.code).toBe(1);
    expect(showResult.output).toContain(`castloop recover ${showId}`);
    expect(sent[1]).toMatchObject({ action: "show.delete", payload: { confirmed: true } });
    uncertain = true;
    const lost = await run("show", "delete", showId, "--yes", "--json");
    expect(lost.code).toBe(1);
    expect(lost.error).toBe("");
    expect(JSON.parse(lost.output)).toMatchObject({ show_id: showId, acceptance: "unknown", receipt_retained: true, operation_id: sent[2]!.operation_id });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("standalone cover upload validates and selects the accepted logical filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-cover-command-"));
  const showId = "s-01234567";
  const showBody = `schema_version = 1\nid = "${showId}"\nartwork = "cover.png"\n`;
  const showRef = { key: `${showId}/_versions/12345678-1234-4234-8234-123456789abc/show.toml`, etag: '"show-etag"', size: Buffer.byteLength(showBody), sha256: createHash("sha256").update(showBody).digest("hex") };
  let cover: Uint8Array<ArrayBuffer> | undefined;
  let coverDigest = "";
  let submitted: { operation_id: string; action: string; payload: { logical_name: string; cover: { key: string } } } | undefined;
  let uncertain = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/snapshot")) return Response.json({ protocol_version: 1, show_id: showId, revision: 1, show: { metadata: showRef, deleted: false }, episodes: [], next_cursor: null });
    if (url.pathname.endsWith("/operations")) {
      const operation = await request.json() as { operation_id: string; action: string; payload: { logical_name: string; cover: { key: string } } };
      submitted = operation;
      if (uncertain) return Response.json({ error: "unknown" }, { status: 503 });
      return Response.json({ protocol_version: 1, operation_id: operation.operation_id, accepted_revision: 2, acceptance: "accepted", validation_issues: [], delivery: "pending" });
    }
    if (url.pathname.endsWith("/show.toml")) return new Response(showBody, { headers: { etag: showRef.etag, "content-length": String(showRef.size) } });
    if (request.method === "PUT") {
      cover = new Uint8Array(await request.arrayBuffer());
      coverDigest = request.headers.get("x-amz-meta-sha256") ?? "";
      return new Response(null, { headers: { etag: '"cover-etag"' } });
    }
    if (request.method === "HEAD" && cover) return new Response(null, { headers: { etag: '"cover-etag"', "content-length": String(cover.length), "x-amz-meta-sha256": coverDigest } });
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    const image = new PNG({ width: 1400, height: 1400 });
    image.data.fill(255);
    const path = join(root, "my-image.png");
    await writeFile(path, PNG.sync.write(image, { colorType: 2 }));
    for (const [key, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, key!, value!);
    const process = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "show", "upload-cover", showId, path, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect({ code, error }).toEqual({ code: 1, error: "" });
    expect(JSON.parse(output)).toMatchObject({ version: 1, show_id: showId, exit_code: 1, result: { acceptance: "accepted", accepted_revision: 2, delivery: "pending" } });
    expect(submitted).toMatchObject({ action: "cover.set", payload: { logical_name: "cover.png" } });
    expect(submitted?.payload.cover.key).toMatch(/\/cover\.png$/);
    uncertain = true;
    const retry = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "show", "upload-cover", showId, path, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
    const [retryCode, retryOut, retryErr] = await Promise.all([retry.exited, new Response(retry.stdout).text(), new Response(retry.stderr).text()]);
    expect(retryCode).toBe(1);
    expect(retryErr).toBe("");
    expect(JSON.parse(retryOut)).toMatchObject({ acceptance: "unknown", receipt_retained: true, operation_id: submitted?.operation_id });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("delivery migration and rollback require confirmation and send revision-bound requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-delivery-command-"));
  const showId = "s-01234567";
  let submitted: { action: string; expected_revision: number; payload: { target_base: string; confirmed: boolean }; operation_id: string } | undefined;
  let pending: string | null = null;
  let deliveryResult = "applied";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/check")) return Response.json({ protocol_version: 1, show_id: showId, revision: 4, issues: [], outcomes: [], cleanup_claims: [],
      delivery_base: "https://old.example.com", previous_delivery_base: "https://previous.example.com", pending_delivery_base: pending, delivery_paths: [] });
    if (path.endsWith("/operations")) {
      submitted = await request.json() as typeof submitted;
      return Response.json({ protocol_version: 1, operation_id: submitted!.operation_id, accepted_revision: 5, acceptance: "accepted", validation_issues: [], delivery: deliveryResult });
    }
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", server.url.origin);
    async function run(...args: string[]) {
      const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "delivery", ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
        env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output, error };
    }
    expect((await run("migrate", showId, "--to", "https://new.example.com")).code).toBe(4);
    expect(submitted).toBeUndefined();
    const unconfirmed = await run("migrate", showId, "--to", "https://new.example.com", "--json");
    expect(unconfirmed.code).toBe(4);
    expect(JSON.parse(unconfirmed.output)).toMatchObject({ acceptance: "not_submitted", exit_code: 4 });
    deliveryResult = "pending";
    const migration = await run("migrate", showId, "--to", "https://new.example.com", "--yes", "--json");
    expect(migration.code).toBe(1);
    expect(JSON.parse(migration.output)).toMatchObject({ show_id: showId, result: { acceptance: "accepted", delivery: "pending" }, exit_code: 1 });
    expect(submitted).toMatchObject({ action: "delivery.set", expected_revision: 4, payload: { target_base: "https://new.example.com", confirmed: true } });
    deliveryResult = "applied";
    expect((await run("rollback", showId, "--yes")).code).toBe(0);
    expect(submitted?.payload.target_base).toBe("https://previous.example.com");
    pending = "https://new.example.com";
    expect((await run("rollback", showId, "--yes")).code).toBe(0);
    expect(submitted?.payload.target_base).toBe("https://old.example.com");
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("check displays the publication reason and notification failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-check-notification-"));
  const showId = "s-01234567";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ protocol_version: 1, show_id: showId, revision: 1, issues: [],
      outcomes: [{ target: "feed", state: "failed", error: { code: "delivery_failed", message: "Feed publication did not complete" }, notification: "failed" }],
      cleanup_claims: [], delivery_base: "https://example.test", delivery_paths: [] });
  } });
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", server.url.origin);
    const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "check", "--show", showId], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(output).toContain("notification: failed");
    expect(error).toContain("Feed publication did not complete");
    const jsonChild = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "check", "--show", showId, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
    const [jsonCode, jsonOutput, jsonError] = await Promise.all([jsonChild.exited, new Response(jsonChild.stdout).text(), new Response(jsonChild.stderr).text()]);
    expect(jsonCode).toBe(1);
    expect(jsonError).toBe("");
    expect(JSON.parse(jsonOutput)).toMatchObject({ version: 1, exit_code: 1, checks: [{ show_id: showId, result: { revision: 1,
      outcomes: [{ target: "feed", state: "failed", error: { code: "delivery_failed", message: "Feed publication did not complete" }, notification: "failed" }] } }] });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("standalone audio upload validates show and sends checksum-bound media directly before acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-audio-command-"));
  const showId = "s-01234567", episodeId = "e-01234567";
  const ref = { key: "key", etag: '"etag"', size: 5, sha256: "a".repeat(64) };
  let audio: Uint8Array | undefined;
  let audioSha = "";
  let submitted: { action: string; payload: { episode_id: string; audio: { key: string; sha256: string }; facts: { duration_ms: number } } } | undefined;
  let invalidShow = true;
  let origin = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/snapshot")) return Response.json({ protocol_version: 1, show_id: showId, revision: 1,
      show: { metadata: ref, deleted: false }, episodes: [{ episode_id: episodeId, metadata: ref, guid: "opaque", deleted: false }], next_cursor: null });
    if (url.pathname.endsWith("/check")) return Response.json({ protocol_version: 1, show_id: showId, revision: 1,
      issues: invalidShow ? [{ code: "publication_invalid", path: "show.title", message: "Required", severity: "error" }] : [], outcomes: [], cleanup_claims: [], delivery_base: origin, delivery_paths: [] });
    if (url.pathname.endsWith("/operations")) {
      const operation = await request.json() as typeof submitted & { operation_id: string };
      submitted = operation;
      return Response.json({ protocol_version: 1, operation_id: operation!.operation_id, accepted_revision: 2, acceptance: "accepted", validation_issues: [], delivery: "pending" });
    }
    if (request.method === "PUT") {
      audio = new Uint8Array(await request.arrayBuffer());
      audioSha = request.headers.get("x-amz-meta-sha256") ?? "";
      if (request.headers.get("if-none-match") !== "*" || createHash("sha256").update(audio).digest("base64") !== request.headers.get("x-amz-checksum-sha256")) return new Response(null, { status: 400 });
      return new Response(null, { headers: { etag: '"audio-etag"' } });
    }
    if (request.method === "HEAD" && audio) return new Response(null, { headers: { etag: '"audio-etag"', "content-length": String(audio.length), "x-amz-meta-sha256": audioSha } });
    return new Response(null, { status: 404 });
  } });
  origin = server.url.origin;
  try {
    await initWorkspace(root);
    for (const [key, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, key!, value!);
    const binary = resolve(import.meta.dir, "../../../dist/castloop");
    const file = resolve(import.meta.dir, "fixture.mp3");
    async function run(json = false) {
      const process = Bun.spawn([binary, "episode", "upload-audio", showId, episodeId, file, ...(json ? ["--json"] : [])], { cwd: root, stdout: "pipe", stderr: "pipe",
        env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
      const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return { code, output, error };
    }
    expect((await run()).error).toContain("Show is invalid");
    expect(audio).toBeUndefined();
    invalidShow = false;
    const result = await run(true);
    expect({ code: result.code, error: result.error }).toEqual({ code: 1, error: "" });
    expect(JSON.parse(result.output)).toMatchObject({ version: 1, show_id: showId, episode_id: episodeId, exit_code: 1, result: { acceptance: "accepted", accepted_revision: 2, delivery: "pending" } });
    expect(submitted).toMatchObject({ action: "audio.set", payload: { episode_id: episodeId, audio: { sha256: audioSha }, facts: { mime: "audio/mpeg" } } });
    expect(submitted!.payload.audio.key).toMatch(new RegExp(`^${showId}/${episodeId}/_versions/.+/audio\\.mp3$`));
    expect(submitted!.payload.facts.duration_ms).toBeGreaterThan(0);
    expect(audio).toEqual(new Uint8Array(await readFile(file)));
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("standalone audio upload reports SIGINT without selecting the interrupted audio", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-audio-signal-"));
  const show = "s-01234567", episode = "e-01234567";
  const ref = { key: "key", etag: '"etag"', size: 5, sha256: "a".repeat(64) };
  let sendSignal: (() => void) | undefined, signalled = false, accepted = 0, copies = 0, origin = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/snapshot")) return Response.json({ protocol_version: 1, show_id: show, revision: 1, show: { metadata: ref, deleted: false }, episodes: [{ episode_id: episode, metadata: ref, guid: "opaque", deleted: false }], next_cursor: null });
    if (url.pathname.endsWith("/check")) return Response.json({ protocol_version: 1, show_id: show, revision: 1, issues: [], outcomes: [], cleanup_claims: [], delivery_base: origin, delivery_paths: [] });
    if (url.pathname.endsWith("/operations")) { accepted++; return new Response(null, { status: 500 }); }
    if (request.method === "POST" && url.searchParams.has("uploads")) return new Response('<InitiateMultipartUploadResult><UploadId>signal-upload</UploadId></InitiateMultipartUploadResult>', { headers: { "content-type": "application/xml" } });
    if (request.method === "PUT" && url.searchParams.has("partNumber")) {
      if (!signalled) { signalled = true; sendSignal?.(); }
      return new Response(null, { headers: { etag: '"part"' } });
    }
    if (request.method === "PUT" && request.headers.has("x-amz-copy-source")) copies++;
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 500 });
  } });
  origin = server.url.origin;
  try {
    await initWorkspace(root);
    for (const [key, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, key!, value!);
    const fixture = await readFile(resolve(import.meta.dir, "fixture.mp3"));
    const bytes = Buffer.alloc(17 * 1024 * 1024); fixture.copy(bytes);
    const path = join(root, "audio.mp3"); await writeFile(path, bytes);
    const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "episode", "upload-audio", show, episode, path, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
    sendSignal = () => { child.kill("SIGINT"); };
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(signalled).toBe(true);
    expect({ code, error }).toEqual({ code: 1, error: "" });
    expect(JSON.parse(output)).toMatchObject({ acceptance: "not_submitted", error: { message: expect.stringContaining("incomplete multipart parts") }, exit_code: 1 });
    expect(accepted).toBe(0);
    expect(copies).toBe(0);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 20_000);

test("standalone inventory discovers, registers and displays source records and cleanup claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-inventory-command-"));
  const showId = "s-01234567", operationId = "12345678-1234-4234-8234-123456789abc";
  const key = `${showId}/_versions/${operationId}/show.toml`, sha256 = "a".repeat(64);
  const ref = { key, etag: '"etag"', size: 7, sha256 };
  let registered = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/inventory") && request.method === "POST") {
      const body = await request.json() as { objects: unknown[] };
      if (JSON.stringify(body.objects) !== JSON.stringify([ref])) return new Response(null, { status: 400 });
      registered = true;
      return Response.json({ protocol_version: 1, show_id: showId, registered: [ref], skipped: [] });
    }
    if (url.pathname.endsWith("/inventory") && request.method === "GET") return Response.json({ protocol_version: 1, show_id: showId,
      records: registered ? [{ record_version: 1, ref, state: "delete_claimed", claim_operation_id: operationId, stored_at: 1, kind: "show_toml", episode_id: null }] : [], next_cursor: null });
    if (request.method === "HEAD" && url.pathname.endsWith(`/test-bucket/${key}`)) return new Response(null, { headers: { etag: ref.etag, "content-length": "7", "x-amz-meta-sha256": sha256 } });
    if (url.pathname === "/test-bucket/" && url.searchParams.get("prefix") === `${showId}/`) return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key><Size>7</Size><ETag>&quot;etag&quot;</ETag></Contents></ListBucketResult>`, { headers: { "content-type": "application/xml" } });
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    for (const [name, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, name!, value!);
    const process = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "inventory", "--show", showId], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(registered).toBe(true);
    expect(output).toContain(`delete_claimed 7 show_toml ${key} claim=${operationId}`);
    const child = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "inventory", "--show", showId, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
    const [jsonCode, jsonOutput, jsonError] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code: jsonCode, error: jsonError }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(jsonOutput)).toMatchObject({ version: 1, exit_code: 0, shows: [{ show_id: showId, issues: [], records: [{ ref, state: "delete_claimed", claim_operation_id: operationId }] }] });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("show list follows pages, filters deleted shows and reports partial failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-show-list-"));
  let partial = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/shows" || request.headers.get("authorization") !== "Bearer admin-test") return new Response(null, { status: 401 });
    if (!url.searchParams.has("cursor")) return Response.json({ protocol_version: 1, shows: [{ show_id: "s-01234567", revision: 1, deleted: false }], incomplete: false, issues: [], next_cursor: "next" });
    return Response.json({ protocol_version: 1, shows: [{ show_id: "s-76543210", revision: 2, deleted: true }], incomplete: partial,
      issues: partial ? [{ code: "dependency_unavailable", path: "s-12345678", message: "Unavailable", severity: "error" }] : [], next_cursor: null });
  } });
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", server.url.origin);
    async function run(...args: string[]) {
      const process = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "show", "list", ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
        env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
      const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return { code, output, error };
    }
    const normal = await run();
    expect(normal.code).toBe(0);
    expect(normal.output).toContain("s-01234567 revision=1");
    expect(normal.output).not.toContain("s-76543210");
    const json = await run("--json");
    expect({ code: json.code, error: json.error, result: JSON.parse(json.output) }).toEqual({ code: 0, error: "", result: { version: 1, shows: [{ show_id: "s-01234567", revision: 1, deleted: false }], issues: [], incomplete: false, exit_code: 0 } });
    partial = true;
    const all = await run("--include-deleted");
    expect(all.code).toBe(1);
    expect(all.output).toContain("s-76543210 revision=2 deleted");
    expect(all.error).toContain("Show listing is incomplete");
    const incomplete = await run("--json", "--include-deleted");
    expect({ code: incomplete.code, error: incomplete.error }).toEqual({ code: 1, error: "" });
    expect(JSON.parse(incomplete.output)).toMatchObject({ version: 1, incomplete: true, exit_code: 1, shows: [{ show_id: "s-01234567" }, { show_id: "s-76543210", deleted: true }], issues: [{ path: "s-12345678", message: "Unavailable" }] });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("export writes a metadata-only envelope and refuses to overwrite an existing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-export-command-"));
  const showId = "s-01234567", key = `${showId}/_versions/12345678-1234-4234-8234-123456789abc/show.toml`;
  const ref = { key, etag: '"etag"', size: 7, sha256: "a".repeat(64) };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname !== `/v1/shows/${showId}/export` || request.headers.get("authorization") !== "Bearer admin-test") return new Response(null, { status: 401 });
    return Response.json({ snapshot_version: 1, show_id: showId, source_revision: 3, show_control: { record_version: 1, show_id: showId, revision: 3, metadata: ref, cover: null, deleted: false, accepted_at: 1,
      last_receipt: null, current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false }, episodes: [],
      source_assets: [{ record_version: 1, episode_id: null, kind: "show_toml", operation_id: "12345678-1234-4234-8234-123456789abc", ref, stored_at: 1, registered_at: 1, facts: null, state: "present", claim_operation_id: null }], publication_outcomes: [], delivery_refs: [], required_objects: [ref], historical_missing_or_deleted: [] });
  } });
  try {
    await initWorkspace(root);
    for (const [name, value] of [["management_url", server.url.origin], ["management_bucket", "private-source"], ["delivery_bucket", "private-delivery"]]) await setConfigValue(root, name!, value!);
    const binary = resolve(import.meta.dir, "../../../dist/castloop"), path = join(root, "export.json");
    async function run(...args: string[]) {
      const process = Bun.spawn([binary, "export", path, "--show", showId, ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
        env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
      const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return { code, output, error };
    }
    const first = await run();
    expect({ code: first.code, error: first.error }).toEqual({ code: 0, error: "" });
    expect(first.output).toContain("Source objects remain in R2");
    const original = await readFile(path, "utf8");
    expect(JSON.parse(original)).toMatchObject({ format_version: 1, installation: { management_bucket: "private-source", delivery_bucket: "private-delivery" }, shows: [{ show_id: showId, required_objects: [ref] }] });
    expect(original).not.toContain("admin-test");
    expect((await run()).code).toBe(1);
    expect(await readFile(path, "utf8")).toBe(original);
    const failed = await run("--json");
    expect({ code: failed.code, error: failed.error }).toEqual({ code: 1, error: "" });
    expect(JSON.parse(failed.output)).toMatchObject({ version: 1, path, error: { message: expect.any(String) }, exit_code: 1 });
    await rm(path);
    const json = await run("--json");
    expect({ code: json.code, error: json.error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(json.output)).toMatchObject({ version: 1, path, shows: [showId], source_objects_remain_in_r2: true, exit_code: 0 });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("restore previews a stopped target and replays the same staged request after an uncertain response", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-restore-command-"));
  const showId = "s-01234567", sourceId = "12345678-1234-4234-8234-123456789abc";
  const ref = { key: `${showId}/_versions/${sourceId}/show.toml`, etag: '"source"', size: 7, sha256: "a".repeat(64) };
  const control = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted: false, accepted_at: 1, last_receipt: null,
    current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
  const asset = { record_version: 1, episode_id: null, kind: "show_toml", operation_id: sourceId, ref, stored_at: 1, registered_at: 1, facts: null, state: "present", claim_operation_id: null };
  const snapshot = { snapshot_version: 1, show_id: showId, source_revision: 1, show_control: control, episodes: [], source_assets: [asset], publication_outcomes: [], delivery_refs: [], required_objects: [ref], historical_missing_or_deleted: [] };
  let stored: Uint8Array | undefined, digest = "", stagePath = "";
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/snapshot")) return Response.json({ protocol_version: 1, show_id: showId, revision: 2, show: { metadata: ref, deleted: true }, episodes: [], next_cursor: null });
    if (url.pathname.endsWith("/check")) return Response.json({ protocol_version: 1, show_id: showId, revision: 2, issues: [], outcomes: [{ target: "show-withdrawal", state: "applied" }], cleanup_claims: [], delivery_base: "https://example.test", delivery_paths: [] });
    if (url.pathname.endsWith("/restore")) {
      const body = await request.json() as { operation_id: string; expected_revision: number };
      requests.push(body);
      if (requests.length === 1) return new Response("uncertain", { status: 503 });
      return Response.json({ protocol_version: 1, operation_id: body.operation_id, accepted_revision: body.expected_revision + 1, acceptance: "already_accepted", validation_issues: [], delivery: "blocked" });
    }
    if (request.method === "PUT") { stored = new Uint8Array(await request.arrayBuffer()); digest = request.headers.get("x-amz-meta-sha256") ?? ""; stagePath = url.pathname; return new Response(null, { headers: { etag: '"staged"' } }); }
    if (request.method === "HEAD" && stored && url.pathname === stagePath) return new Response(null, { headers: { etag: '"staged"', "content-length": String(stored.length), "x-amz-meta-sha256": digest } });
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    for (const [name, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "source-bucket"], ["delivery_bucket", "delivery-bucket"]]) await setConfigValue(root, name!, value!);
    const path = join(root, "snapshot.json");
    await writeFile(path, JSON.stringify({ format_version: 1, created_at: 1, installation: { management_origin: server.url.origin, management_bucket: "source-bucket", delivery_bucket: "delivery-bucket" }, shows: [snapshot] }));
    const binary = resolve(import.meta.dir, "../../../dist/castloop");
    async function run(...args: string[]) {
      const process = Bun.spawn([binary, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
      const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return { code, output, error };
    }
    expect((await run("restore", path, "--replace")).code).toBe(4);
    expect(stored).toBeUndefined();
    const attempt = await run("restore", path, "--replace", "--yes", "--json");
    expect(attempt.code).toBe(1);
    expect(attempt.error).toBe("");
    expect(JSON.parse(attempt.output)).toMatchObject({ version: 1, exit_code: 1, shows: [{ show_id: showId, acceptance: "unknown", receipt_retained: true, operation_id: expect.any(String) }] });
    expect(stagePath).toMatch(/\/_maintenance\/.+\/restore\.json$/);
    const [receipt] = await readdir(join(root, ".castloop", "pending"));
    const retry = await run("operation", "retry", receipt!.slice(0, -5));
    expect({ code: retry.code, error: retry.error }).toEqual({ code: 0, error: "" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect((await readdir(join(root, ".castloop", "pending"))).length).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".castloop", "state.json"), "utf8")).shows[showId]).toBeUndefined();
    const accepted = await run("restore", path, "--replace", "--yes", "--json");
    expect({ code: accepted.code, error: accepted.error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(accepted.output)).toMatchObject({ version: 1, exit_code: 0, shows: [{ show_id: showId, result: { acceptance: "already_accepted", delivery: "blocked" } }] });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("restore-resume previews eligible and scheduled episodes and requires confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-resume-command-"));
  const showId = "s-01234567", requests: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/restore-resume")) return new Response(null, { status: 404 });
    if (request.method === "GET") return Response.json({ protocol_version: 1, show_id: showId, revision: 3, state: "ready", issues: [], episodes: [
      { id: "e-01234567", state: "eligible", at: 0, issues: [] }, { id: "e-12345678", state: "scheduled", at: 2000000000000, issues: [] }] });
    const body = await request.json() as { operation_id: string; expected_revision: number };
    requests.push(body);
    return Response.json({ protocol_version: 1, operation_id: body.operation_id, accepted_revision: body.expected_revision + 1, acceptance: "accepted", validation_issues: [], delivery: "scheduled" });
  } });
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", server.url.origin);
    async function run(...args: string[]) {
      const process = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "restore-resume", showId, ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
        env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
      const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return { code, output, error };
    }
    expect((await run()).code).toBe(4);
    expect(requests).toHaveLength(0);
    const unconfirmed = await run("--json");
    expect(unconfirmed.code).toBe(4);
    expect(JSON.parse(unconfirmed.output)).toMatchObject({ preview: { revision: 3, state: "ready" }, error: { message: expect.stringContaining("--yes") }, exit_code: 4 });
    expect(requests).toHaveLength(0);
    const result = await run("--yes");
    expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: "" });
    expect(result.output).toContain("e-01234567: eligible");
    expect(result.output).toContain("e-12345678: scheduled");
    expect(requests[0]).toMatchObject({ expected_revision: 3, confirmed: true });
    expect((await readdir(join(root, ".castloop", "pending"))).length).toBe(0);
    const json = await run("--json", "--yes");
    expect({ code: json.code, error: json.error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(json.output)).toMatchObject({ show_id: showId, preview: { revision: 3, episodes: [{ id: "e-01234567", state: "eligible" }, { id: "e-12345678", state: "scheduled" }] }, result: { acceptance: "accepted", delivery: "scheduled" }, exit_code: 0 });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("cleanup previews, requires confirmation, and resumes an uncertain claimed deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-cleanup-command-"));
  const showId = "s-01234567", sourceOp = "12345678-1234-4234-8234-123456789abc";
  const key = `${showId}/_versions/${sourceOp}/show.toml`, sha256 = "a".repeat(64);
  const ref = { key, etag: '"etag"', size: 7, sha256 };
  let exists = true, claimId: string | null = null, state = "present", failCompletion = true, deletes = 0, claims = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/inventory")) return Response.json({ protocol_version: 1, show_id: showId, records: [{ record_version: 1, ref, state,
      claim_operation_id: claimId, stored_at: 1, kind: "show_toml", episode_id: null }], next_cursor: null });
    if (url.pathname.endsWith("/cleanup/claim")) {
      const body = await request.json() as { operation_id: string; candidates: typeof ref[] };
      claims++;
      if (state === "present") { state = "delete_claimed"; claimId = body.operation_id; }
      return Response.json({ protocol_version: 1, show_id: showId, operation_id: body.operation_id, cutoff_at: Date.now(),
        claimed: claimId === body.operation_id && state === "delete_claimed" ? [ref] : [], skipped: claimId === body.operation_id && state === "delete_claimed" ? [] : [{ key, issues: ["already retired"] }] });
    }
    if (url.pathname.endsWith("/cleanup/complete")) {
      const body = await request.json() as { operation_id: string };
      if (failCompletion) { failCompletion = false; return new Response("unavailable", { status: 503 }); }
      if (!exists && body.operation_id === claimId) { state = "deleted"; return Response.json({ protocol_version: 1, show_id: showId, operation_id: body.operation_id, deleted: [key], unresolved: [] }); }
      return Response.json({ protocol_version: 1, show_id: showId, operation_id: body.operation_id, deleted: [], unresolved: [{ key, issues: ["present"] }] });
    }
    if (url.pathname.endsWith(`/test-bucket/${key}`) && request.method === "HEAD") return exists ? new Response(null, { headers: { etag: ref.etag, "content-length": "7", "x-amz-meta-sha256": sha256 } }) : new Response(null, { status: 404 });
    if (url.pathname.endsWith(`/test-bucket/${key}`) && request.method === "DELETE") { deletes++; exists = false; return new Response(null, { status: 204 }); }
    return new Response(null, { status: 404 });
  } });
  try {
    await initWorkspace(root);
    for (const [name, value] of [["management_url", server.url.origin], ["r2_endpoint", server.url.origin], ["account_id", "a".repeat(32)], ["management_bucket", "test-bucket"]]) await setConfigValue(root, name!, value!);
    const binary = resolve(import.meta.dir, "../../../dist/castloop");
    async function run(...extra: string[]) {
      const process = Bun.spawn([binary, "cleanup", "--show", showId, "--older-than", "2", ...extra], { cwd: root, stdout: "pipe", stderr: "pipe",
        env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test", CASTLOOP_CLI_R2_ACCESS_KEY_ID: "test", CASTLOOP_CLI_R2_SECRET_ACCESS_KEY: "test" } });
      const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return { code, output, error };
    }
    expect((await run()).output).toContain("Preview only");
    expect((await run("--apply")).code).toBe(4);
    const preview = await run("--json");
    expect({ code: preview.code, error: preview.error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(preview.output)).toMatchObject({ apply_requested: false, previews: [{ show_id: showId, candidates: [{ ref }], claims: [] }], exit_code: 0 });
    const unconfirmed = await run("--apply", "--json");
    expect(unconfirmed.code).toBe(4);
    expect(JSON.parse(unconfirmed.output)).toMatchObject({ error: { message: expect.stringContaining("--yes") }, exit_code: 4 });
    expect(claims).toBe(0);
    const uncertain = await run("--apply", "--yes", "--json");
    expect(uncertain.code).toBe(1);
    expect(JSON.parse(uncertain.output)).toMatchObject({ apply_requested: true, events: [{ type: "claim_prepared", show_id: showId, operation_id: expect.any(String) }], exit_code: 1 });
    expect(deletes).toBe(1);
    expect((await readdir(join(root, ".castloop", "pending"))).some(name => name.startsWith("cleanup-"))).toBe(true);
    const resumed = await run("--apply", "--yes", "--json");
    expect({ code: resumed.code, error: resumed.error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(resumed.output)).toMatchObject({ events: [{ type: "pending", show_id: showId }, { type: "deleted", show_id: showId, key }], exit_code: 0 });
    expect(deletes).toBe(1);
    expect(state).toBe("deleted");
    expect((await readdir(join(root, ".castloop", "pending"))).filter(name => name.startsWith("cleanup-"))).toHaveLength(0);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("check reports issues and optionally probes delivery without forwarding management credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-check-command-"));
  const showId = "s-01234567";
  const feedPath = `/${showId}/feed.xml`;
  const audioPath = `/${showId}/e-01234567/audio.mp3`;
  const probes: { path: string; method: string; auth: string | null; range: string | null }[] = [];
  let origin = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/check")) return Response.json({ protocol_version: 1, show_id: showId, revision: 3, issues: [], outcomes: [], cleanup_claims: [], delivery_base: origin, delivery_paths: [feedPath, audioPath] });
    probes.push({ path: url.pathname, method: request.method, auth: request.headers.get("authorization"), range: request.headers.get("range") });
    if (request.method === "HEAD") return new Response(null, { status: 200 });
    return new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/10" } });
  } });
  origin = server.url.origin;
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", origin);
    const process = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "check", "--show", showId, "--delivery"], {
      cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" },
    });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(output).toContain("Delivery range");
    expect(probes).toHaveLength(3);
    expect(probes.every(probe => probe.auth === null)).toBe(true);
    expect(probes[2]).toMatchObject({ path: audioPath, method: "GET", range: "bytes=0-0" });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("recover submits the latest snapshot revision and reports the observed result", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-recover-command-"));
  const showId = "s-01234567";
  const ref = { key: "key", etag: '"etag"', size: 5, sha256: "a".repeat(64) };
  let received: { expected_revision: number; episode_id?: string } | undefined;
  let conflict = false;
  let delivery = "applied";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return Response.json({ protocol_version: 1, show_id: showId, revision: 5, show: { metadata: ref, deleted: true }, episodes: [], next_cursor: null });
    const input = await request.json() as { operation_id: string; expected_revision: number; episode_id?: string };
    received = input;
    if (conflict) return Response.json({ protocol_version: 1, issues: [{ code: "revision_conflict", message: "Show changed" }] }, { status: 409 });
    return Response.json({ protocol_version: 1, operation_id: input.operation_id, observed_revision: input.expected_revision, issues: [], delivery });
  } });
  try {
    await initWorkspace(root);
    await setConfigValue(root, "management_url", server.url.origin);
    const process = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "recover", showId, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(output)).toMatchObject({ version: 1, show_id: showId, result: { observed_revision: 5, delivery: "applied", issues: [] }, exit_code: 0 });
    expect(received?.expected_revision).toBe(5);
    expect(received?.episode_id).toBeUndefined();
    delivery = "pending";
    const pending = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "recover", showId, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
    const [pendingCode, pendingOutput, pendingError] = await Promise.all([pending.exited, new Response(pending.stdout).text(), new Response(pending.stderr).text()]);
    expect({ pendingCode, pendingError }).toEqual({ pendingCode: 1, pendingError: "" });
    expect(JSON.parse(pendingOutput)).toMatchObject({ result: { observed_revision: 5, delivery: "pending" }, exit_code: 1 });
    conflict = true;
    const stale = Bun.spawn([resolve(import.meta.dir, "../../../dist/castloop"), "recover", showId, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), CASTLOOP_ADMIN_TOKEN: "admin-test" } });
    const [staleCode, staleOutput, staleError] = await Promise.all([stale.exited, new Response(stale.stdout).text(), new Response(stale.stderr).text()]);
    expect(staleCode).toBe(3);
    expect(staleError).toBe("");
    expect(JSON.parse(staleOutput)).toMatchObject({ exit_code: 3, error: { code: "revision_conflict", status: 409 } });
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
