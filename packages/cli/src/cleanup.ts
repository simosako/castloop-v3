import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, cleanupClaimSchema, showIdPattern, type CleanupClaim, type ObjectRef } from "@castloop/domain";
import { fetchInventory, submitCleanupClaim, submitCleanupComplete, type InventoryRecord } from "./api";
import { credentialsDirectory, readConfig, readSecrets } from "./config";
import { CancelledOperation, confirmAction } from "./operations";
import { createR2Client, deleteClaimedR2Object, listCandidateShows } from "./r2";
import { UsageError } from "./errors";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface Receipt { version: 1; show_id: string; request: CleanupClaim }

/** Preview by default; all destructive work requires a fresh claim and confirmation. */
export async function cleanupShows(root: string, days: number, onlyShow?: string, apply = false, yes = false, json = false): Promise<void> {
  const previews: Record<string, unknown>[] = [], events: Record<string, unknown>[] = [];
  try {
  if (!Number.isSafeInteger(days) || days <= 0 || !Number.isSafeInteger(days * 86400000) || (onlyShow !== undefined && !showIdPattern.test(onlyShow))) throw new UsageError("Cleanup requires a positive integer number of days and a valid show ID");
  const config = await readConfig(root), secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !config.account_id || !config.management_bucket || !secrets.admin_token || !secrets.r2_access_key_id || !secrets.r2_secret_access_key) throw new Error("Management URL, account ID, bucket and credentials must be configured");
  const client = createR2Client({ accountId: config.account_id, bucket: config.management_bucket, endpoint: config.r2_endpoint, accessKeyId: secrets.r2_access_key_id, secretAccessKey: secrets.r2_secret_access_key });
  const dir = join(root, ".castloop", "pending");
  try {
    const shows = onlyShow ? [onlyShow] : await listCandidateShows(client, config.management_bucket);
    const localReceipts: Receipt[] = [];
    let files: string[];
    try { files = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files = []; }
    for (const file of files.filter(name => /^cleanup-[0-9a-f-]+\.json$/.test(name))) {
      const raw = await readFile(join(dir, file));
      if (raw.length > 1024 * 1024) throw new Error(`Cleanup receipt too large: ${file}`);
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Receipt;
      if (parsed.version !== 1 || !showIdPattern.test(parsed.show_id) || !uuid.test(parsed.request?.operation_id ?? "") || file !== `cleanup-${parsed.request.operation_id}.json`) throw new Error(`Invalid cleanup receipt: ${file}`);
      parsed.request = cleanupClaimSchema.parse(parsed.request);
      if (!onlyShow || onlyShow === parsed.show_id) { localReceipts.push(parsed); if (!shows.includes(parsed.show_id)) shows.push(parsed.show_id); }
    }
    const snapshots = new Map<string, InventoryRecord[]>();
    for (const show of shows) snapshots.set(show, await fetchInventory(config.management_url, secrets.admin_token, show));
    const cutoff = Date.now() - days * 86400000;
    if (!Number.isSafeInteger(cutoff)) throw new Error("Invalid cleanup cutoff");
    for (const show of shows) {
      const records = snapshots.get(show)!;
      const candidates = records.filter(item => item.state === "present" && item.stored_at < cutoff);
      const claims = records.filter(item => item.state === "delete_claimed");
      previews.push({ show_id: show, candidates, claims });
      if (!json) {
        console.log(`${show}: ${candidates.length} age-eligible candidates (${candidates.reduce((sum, item) => sum + item.ref.size, 0)} bytes), ${claims.length} existing claims`);
        for (const item of [...candidates, ...claims]) console.log(`${item.state} ${item.ref.size} ${item.ref.key}${item.claim_operation_id ? ` claim=${item.claim_operation_id}` : ""}`);
      }
    }
    if (localReceipts.length && !json) {
      console.log(`${localReceipts.length} saved cleanup requests require reconciliation.`);
      for (const receipt of localReceipts) for (const ref of receipt.request.candidates) console.log(`pending ${receipt.show_id} ${ref.size} ${ref.key} claim=${receipt.request.operation_id}`);
    }
    events.push(...localReceipts.map(receipt => ({ type: "pending", show_id: receipt.show_id, operation_id: receipt.request.operation_id, candidates: receipt.request.candidates })));
    if (!apply || !shows.length) {
      if (json) console.log(JSON.stringify({ version: 1, apply_requested: apply, previews, events, exit_code: 0 }));
      else console.log(!apply ? "Preview only; run with --apply to request deletion. The server will recheck eligibility." : "No show prefixes found.");
      return;
    }
    if (json && !yes) throw new CancelledOperation("--json --apply requires --yes to confirm cleanup");
    await confirmAction("Permanently remove eligible private source versions and finish existing cleanup claims?", yes);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let failures = 0;
    const attempted = new Set<string>();
    const finish = async (showId: string, operationId: string, refs: ObjectRef[]): Promise<boolean> => {
      for (const ref of refs) {
        attempted.add(`${showId}\0${operationId}\0${ref.key}`);
        try { await deleteClaimedR2Object(client, config.management_bucket!, ref); }
        catch (error) { failures++; const message = error instanceof Error ? error.message : String(error); events.push({ type: "delete_error", show_id: showId, operation_id: operationId, key: ref.key, message }); if (!json) console.error(`${ref.key}: ${message}`); }
      }
      const result = await submitCleanupComplete(config.management_url!, secrets.admin_token!, showId, { protocol_version: 1, operation_id: operationId, keys: refs.map(ref => ref.key) });
      for (const key of result.deleted) { events.push({ type: "deleted", show_id: showId, operation_id: operationId, key }); if (!json) console.log(`Deleted ${key}`); }
      for (const item of result.unresolved) { failures++; events.push({ type: "unresolved", show_id: showId, operation_id: operationId, ...item }); if (!json) console.error(`${item.key}: ${item.issues.join("; ")}`); }
      return result.unresolved.length === 0;
    };
    const reconcile = async (receipt: Receipt) => {
      const result = await submitCleanupClaim(config.management_url!, secrets.admin_token!, receipt.show_id, receipt.request);
      for (const item of result.skipped) { events.push({ type: "skipped", show_id: receipt.show_id, operation_id: receipt.request.operation_id, ...item }); if (!json) console.log(`Skipped ${item.key}: ${item.issues.join("; ")}`); }
      const done = !result.claimed.length || await finish(receipt.show_id, receipt.request.operation_id, result.claimed);
      if (done) await unlink(join(dir, `cleanup-${receipt.request.operation_id}.json`)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    };
    for (const receipt of localReceipts) await reconcile(receipt);
    for (const show of shows) {
      const preview = new Map(snapshots.get(show)!.map(item => [item.ref.key, item]));
      const records = await fetchInventory(config.management_url, secrets.admin_token, show);
      const byClaim = new Map<string, ObjectRef[]>();
      for (const item of records) if (item.state === "delete_claimed") {
        if (!item.claim_operation_id || !uuid.test(item.claim_operation_id)) { failures++; events.push({ type: "invalid_claim", show_id: show, key: item.ref.key }); if (!json) console.error(`${item.ref.key}: invalid cleanup claim`); continue; }
        const old = preview.get(item.ref.key);
        if (!old || old.state !== "delete_claimed" || old.claim_operation_id !== item.claim_operation_id || canonicalJson(old.ref) !== canonicalJson(item.ref) || attempted.has(`${show}\0${item.claim_operation_id}\0${item.ref.key}`)) continue;
        const group = byClaim.get(item.claim_operation_id) ?? []; group.push(item.ref); byClaim.set(item.claim_operation_id, group);
      }
      for (const [operationId, refs] of byClaim) for (let i = 0; i < refs.length; i += 100) await finish(show, operationId, refs.slice(i, i + 100));
      const current = await fetchInventory(config.management_url, secrets.admin_token, show);
      const candidates = current.filter(item => {
        const old = preview.get(item.ref.key);
        return item.state === "present" && item.stored_at < cutoff && old?.state === "present" && old.stored_at === item.stored_at && canonicalJson(old.ref) === canonicalJson(item.ref);
      });
      for (let i = 0; i < candidates.length; i += 100) {
        const operationId = crypto.randomUUID();
        const request: CleanupClaim = { protocol_version: 1, operation_id: operationId, older_than_days: days, candidates: candidates.slice(i, i + 100).map(item => item.ref) };
        const receipt: Receipt = { version: 1, show_id: show, request };
        await writeFile(join(dir, `cleanup-${operationId}.json`), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
        events.push({ type: "claim_prepared", show_id: show, operation_id: operationId, candidates: request.candidates });
        await reconcile(receipt);
      }
      if (!json) console.log(`Cleanup processed ${show}; retain this ID if the deleted Show no longer appears in discovery.`);
    }
    if (failures) { if (!json) console.error("Cleanup incomplete; unresolved claims remain available for a later run."); process.exitCode = 1; }
    if (json) console.log(JSON.stringify({ version: 1, apply_requested: true, previews, events, exit_code: process.exitCode ?? 0 }));
  } finally { client.destroy(); }
  } catch (error) {
    if (!json) throw error;
    process.exitCode = error instanceof CancelledOperation ? 4 : error instanceof UsageError ? 2 : 1;
    console.log(JSON.stringify({ version: 1, apply_requested: apply, previews, events, error: { message: error instanceof Error ? error.message : String(error) }, exit_code: process.exitCode }));
  }
}
