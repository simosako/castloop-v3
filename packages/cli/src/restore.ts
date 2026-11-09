import { readFile } from "node:fs/promises";
import { exportEnvelopeSchema, showIdPattern, type Operation } from "@castloop/domain";
import { collectSnapshot, fetchCheck, fetchRestorePreview, fetchSnapshotPage, ManagementNotFoundError, RejectedOperationError, submitOperation, type OperationResponse } from "./api";
import { credentialsDirectory, readConfig, readSecrets } from "./config";
import { CancelledOperation, confirmAction, reportAcceptedLocalFailure } from "./operations";
import { createR2Client, putR2RestoreEnvelope } from "./r2";
import { removePendingOperation, removeRejectedReceipt, savePendingOperation } from "./workspace";
import { UsageError } from "./errors";

/** Restore each validated Show independently, keeping publication on hold. */
export async function restoreShows(root: string, path: string, replace = false, yes = false, json = false): Promise<void> {
  if (json && !yes) throw new CancelledOperation("--json requires --yes to confirm restore");
  const bytes = await readFile(path);
  let envelope: ReturnType<typeof exportEnvelopeSchema.parse>;
  try { envelope = exportEnvelopeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch (error) { throw new UsageError(`Invalid restore snapshot: ${error instanceof Error ? error.message : String(error)}`); }
  if (!envelope.shows.length) throw new UsageError("Export contains no shows");
  const config = await readConfig(root), secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !config.account_id || !config.management_bucket || !config.delivery_bucket || !secrets.admin_token || !secrets.r2_access_key_id || !secrets.r2_secret_access_key) throw new Error("Management URL, account, both buckets and credentials must be configured");
  if (envelope.installation.management_bucket !== config.management_bucket || envelope.installation.delivery_bucket !== config.delivery_bucket) throw new Error("Export belongs to different R2 buckets");
  const plans: { showId: string; revision: number; bytes: Uint8Array; exists: boolean }[] = [];
  for (const show of envelope.shows) {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...envelope, shows: [show] }));
    if (bytes.length > 16 * 1024 * 1024) throw new Error(`${show.show_id}: restore envelope exceeds 16 MiB`);
    let revision = 0, exists = false;
    try {
      const current = await collectSnapshot(show.show_id, cursor => fetchSnapshotPage(config.management_url!, secrets.admin_token!, show.show_id, cursor));
      revision = current.revision; exists = true;
      if (!replace) throw new Error(`${show.show_id}: existing show requires --replace`);
      const check = await fetchCheck(config.management_url, secrets.admin_token, show.show_id);
      if (check.revision !== revision) throw new Error(`${show.show_id}: show changed during restore preview`);
      if (!check.outcomes.some(item => item.target === "show-withdrawal" && item.state === "applied")) throw new Error(`${show.show_id}: stop the show and complete withdrawal before restoring`);
    } catch (error) { if (!(error instanceof ManagementNotFoundError)) throw error; }
    plans.push({ showId: show.show_id, revision, bytes, exists });
    if (!json) console.log(`${show.show_id}: ${exists ? `replace revision ${revision}` : "create"}, ${show.episodes.length} episode(s), ${show.required_objects.length} required objects; publication remains on hold.`);
  }
  await confirmAction("Restore these shows from the selected export?", yes);
  const client = createR2Client({ accountId: config.account_id, bucket: config.management_bucket, endpoint: config.r2_endpoint, accessKeyId: secrets.r2_access_key_id, secretAccessKey: secrets.r2_secret_access_key });
  let failures = 0;
  const reports: Record<string, unknown>[] = [];
  try {
    for (const plan of plans) {
      let operationId: string | undefined, result: OperationResponse | undefined, receiptSaved = false, rejected = false;
      try {
        operationId = crypto.randomUUID();
        const ref = await putR2RestoreEnvelope(client, config.management_bucket, `${plan.showId}/_maintenance/${operationId}/restore.json`, plan.bytes);
        const operation: Operation = { protocol_version: 1, operation_id: operationId, expected_revision: plan.revision, action: "restore",
          payload: { snapshot: { ...ref, sha256: ref.sha256! }, replace, confirmed: true } };
        await savePendingOperation(root, plan.showId, operation);
        receiptSaved = true;
        try { result = await submitOperation(config.management_url, secrets.admin_token, plan.showId, operation); }
        catch (error) {
          if (error instanceof RejectedOperationError) { rejected = true; await removeRejectedReceipt(root, operationId, error); receiptSaved = false; }
          else if (!json) console.error(`Retained operation ${operationId}; use castloop operation retry ${operationId}.`);
          throw error;
        }
        await removePendingOperation(root, operationId);
        receiptSaved = false;
        reports.push({ show_id: plan.showId, result });
        if (!json) console.log(`${plan.showId}: restored at revision ${result.accepted_revision}; publication is on hold. Run pull before editing.`);
      } catch (error) {
        failures++;
        const message = error instanceof Error ? error.message : String(error);
        if (!json) reportAcceptedLocalFailure(result, receiptSaved);
        reports.push({ show_id: plan.showId, ...(operationId ? { operation_id: operationId } : {}), ...(result ? { result } : {}), receipt_retained: receiptSaved, error: { message }, ...(rejected ? { acceptance: "rejected" } : receiptSaved && !result ? { acceptance: "unknown" } : {}) });
        if (!json) console.error(`${plan.showId}: ${message}`);
      }
    }
  } finally { client.destroy(); }
  if (failures) { process.exitCode = 1; if (!json) console.error("Some shows were not restored; inspect the reported results."); }
  if (json) console.log(JSON.stringify({ version: 1, shows: reports, exit_code: process.exitCode ?? 0 }));
}

export async function resumeRestore(root: string, showId: string, yes = false, json = false): Promise<void> {
  let preview: Awaited<ReturnType<typeof fetchRestorePreview>> | undefined, operationId: string | undefined, result: OperationResponse | undefined, receiptSaved = false, rejected = false;
  try {
  if (!showIdPattern.test(showId)) throw new UsageError("Invalid show ID");
  const config = await readConfig(root), secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !secrets.admin_token) throw new Error("Management URL and token must be configured");
  preview = await fetchRestorePreview(config.management_url, secrets.admin_token, showId);
  if (!json) {
  console.log(`${showId}: ${preview.state} at revision ${preview.revision}`);
  for (const issue of preview.issues) console.error(`${issue.path}: ${issue.message}`);
  for (const episode of preview.episodes) {
    console.log(`${episode.id}: ${episode.state}${episode.at === null ? "" : ` ${new Date(episode.at).toISOString()}`}`);
    for (const issue of episode.issues) console.error(`${episode.id}.${issue.path}: ${issue.message}`);
  }
  }
  if (preview.state === "hold") { process.exitCode = 2; if (json) console.log(JSON.stringify({ version: 1, show_id: showId, preview, exit_code: 2 })); return; }
  if (json && !yes) throw new CancelledOperation("--json requires --yes to confirm resume");
  await confirmAction(`Resume restored show ${showId}?`, yes);
  operationId = crypto.randomUUID();
  const operation: Operation = { protocol_version: 1, operation_id: operationId, expected_revision: preview.revision, action: "restore-resume", payload: { confirmed: true } };
  await savePendingOperation(root, showId, operation);
  receiptSaved = true;
  try { result = await submitOperation(config.management_url, secrets.admin_token, showId, operation); }
  catch (error) {
    if (error instanceof RejectedOperationError) { rejected = true; await removeRejectedReceipt(root, operation.operation_id, error); receiptSaved = false; }
    else if (!json) console.error(`Retained operation ${operation.operation_id}; use castloop operation retry ${operation.operation_id}.`);
    throw error;
  }
  await removePendingOperation(root, operation.operation_id);
  receiptSaved = false;
  if (!json) console.log(`${showId}: resume accepted at revision ${result.accepted_revision}; delivery: ${result.delivery}. Run pull before editing.`);
  if (result.delivery === "blocked" || result.delivery === "failed" || result.delivery === "pending") process.exitCode = 1;
  if (json) console.log(JSON.stringify({ version: 1, show_id: showId, preview, result, exit_code: process.exitCode ?? 0 }));
  } catch (error) {
    if (!json) { reportAcceptedLocalFailure(result, receiptSaved); throw error; }
    process.exitCode = error instanceof CancelledOperation ? 4 : error instanceof UsageError ? 2 : error instanceof RejectedOperationError ? error.status === 409 ? 3 : [400, 413].includes(error.status) ? 2 : 1 : 1;
    console.log(JSON.stringify({ version: 1, show_id: showId, ...(preview ? { preview } : {}), ...(operationId ? { operation_id: operationId } : {}), ...(result ? { result } : {}), receipt_retained: receiptSaved, ...(rejected ? { acceptance: "rejected" } : receiptSaved && !result ? { acceptance: "unknown" } : {}), error: { message: error instanceof Error ? error.message : String(error) }, exit_code: process.exitCode }));
  }
}
