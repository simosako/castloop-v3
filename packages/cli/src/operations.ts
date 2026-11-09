import { createInterface } from "node:readline/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson, episodeIdPattern, parseToml, showIdPattern, showSchema, type Operation } from "@castloop/domain";
import { collectSnapshot, fetchCheck, fetchInventory, fetchSnapshotPage, registerInventory, RejectedOperationError, submitOperation, submitRecovery, UncertainOperationError, type CheckResult, type OperationResponse } from "./api";
import { credentialsDirectory, readConfig, readSecrets } from "./config";
import { recordAcceptedOperation } from "./metadata";
import { RejectedReceiptCleanupError, removePendingOperation, removeRejectedReceipt, savePendingOperation } from "./workspace";
import { inspectAudio, inspectCover } from "./media";
import { createR2Client, listCandidateShows, listR2ShowObjects, putR2Audio, putR2Cover, readR2Metadata } from "./r2";
import { UsageError } from "./errors";

export class CancelledOperation extends Error {}

/** Preserve the server outcome when a later local state/receipt write fails. */
export function reportAcceptedLocalFailure(result: OperationResponse | undefined, receiptRetained: boolean): void {
  if (!result) return;
  console.error(`Operation ${result.operation_id} was accepted at revision ${result.accepted_revision}; delivery: ${result.delivery}. A later local step failed.`);
  for (const issue of result.validation_issues) console.error(`${issue.path}: ${issue.message}`);
  if (receiptRetained) console.error(`The operation receipt was retained; use castloop operation retry ${result.operation_id} after fixing the local error.`);
}

function mutationFailure(error: unknown, showId: string, episodeId: string | undefined, operationId: string | undefined, result: OperationResponse | undefined, receiptSaved: boolean): void {
  const rejection = error instanceof RejectedReceiptCleanupError ? error.rejection : error instanceof RejectedOperationError ? error : undefined;
  const code = error instanceof CancelledOperation ? 4 : error instanceof UsageError ? 2 : error instanceof RejectedOperationError ? error.status === 409 ? 3 : [400, 413].includes(error.status) ? 2 : 1 : 1;
  process.exitCode = code;
  console.log(JSON.stringify({ version: 1, show_id: showId, episode_id: episodeId ?? null, ...(operationId ? { operation_id: operationId } : {}), ...(result ? { result } : {}),
    acceptance: result?.acceptance ?? (rejection ? "rejected" : error instanceof UncertainOperationError ? "unknown" : "not_submitted"),
    receipt_retained: receiptSaved, error: { message: error instanceof Error ? error.message : String(error), ...(rejection ? { code: rejection.code, status: rejection.status, ...(rejection.path ? { path: rejection.path } : {}) } : {}) }, exit_code: code }));
}

function mutationSuccess(json: boolean, label: string, showId: string, episodeId: string | undefined, result: OperationResponse, baselineUpdated: boolean): void {
  if (result.validation_issues.some(issue => issue.severity === "error")) process.exitCode = 2;
  else if (result.delivery === "failed" || result.delivery === "blocked" || result.delivery === "pending") process.exitCode = 1;
  if (json) console.log(JSON.stringify({ version: 1, show_id: showId, episode_id: episodeId ?? null, result, baseline_updated: baselineUpdated, exit_code: process.exitCode ?? 0 }));
  else {
    console.log(`${label} accepted at revision ${result.accepted_revision}; delivery: ${result.delivery}.`);
    if (result.delivery === "pending") console.log(`Delivery is incomplete; run castloop check --show ${showId}, then castloop recover ${showId} if still pending.`);
    if (!baselineUpdated) console.log("Local metadata baseline is older; run pull before editing or pushing.");
    for (const issue of result.validation_issues) console.error(`${issue.path}: ${issue.message}`);
  }
}

export async function inventoryShows(root: string, onlyShow?: string, json = false): Promise<void> {
  if (onlyShow !== undefined && !showIdPattern.test(onlyShow)) throw new UsageError("Invalid show ID");
  const config = await readConfig(root), secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !config.account_id || !config.management_bucket || !secrets.admin_token || !secrets.r2_access_key_id || !secrets.r2_secret_access_key) throw new Error("Management URL, account ID, bucket and credentials must be configured");
  const client = createR2Client({ accountId: config.account_id, bucket: config.management_bucket, endpoint: config.r2_endpoint, accessKeyId: secrets.r2_access_key_id, secretAccessKey: secrets.r2_secret_access_key });
  let failures = 0;
  const reports: Record<string, unknown>[] = [];
  try {
    const shows = onlyShow ? [onlyShow] : await listCandidateShows(client, config.management_bucket);
    for (const showId of shows) {
      const issues: { key: string; message: string }[] = [];
      const issue = (key: string, message: string) => { issues.push({ key, message }); failures++; if (!json) console.error(`${key}: ${message}`); };
      try {
        const prior = await fetchInventory(config.management_url, secrets.admin_token, showId);
        const known = new Map(prior.map(record => [record.ref.key, record]));
        const { refs, skipped } = await listR2ShowObjects(client, config.management_bucket, showId);
        for (const item of skipped) issue(item.key, item.reason);
        const observed = new Set([...refs.map(ref => ref.key), ...skipped.map(item => item.key)]);
        for (const record of prior) if (record.state === "present" && !observed.has(record.ref.key)) {
          issue(record.ref.key, "registered source was not found in the R2 listing");
        }
        const unregistered = refs.filter(ref => {
          const old = known.get(ref.key);
          if (!old) return true;
          if (old.state === "deleted" || canonicalJson(old.ref) !== canonicalJson(ref)) issue(ref.key, "retired key reappeared or object identity changed");
          return false;
        });
        for (let offset = 0; offset < unregistered.length; offset += 100) {
          const result = await registerInventory(config.management_url, secrets.admin_token, showId, unregistered.slice(offset, offset + 100));
          for (const item of result.skipped) issue(item.key, item.issues.join("; "));
        }
        const records = await fetchInventory(config.management_url, secrets.admin_token, showId);
        reports.push({ show_id: showId, records, issues });
        if (!json) {
          console.log(`${showId}: ${records.length} ledger entries`);
          for (const record of records) console.log(`${record.state} ${record.ref.size} ${record.kind} ${record.ref.key}${record.claim_operation_id ? ` claim=${record.claim_operation_id}` : ""}`);
        }
      } catch (error) { const message = error instanceof Error ? error.message : String(error); issue(showId, message); reports.push({ show_id: showId, issues, error: { message } }); }
    }
    if (!shows.length && !json) console.log("No show prefixes found.");
    if (failures) { if (!json) console.error("Inventory is incomplete; resolve skipped objects before cleanup."); process.exitCode = 1; }
    if (json) console.log(JSON.stringify({ version: 1, shows: reports, exit_code: process.exitCode ?? 0 }));
  } finally { client.destroy(); }
}

export async function uploadAudio(root: string, showId: string, episodeId: string, path: string, json = false): Promise<void> {
  let operationId: string | undefined, result: OperationResponse | undefined, receiptSaved = false;
  try {
  if (!showIdPattern.test(showId) || !episodeIdPattern.test(episodeId)) throw new UsageError("Invalid show or episode ID");
  const inspected = await inspectAudio(path);
  const config = await readConfig(root);
  const secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !config.account_id || !config.management_bucket || !secrets.admin_token || !secrets.r2_access_key_id || !secrets.r2_secret_access_key) throw new Error("Management URL, account ID, bucket and credentials must be configured");
  const client = createR2Client({ accountId: config.account_id, bucket: config.management_bucket, endpoint: config.r2_endpoint, accessKeyId: secrets.r2_access_key_id, secretAccessKey: secrets.r2_secret_access_key });
  try {
    const snapshot = await collectSnapshot(showId, cursor => fetchSnapshotPage(config.management_url!, secrets.admin_token!, showId, cursor));
    if (snapshot.show.deleted || !snapshot.episodes.some(episode => episode.episode_id === episodeId && !episode.deleted)) throw new Error("Show or episode does not exist or is deleted");
    const check = await fetchCheck(config.management_url, secrets.admin_token, showId);
    if (check.revision !== snapshot.revision) throw new Error("Show changed during upload preparation; retry");
    const showIssues = check.issues.filter(issue => issue.severity === "error" && (issue.path === "show" || issue.path.startsWith("show.")));
    if (showIssues.length) throw new UsageError(`Show is invalid: ${showIssues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
    operationId = crypto.randomUUID();
    const ref = await putR2Audio(client, config.management_bucket, `${showId}/${episodeId}/_versions/${operationId}/audio.mp3`, path, inspected);
    const operation: Operation = { protocol_version: 1, operation_id: operationId, expected_revision: snapshot.revision, action: "audio.set",
      payload: { episode_id: episodeId, audio: { ...ref, sha256: ref.sha256! }, facts: { mime: inspected.mime, duration_ms: inspected.duration_ms } } };
    await savePendingOperation(root, showId, operation);
    receiptSaved = true;
    try { result = await submitOperation(config.management_url, secrets.admin_token, showId, operation); }
    catch (error) {
      if (error instanceof RejectedOperationError) { await removeRejectedReceipt(root, operationId, error); receiptSaved = false; }
      else if (!json) console.error(`Retained operation ${operationId}; use castloop operation retry ${operationId}.`);
      throw error;
    }
    const baselineUpdated = await recordAcceptedOperation(root, showId, operation, result.accepted_revision);
    await removePendingOperation(root, operationId);
    receiptSaved = false;
    mutationSuccess(json, "Audio", showId, episodeId, result, baselineUpdated);
  } finally { client.destroy(); }
  } catch (error) { if (!json) { reportAcceptedLocalFailure(result, receiptSaved); throw error; } mutationFailure(error, showId, episodeId, operationId, result, receiptSaved); }
}

export async function confirmAction(message: string, yes: boolean | undefined): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CancelledOperation("Confirmation required; pass --yes in noninteractive mode");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!/^(?:y|yes)$/i.test((await prompt.question(`${message} [y/N] `)).trim())) throw new CancelledOperation("Operation cancelled");
  } finally { prompt.close(); }
}

/** Deletion commits a tombstone; the server reports delivery withdrawal separately. */
export async function deleteEntity(root: string, showId: string, episodeId: string | undefined, yes?: boolean, json = false): Promise<void> {
  let operationId: string | undefined, result: OperationResponse | undefined, receiptSaved = false;
  try {
  if (!showIdPattern.test(showId) || (episodeId !== undefined && !episodeIdPattern.test(episodeId))) throw new UsageError("Invalid show or episode ID");
  const config = await readConfig(root);
  const secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !secrets.admin_token) throw new Error("Management URL and token must be configured");
  const snapshot = await collectSnapshot(showId, cursor => fetchSnapshotPage(config.management_url!, secrets.admin_token!, showId, cursor));
  if (episodeId && !snapshot.episodes.some(entry => entry.episode_id === episodeId)) throw new Error("Episode not found");
  if (json && !yes) throw new CancelledOperation("Confirmation required; pass --yes in JSON mode");
  await confirmAction(episodeId ? `Delete episode ${episodeId} from ${showId}?` : `Delete show ${showId} and all its episodes?`, yes);
  const common = { protocol_version: 1 as const, operation_id: crypto.randomUUID(), expected_revision: snapshot.revision };
  const operation: Operation = episodeId ? { ...common, action: "episode.delete", payload: { episode_id: episodeId, confirmed: true } }
    : { ...common, action: "show.delete", payload: { confirmed: true } };
  operationId = operation.operation_id;
  await savePendingOperation(root, showId, operation);
  receiptSaved = true;
  try { result = await submitOperation(config.management_url, secrets.admin_token, showId, operation); }
  catch (error) {
    if (error instanceof RejectedOperationError) { await removeRejectedReceipt(root, operation.operation_id, error); receiptSaved = false; }
    else if (!json) console.error(`Retained operation ${operation.operation_id}; use castloop operation retry ${operation.operation_id}.`);
    throw error;
  }
  const baselineUpdated = await recordAcceptedOperation(root, showId, operation, result.accepted_revision);
  await removePendingOperation(root, operation.operation_id);
  receiptSaved = false;
  mutationSuccess(json, "Deletion", showId, episodeId, result, baselineUpdated);
  } catch (error) {
    if (!json) { reportAcceptedLocalFailure(result, receiptSaved); throw error; }
    mutationFailure(error, showId, episodeId, operationId, result, receiptSaved);
  }
}

export async function uploadCover(root: string, showId: string, path: string, json = false): Promise<void> {
  let operationId: string | undefined, result: OperationResponse | undefined, receiptSaved = false;
  try {
  if (!showIdPattern.test(showId)) throw new UsageError("Invalid show ID");
  const inspected = await inspectCover(path);
  const bytes = await readFile(path);
  if (bytes.length !== inspected.size || createHash("sha256").update(bytes).digest("hex") !== inspected.sha256) throw new Error("Cover changed after inspection; retry");
  const config = await readConfig(root);
  const secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !config.account_id || !config.management_bucket || !secrets.admin_token || !secrets.r2_access_key_id || !secrets.r2_secret_access_key) throw new Error("Management URL, account ID, bucket and credentials must be configured");
  const client = createR2Client({ accountId: config.account_id, bucket: config.management_bucket, endpoint: config.r2_endpoint, accessKeyId: secrets.r2_access_key_id, secretAccessKey: secrets.r2_secret_access_key });
  try {
    const snapshot = await collectSnapshot(showId, cursor => fetchSnapshotPage(config.management_url!, secrets.admin_token!, showId, cursor));
    if (snapshot.show.deleted) throw new Error("Show is deleted");
    const source = await readR2Metadata(client, config.management_bucket, snapshot.show.metadata);
    const show = showSchema.parse(parseToml(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)));
    const name = show.artwork;
    if (!name || !/^[^/\\]+\.(?:jpe?g|png)$/i.test(name) || (inspected.mime === "image/png") !== /\.png$/i.test(name)) throw new UsageError("Show artwork must specify a matching JPEG or PNG filename; push show.toml first");
    operationId = crypto.randomUUID();
    const ref = await putR2Cover(client, config.management_bucket, `${showId}/_versions/${operationId}/${name}`, bytes, inspected.mime);
    const operation: Operation = { protocol_version: 1, operation_id: operationId, expected_revision: snapshot.revision, action: "cover.set",
      payload: { logical_name: name, cover: { ...ref, sha256: ref.sha256! }, facts: { mime: inspected.mime, width: inspected.width, height: inspected.height, color: "rgb", alpha: false } } };
    await savePendingOperation(root, showId, operation);
    receiptSaved = true;
    try { result = await submitOperation(config.management_url, secrets.admin_token, showId, operation); }
    catch (error) {
      if (error instanceof RejectedOperationError) { await removeRejectedReceipt(root, operationId, error); receiptSaved = false; }
      else if (!json) console.error(`Retained operation ${operationId}; use castloop operation retry ${operationId}.`);
      throw error;
    }
    const baselineUpdated = await recordAcceptedOperation(root, showId, operation, result.accepted_revision);
    await removePendingOperation(root, operationId);
    receiptSaved = false;
    mutationSuccess(json, "Cover", showId, undefined, result, baselineUpdated);
  } finally { client.destroy(); }
  } catch (error) { if (!json) { reportAcceptedLocalFailure(result, receiptSaved); throw error; } mutationFailure(error, showId, undefined, operationId, result, receiptSaved); }
}

async function probeDelivery(result: CheckResult, log: (message: string) => void = console.log): Promise<{ path: string; method: string; status: number; content_range?: string }[]> {
  const origin = new URL(result.delivery_base);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)))) throw new Error("Invalid delivery origin in check response");
  const safePath = new RegExp(`^/${result.show_id}/(?:feed\\.xml|e-[0-9abcdefghjkmnpqrstvwxyz]{8}/audio\\.mp3|covers/[A-Za-z0-9_-]+\\.(?:jpg|png))$`);
  if (result.delivery_paths.some(path => !safePath.test(path))) throw new Error("Invalid public path in check response");
  const feed = result.delivery_paths.find(path => path.endsWith("/feed.xml"));
  const audio = result.delivery_paths.find(path => path.endsWith("/audio.mp3"));
  const probes: { path: string; method: string; status: number; content_range?: string }[] = [];
  if (!feed && !audio) { log(`${result.show_id}: no previously advertised feed or audio to probe.`); return probes; }
  for (const path of [feed, audio]) {
    if (!path) continue;
    const response = await fetch(new URL(path, origin), { method: "HEAD" });
    if (!response.ok) throw new Error(`Delivery HEAD ${path} returned HTTP ${response.status}`);
    probes.push({ path, method: "HEAD", status: response.status });
    log(`Delivery HEAD ${path}: ${response.status}`);
  }
  if (audio) {
    const response = await fetch(new URL(audio, origin), { headers: { Range: "bytes=0-0" } });
    const range = response.headers.get("Content-Range") ?? "";
    await response.body?.cancel();
    if (response.status !== 206 || !/^bytes 0-0\/\d+$/.test(range)) throw new Error(`Delivery range probe ${audio} returned HTTP ${response.status} with invalid Content-Range`);
    probes.push({ path: audio, method: "GET", status: response.status, content_range: range });
    log(`Delivery range ${audio}: ${response.status} ${range}`);
  }
  return probes;
}

export async function checkShows(root: string, onlyShow?: string, delivery = false, json = false): Promise<void> {
  if (onlyShow !== undefined && !showIdPattern.test(onlyShow)) throw new UsageError("Invalid show ID");
  const config = await readConfig(root);
  const secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !secrets.admin_token) throw new Error("Management URL and token must be configured");
  let shows: string[];
  if (onlyShow) shows = [onlyShow];
  else {
    if (!config.account_id || !config.management_bucket || !secrets.r2_access_key_id || !secrets.r2_secret_access_key) throw new Error("R2 account, bucket and credentials are required to discover shows");
    const client = createR2Client({ accountId: config.account_id, bucket: config.management_bucket, endpoint: config.r2_endpoint, accessKeyId: secrets.r2_access_key_id, secretAccessKey: secrets.r2_secret_access_key });
    try { shows = await listCandidateShows(client, config.management_bucket); } finally { client.destroy(); }
  }
  let status = 0;
  const checks: { show_id: string; result?: CheckResult; delivery_probes?: Awaited<ReturnType<typeof probeDelivery>>; error?: string }[] = [];
  const log = (message: string) => { if (!json) console.log(message); };
  const report = (message: string) => { if (!json) console.error(message); };
  for (const showId of shows) {
    const entry: typeof checks[number] = { show_id: showId };
    checks.push(entry);
    try {
      const result = await fetchCheck(config.management_url, secrets.admin_token, showId);
      entry.result = result;
      log(`${showId}: revision ${result.revision}`);
      log(`Delivery: ${result.delivery_base}${result.pending_delivery_base ? ` (pending: ${result.pending_delivery_base})` : ""}`);
      for (const item of result.issues) { report(`${item.path}: ${item.message}`); if (item.severity === "error") status = Math.max(status, item.code === "publication_invalid" ? 2 : 1); }
      for (const outcome of result.outcomes) {
        log(`${outcome.target}: ${outcome.state}`);
        if (outcome.error) report(`  ${outcome.error.code}: ${outcome.error.message}`);
        if (outcome.notification) log(`  notification: ${outcome.notification}`);
        if (outcome.state === "failed" || outcome.state === "pending") status = Math.max(status, 1);
        if (outcome.state === "blocked") status = Math.max(status, 2);
      }
      for (const claim of result.cleanup_claims) { log(`Unresolved cleanup: ${claim.object_key} (${claim.claim_operation_id ?? "unknown operation"})`); status = Math.max(status, 1); }
      if (delivery) entry.delivery_probes = await probeDelivery(result, log);
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); report(`${showId}: ${entry.error}`); status = Math.max(status, 1); }
  }
  if (!shows.length) log("No show prefixes found.");
  if (json) console.log(JSON.stringify({ version: 1, checks, exit_code: status }));
  if (status) process.exitCode = status;
}

/** Accept a confirmed per-show migration; retry uses the saved immutable operation. */
export async function changeDelivery(root: string, showId: string, target: string | undefined, yes?: boolean, json = false): Promise<void> {
  let operationId: string | undefined, result: OperationResponse | undefined, receiptSaved = false;
  try {
  if (!showIdPattern.test(showId)) throw new UsageError("Invalid show ID");
  const config = await readConfig(root), secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !secrets.admin_token) throw new Error("Management URL and token must be configured");
  const check = await fetchCheck(config.management_url, secrets.admin_token, showId);
  const destination = target ?? (check.pending_delivery_base ? check.delivery_base : check.previous_delivery_base);
  if (!destination) throw new Error("No previous delivery origin is available");
  let url: URL;
  try { url = new URL(destination); } catch { throw new UsageError("Destination must be an HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== destination) throw new UsageError("Destination must be an HTTPS origin");
  if (json && !yes) throw new CancelledOperation("Confirmation required; pass --yes in JSON mode");
  await confirmAction(`Change ${showId} delivery from ${check.delivery_base} to ${destination}?`, yes);
  const operation: Operation = { protocol_version: 1, operation_id: crypto.randomUUID(), expected_revision: check.revision,
    action: "delivery.set", payload: { target_base: destination, confirmed: true } };
  operationId = operation.operation_id;
  await savePendingOperation(root, showId, operation);
  receiptSaved = true;
  try { result = await submitOperation(config.management_url, secrets.admin_token, showId, operation); }
  catch (error) {
    if (error instanceof RejectedOperationError) { await removeRejectedReceipt(root, operation.operation_id, error); receiptSaved = false; }
    else if (!json) console.error(`Retained operation ${operation.operation_id}; use castloop operation retry ${operation.operation_id}.`);
    throw error;
  }
  const baselineUpdated = await recordAcceptedOperation(root, showId, operation, result.accepted_revision);
  await removePendingOperation(root, operation.operation_id);
  receiptSaved = false;
  mutationSuccess(json, "Delivery change", showId, undefined, result, baselineUpdated);
  } catch (error) { if (!json) { reportAcceptedLocalFailure(result, receiptSaved); throw error; } mutationFailure(error, showId, undefined, operationId, result, receiptSaved); }
}

export async function recoverShow(root: string, showId: string, episodeId?: string, json = false): Promise<void> {
  let operationId: string | undefined;
  try {
  if (!showIdPattern.test(showId) || (episodeId !== undefined && !episodeIdPattern.test(episodeId))) throw new UsageError("Invalid show or episode ID");
  const config = await readConfig(root);
  const secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !secrets.admin_token) throw new Error("Management URL and token must be configured");
  const snapshot = await collectSnapshot(showId, cursor => fetchSnapshotPage(config.management_url!, secrets.admin_token!, showId, cursor));
  if (episodeId && !snapshot.episodes.some(entry => entry.episode_id === episodeId)) throw new Error("Episode not found");
  operationId = crypto.randomUUID();
  const result = await submitRecovery(config.management_url, secrets.admin_token, showId, { protocol_version: 1, operation_id: operationId, expected_revision: snapshot.revision, ...(episodeId ? { episode_id: episodeId } : {}) });
  if (result.issues.some(item => item.severity === "error") || result.delivery === "blocked") process.exitCode = 2;
  else if (result.delivery === "failed" || result.delivery === "pending") process.exitCode = 1;
  if (json) console.log(JSON.stringify({ version: 1, show_id: showId, episode_id: episodeId ?? null, result, exit_code: process.exitCode ?? 0 }));
  else {
    console.log(`Recovery for ${showId}: ${result.delivery} at revision ${result.observed_revision}.`);
    for (const item of result.issues) console.error(`${item.path}: ${item.message}`);
  }
  } catch (error) {
    if (!json) throw error;
    const code = error instanceof UsageError ? 2 : error instanceof RejectedOperationError ? error.status === 409 ? 3 : [400, 413].includes(error.status) ? 2 : 1 : 1;
    process.exitCode = code;
    console.log(JSON.stringify({ version: 1, show_id: showId, episode_id: episodeId ?? null, ...(operationId ? { operation_id: operationId } : {}),
      error: { message: error instanceof Error ? error.message : String(error), ...(error instanceof RejectedOperationError ? { code: error.code, status: error.status } : {}) }, exit_code: code }));
  }
}
