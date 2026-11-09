#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { episodeSchema, newGuid, parseToml, showIdPattern, showSchema, type Operation } from "@castloop/domain";
import { abandonPendingOperation, assertNoPendingOperations, initWorkspace, newEpisode, newShow, readPendingOperation, RejectedReceiptCleanupError, removePendingOperation, removeRejectedReceipt, savePendingOperation } from "./workspace";
import { credentialsDirectory, promptSecret, readConfig, readSecrets, setConfigValue, setSecret } from "./config";
import { collectSnapshot, fetchShows, fetchSnapshotPage, RejectedOperationError, submitOperation, UncertainOperationError, type OperationResponse } from "./api";
import { applyTimezoneNormalization, hasInterruptedReidentification, MetadataPreflightError, planMetadataPush, prepareTimezoneNormalization, pullShow, recordAcceptedOperation, recoverReidentification, reidentifyEpisodeDraft, reidentifyShowDraft } from "./metadata";
import { createR2Client, listCandidateShows, putR2Metadata, readR2Metadata } from "./r2";
import { CancelledOperation, changeDelivery, checkShows, confirmAction, deleteEntity, inventoryShows, recoverShow, reportAcceptedLocalFailure, uploadAudio, uploadCover } from "./operations";
import { cleanupShows } from "./cleanup";
import { exportShows } from "./export";
import { restoreShows, resumeRestore } from "./restore";
import { UsageError } from "./errors";

const program = new Command();
program.exitOverride();
program.name("castloop").description("Manage and publish podcasts on Cloudflare (under development)").version("0.0.0-dev");
program.hook("preAction", async (_command, action) => {
  if (["push", "recover-local", "check", "list"].includes(action.name())) return;
  if (!(await hasInterruptedReidentification(process.cwd()))) return;
  const message = "An ID change was interrupted; run castloop operation recover-local before this command";
  if (action.opts().json) console.log(JSON.stringify({ version: 1, error: { message }, exit_code: 1 }));
  else console.error(message);
  throw new CommanderError(1, "castloop.recoveryRequired", message);
});
program.command("init").description("Initialize a local workspace").action(async () => {
  await initWorkspace(process.cwd());
  console.log("Initialized workspace.");
});
const shows = program.command("show").description("Manage shows");
shows.command("list").description("List shows discovered in the management bucket").option("--include-deleted", "include deleted shows").option("--json", "output a machine-readable result").action(async (options: { includeDeleted?: boolean; json?: boolean }) => {
  try {
  const config = await readConfig(process.cwd()), secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !secrets.admin_token) throw new Error("Management URL and token must be configured");
  const result = await fetchShows(config.management_url, secrets.admin_token);
  const listed = result.shows.filter(show => !show.deleted || options.includeDeleted);
  if (result.issues.length) process.exitCode = 1;
  if (options.json) console.log(JSON.stringify({ version: 1, shows: listed, issues: result.issues, incomplete: result.issues.length > 0, exit_code: process.exitCode ?? 0 }));
  else {
    for (const show of listed) console.log(`${show.show_id} revision=${show.revision}${show.deleted ? " deleted" : ""}`);
    for (const item of result.issues) console.error(`${item.path}: ${item.message}`);
    if (result.issues.length) console.error("Show listing is incomplete.");
  }
  } catch (error) {
    if (!options.json) throw error;
    process.exitCode = 1;
    console.log(JSON.stringify({ version: 1, shows: [], issues: [], incomplete: true, error: { message: error instanceof Error ? error.message : String(error) }, exit_code: 1 }));
  }
});
shows.command("new").description("Create a local show draft").action(async () => {
  const id = await newShow(process.cwd());
  console.log(`Created ${id}/show.toml`);
});
shows.command("delete <show>").description("Delete a show and request withdrawal").option("--yes", "confirm deletion").option("--json", "output a machine-readable result").action(async (show: string, options: { yes?: boolean; json?: boolean }) => {
  await deleteEntity(process.cwd(), show, undefined, options.yes, options.json);
});
shows.command("upload-cover <show> <path>").description("Inspect and upload show artwork").option("--json", "output a machine-readable result").action(async (show: string, path: string, options: { json?: boolean }) => {
  await uploadCover(process.cwd(), show, path, options.json);
});
const episodes = program.command("episode").description("Manage episodes");
episodes.command("new <show>").description("Create a local episode draft").action(async (show: string) => {
  const id = await newEpisode(process.cwd(), show);
  console.log(`Created ${show}/${id}/episode.toml`);
});
episodes.command("upload-audio <show> <episode> <path>").description("Inspect and upload episode audio").option("--json", "output a machine-readable result").action(async (show: string, episode: string, path: string, options: { json?: boolean }) => {
  await uploadAudio(process.cwd(), show, episode, path, options.json);
});
episodes.command("delete <show> <episode>").description("Delete an episode and request withdrawal").option("--yes", "confirm deletion").option("--json", "output a machine-readable result").action(async (show: string, episode: string, options: { yes?: boolean; json?: boolean }) => {
  await deleteEntity(process.cwd(), show, episode, options.yes, options.json);
});
program.command("config").description("Manage nonsecret workspace settings").command("set <key> <value>").action(async (key: string, value: string) => {
  await setConfigValue(process.cwd(), key, value);
  console.log(`Updated ${key}.`);
});
program.command("auth").description("Manage user credentials").command("set <name>").action(async (name: string) => {
  if (!["admin_token", "r2_access_key_id", "r2_secret_access_key"].includes(name)) throw new UsageError("Unknown credential name");
  const value = await promptSecret(name);
  await setSecret(credentialsDirectory(), name, value);
  console.log(`Saved ${name}.`);
});
program.command("pull").description("Fetch accepted TOML metadata without downloading media").option("--show <show>", "show ID; omit to discover shows").option("--json", "output a machine-readable result").action(async (options: { show?: string; json?: boolean }) => {
  const reports: Record<string, unknown>[] = [];
  try {
  if (options.show !== undefined && !showIdPattern.test(options.show)) throw new UsageError("Invalid show ID");
  const root = process.cwd();
  const config = await readConfig(root);
  const secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !config.account_id || !config.management_bucket || !secrets.admin_token || !secrets.r2_access_key_id || !secrets.r2_secret_access_key) {
    throw new Error("Management URL, account ID, management bucket and credentials must be configured before pull");
  }
  const client = createR2Client({ accountId: config.account_id, bucket: config.management_bucket, endpoint: config.r2_endpoint,
    accessKeyId: secrets.r2_access_key_id, secretAccessKey: secrets.r2_secret_access_key });
  try {
    const shows = options.show ? [options.show] : await listCandidateShows(client, config.management_bucket);
    let failures = 0;
    for (const showId of shows) {
      try {
        const result = await pullShow(root, showId, { getPage: cursor => fetchSnapshotPage(config.management_url!, secrets.admin_token!, showId, cursor),
          readObject: ref => readR2Metadata(client, config.management_bucket!, ref) });
        reports.push({ show_id: showId, ...result });
        if (!options.json) {
          console.log(`Pulled ${showId}.`);
          for (const path of result.backups) console.log(`Preserved local edit: ${path}`);
          for (const path of result.tombstones) console.log(`Remote deletion; local file retained: ${showId}/${path}`);
        }
      } catch (error) {
        failures++;
        const message = error instanceof Error ? error.message : String(error);
        reports.push({ show_id: showId, error: { message } });
        if (!options.json) console.error(`${showId}: ${message}`);
      }
    }
    if (!shows.length && !options.json) console.log("No show prefixes found.");
    if (failures) { if (!options.json) console.error("Pull was incomplete; review the reported shows and retry."); process.exitCode = 1; }
  } finally { client.destroy(); }
  if (options.json) console.log(JSON.stringify({ version: 1, shows: reports, exit_code: process.exitCode ?? 0 }));
  } catch (error) {
    if (!options.json) throw error;
    process.exitCode = error instanceof UsageError ? 2 : 1;
    console.log(JSON.stringify({ version: 1, shows: reports, error: { message: error instanceof Error ? error.message : String(error) }, exit_code: process.exitCode }));
  }
});
program.command("check").description("Inspect validation and delivery status without changing state").option("--show <show>", "show ID; omit to discover shows").option("--delivery", "probe the last advertised feed and one audio range").option("--json", "output a machine-readable report").action(async (options: { show?: string; delivery?: boolean; json?: boolean }) => {
  try { await checkShows(process.cwd(), options.show, options.delivery, options.json); }
  catch (error) {
    if (!options.json) throw error;
    const code = error instanceof UsageError ? 2 : 1;
    console.log(JSON.stringify({ version: 1, checks: [], error: error instanceof Error ? error.message : String(error), exit_code: code }));
    process.exitCode = code;
  }
});
program.command("inventory").description("Inspect source objects and register attributable versions").option("--show <show>", "show ID; omit to discover shows").option("--json", "output a machine-readable result").action(async (options: { show?: string; json?: boolean }) => {
  try { await inventoryShows(process.cwd(), options.show, options.json); }
  catch (error) { if (!options.json) throw error; process.exitCode = error instanceof UsageError ? 2 : 1; console.log(JSON.stringify({ version: 1, shows: [], error: { message: error instanceof Error ? error.message : String(error) }, exit_code: process.exitCode })); }
});
program.command("export <file>").description("Export show metadata and source references without media bodies").option("--show <show>", "show ID; omit to export discovered shows").option("--json", "output a machine-readable result").action(async (file: string, options: { show?: string; json?: boolean }) => {
  try { await exportShows(process.cwd(), file, options.show, options.json); }
  catch (error) { if (!options.json) throw error; process.exitCode = error instanceof UsageError ? 2 : 1; console.log(JSON.stringify({ version: 1, path: file, error: { message: error instanceof Error ? error.message : String(error) }, exit_code: process.exitCode })); }
});
program.command("restore <file>").description("Restore metadata under a publication hold").option("--replace", "allow replacement of stopped shows").option("--yes", "confirm restore without a prompt").option("--json", "output a machine-readable result").action(async (file: string, options: { replace?: boolean; yes?: boolean; json?: boolean }) => {
  try { await restoreShows(process.cwd(), file, options.replace, options.yes, options.json); }
  catch (error) { if (!options.json) throw error; process.exitCode = error instanceof CancelledOperation ? 4 : error instanceof UsageError ? 2 : 1; console.log(JSON.stringify({ version: 1, shows: [], error: { message: error instanceof Error ? error.message : String(error) }, exit_code: process.exitCode })); }
});
program.command("restore-resume <show>").description("Preview and resume a restored show").option("--yes", "confirm resume without a prompt").option("--json", "output a machine-readable result").action(async (show: string, options: { yes?: boolean; json?: boolean }) => {
  await resumeRestore(process.cwd(), show, options.yes, options.json);
});
program.command("cleanup").description("Preview or remove old unreferenced private versions").requiredOption("--older-than <days>", "minimum age in full days").option("--show <show>", "show ID; omit to discover shows").option("--apply", "apply cleanup after confirmation").option("--yes", "confirm cleanup without a prompt").option("--json", "output a machine-readable result")
  .action(async (options: { olderThan: string; show?: string; apply?: boolean; yes?: boolean; json?: boolean }) => {
    if (!/^[1-9][0-9]*$/.test(options.olderThan)) {
      if (!options.json) throw new UsageError("--older-than must be a positive integer");
      process.exitCode = 2; console.log(JSON.stringify({ version: 1, error: { message: "--older-than must be a positive integer" }, exit_code: 2 })); return;
    }
    await cleanupShows(process.cwd(), Number(options.olderThan), options.show, options.apply, options.yes, options.json);
  });
program.command("recover <show>").description("Rebuild delivery from the latest accepted intent").option("--episode <episode>", "limit recovery to an episode").option("--json", "output a machine-readable result").action(async (show: string, options: { episode?: string; json?: boolean }) => {
  await recoverShow(process.cwd(), show, options.episode, options.json);
});
const delivery = program.command("delivery").description("Manage per-show delivery origins");
delivery.command("migrate <show>").requiredOption("--to <origin>", "configured HTTPS delivery origin").option("--yes", "confirm migration without a prompt").option("--json", "output a machine-readable result")
  .action(async (show: string, options: { to: string; yes?: boolean; json?: boolean }) => changeDelivery(process.cwd(), show, options.to, options.yes, options.json));
delivery.command("rollback <show>").option("--yes", "confirm rollback without a prompt").option("--json", "output a machine-readable result")
  .action(async (show: string, options: { yes?: boolean; json?: boolean }) => changeDelivery(process.cwd(), show, undefined, options.yes, options.json));
program.command("push").description("Upload changed TOML metadata").option("--show <show>", "show ID").option("--yes", "confirm a show stop").option("--json", "output a machine-readable result").action(async (options: { show?: string; yes?: boolean; json?: boolean }) => {
  const reports: Record<string, unknown>[] = [], normalizations: { path: string; timezone: string; backup: string | null }[] = [], idChanges: { show_id: string; old_episode_id: string; new_episode_id: string; backup: string }[] = [];
  const showIdChanges: { old_show_id: string; new_show_id: string; backups: string[] }[] = [];
  const log = (message: string) => { if (!options.json) console.log(message); };
  const report = (message: string) => { if (!options.json) console.error(message); };
  try {
  const root = process.cwd();
  const recovered = await recoverReidentification(root);
  if (recovered) {
    if (options.show === recovered.newId) options.show = recovered.oldId;
    log(`Restored interrupted ID change ${recovered.newId} to ${recovered.oldId}.`);
  }
  // Preflight all target TOML before uploading anything.
  const plans = await planMetadataPush(root, options.show);
  await assertNoPendingOperations(root, plans.filter(plan => plan.show || plan.episodes.length).map(plan => plan.showId));
  const config = await readConfig(root);
  const secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !config.account_id || !config.management_bucket || !secrets.admin_token || !secrets.r2_access_key_id || !secrets.r2_secret_access_key) throw new Error("Management URL, account ID, management bucket and credentials must be configured before push");
  const client = createR2Client({ accountId: config.account_id, bucket: config.management_bucket, endpoint: config.r2_endpoint, accessKeyId: secrets.r2_access_key_id, secretAccessKey: secrets.r2_secret_access_key });
  let failures = 0;
  try {
    const preparedPlans = [];
    for (const plan of plans) {
      if (!plan.show && !plan.episodes.length) continue;
      const previous = plan.baseline?.files["show.toml"];
      if (plan.baseline && !previous) throw new Error(`${plan.showId}: previous show metadata is unavailable; pull before updating`);
      let showSource = plan.showSource?.bytes;
      if (!showSource && previous) showSource = (await readR2Metadata(client, config.management_bucket, previous.ref)).bytes;
      if (!showSource) throw new Error(`${plan.showId}: show metadata is unavailable`);
      const show = showSchema.parse(parseToml(new TextDecoder("utf-8", { fatal: true }).decode(showSource)));
      let confirmed = false;
      if (plan.show && previous && show.publish !== true) {
        const prior = await readR2Metadata(client, config.management_bucket, previous.ref);
        const oldShow = showSchema.parse(parseToml(new TextDecoder("utf-8", { fatal: true }).decode(prior.bytes)));
        if (oldShow.publish === true) {
          if (options.yes) confirmed = true;
          else {
            if (options.json || !process.stdin.isTTY || !process.stdout.isTTY) throw new CancelledOperation("Stopping a show requires confirmation; pass --yes in noninteractive mode");
            const prompt = createInterface({ input: process.stdin, output: process.stdout });
            try { confirmed = /^(?:y|yes)$/i.test((await prompt.question(`Stop show ${plan.showId}? [y/N] `)).trim()); }
            finally { prompt.close(); }
            if (!confirmed) throw new CancelledOperation("Show stop cancelled");
          }
        }
      }
      const episodes = [];
      for (const file of plan.episodes) {
        const baseline = plan.baseline?.files[`${file.episodeId}/episode.toml`];
        let previousTimezone: string | undefined;
        if (baseline) {
          const old = await readR2Metadata(client, config.management_bucket, baseline.ref);
          previousTimezone = episodeSchema.parse(parseToml(new TextDecoder("utf-8", { fatal: true }).decode(old.bytes))).timezone;
        }
        const preview = prepareTimezoneNormalization(file.bytes, baseline ? undefined : show.timezone, previousTimezone);
        episodes.push({ file, baseline, preview });
      }
      preparedPlans.push({ plan, confirmed, episodes });
    }
    // Normalization can rewrite comments/formatting; preserve every original before upload.
    for (const prepared of preparedPlans) for (const episode of prepared.episodes) {
      if (!episode.preview.insertedTimezone) continue;
      log(`Adding timezone ${episode.preview.insertedTimezone} to ${episode.file.path}; TOML formatting and comments may change.`);
      const backup = await applyTimezoneNormalization(episode.file.path, episode.preview);
      normalizations.push({ path: episode.file.path, timezone: episode.preview.insertedTimezone, backup });
      if (backup) log(`Preserved original: ${backup}`);
    }
    for (let index = 0; index < preparedPlans.length; index++) {
      const prepared = preparedPlans[index]!;
      const { plan, confirmed, episodes } = prepared;
      const operationId = crypto.randomUUID();
      let result: OperationResponse | undefined, receiptSaved = false;
      try {
        const showRef = plan.show ? await putR2Metadata(client, config.management_bucket, `${plan.showId}/_versions/${operationId}/show.toml`, plan.show.bytes) : null;
        const episodeEdits: Extract<Operation, { action: "metadata.batch" }>["payload"]["episodes"] = [];
        for (const episode of episodes) {
          const episodeId = episode.file.episodeId!;
          const ref = await putR2Metadata(client, config.management_bucket, `${plan.showId}/${episodeId}/_versions/${operationId}/episode.toml`, episode.preview.normalized);
          const metadata = { ...ref, sha256: ref.sha256! };
          episodeEdits.push(episode.baseline ? { mode: "update", episode_id: episodeId, metadata } : { mode: "create", episode_id: episodeId, metadata, guid: newGuid() });
        }
        const operation: Operation = { protocol_version: 1, operation_id: operationId, expected_revision: plan.baseline?.revision ?? 0, action: "metadata.batch",
          payload: { ...(showRef ? { show: { mode: plan.baseline ? "update" as const : "create" as const, metadata: { ...showRef, sha256: showRef.sha256! } } } : {}), episodes: episodeEdits, ...(confirmed ? { confirm_show_stop: true as const } : {}) } };
        await savePendingOperation(root, plan.showId, operation);
        receiptSaved = true;
        try { result = await submitOperation(config.management_url, secrets.admin_token, plan.showId, operation); }
        catch (error) {
          if (error instanceof RejectedOperationError) { await removeRejectedReceipt(root, operationId, error); receiptSaved = false; }
          else report(`Retained operation ${operationId}; use castloop operation retry ${operationId}.`);
          throw error;
        }
        const baselineUpdated = await recordAcceptedOperation(root, plan.showId, operation, result.accepted_revision);
        await removePendingOperation(root, operationId);
        receiptSaved = false;
        reports.push({ show_id: plan.showId, result, baseline_updated: baselineUpdated });
        log(`Saved ${plan.showId} at revision ${result.accepted_revision}; delivery: ${result.delivery}.`);
        if (result.delivery === "pending") log(`Delivery is incomplete; run castloop check --show ${plan.showId}, then castloop recover ${plan.showId} if still pending.`);
        if (!baselineUpdated) log("Local metadata baseline is older; run pull before editing or pushing.");
        for (const issue of result.validation_issues) report(`${issue.path}: ${issue.message}`);
        if (result.validation_issues.some(issue => issue.severity === "error")) { failures++; process.exitCode = Math.max(Number(process.exitCode ?? 0), 2); }
        else if (result.delivery === "blocked" || result.delivery === "failed" || result.delivery === "pending") { failures++; process.exitCode = Math.max(Number(process.exitCode ?? 0), 1); }
      } catch (error) {
        if (error instanceof RejectedOperationError && error.status === 409 && error.code === "revision_conflict" && error.operationMatched && !receiptSaved && !plan.baseline && plan.show && showIdChanges.length < 10) {
          // A revision conflict alone is not an ID collision. Confirm that the
          // target Show exists before moving any local draft.
          const snapshot = await collectSnapshot(plan.showId, cursor => fetchSnapshotPage(config.management_url!, secrets.admin_token!, plan.showId, cursor));
          if (snapshot.revision > 0) {
            const oldId = plan.showId;
            const changed = await reidentifyShowDraft(root, oldId, plan.show.bytes, episodes.map(episode => ({ episodeId: episode.file.episodeId!, bytes: episode.preview.normalized })));
            plan.showId = changed.showId;
            plan.show = { ...plan.show, showId: changed.showId, path: join(root, changed.showId, "show.toml"), bytes: changed.show };
            plan.showSource = plan.show;
            for (const episode of episodes) {
              const value = changed.episodes.find(item => item.episodeId === episode.file.episodeId)!;
              episode.file = { ...episode.file, showId: changed.showId, path: join(root, changed.showId, value.episodeId, "episode.toml"), bytes: value.bytes };
              episode.preview = { original: value.bytes, normalized: value.bytes, insertedTimezone: null };
            }
            showIdChanges.push({ old_show_id: oldId, new_show_id: changed.showId, backups: changed.backups });
            log(`Show ID ${oldId} was already in use; created ${changed.showId}. Original TOML files were backed up.`);
            preparedPlans.splice(index + 1, 0, prepared);
            continue;
          }
        }
        const match = error instanceof RejectedOperationError && error.status === 409 && error.code === "identity_conflict" && error.operationMatched && !receiptSaved
          ? /^episodes\.(e-[0-9abcdefghjkmnpqrstvwxyz]{8})\.id$/.exec(error.path) : null;
        const conflicted = match ? episodes.find(episode => !episode.baseline && episode.file.episodeId === match[1]) : undefined;
        if (conflicted && idChanges.filter(change => change.show_id === plan.showId).length < 10) {
          const oldId = conflicted.file.episodeId!;
          const changed = await reidentifyEpisodeDraft(root, plan.showId, oldId, conflicted.preview.normalized);
          conflicted.file = { ...conflicted.file, path: changed.path, episodeId: changed.episodeId, bytes: changed.bytes };
          conflicted.preview = { original: changed.bytes, normalized: changed.bytes, insertedTimezone: null };
          idChanges.push({ show_id: plan.showId, old_episode_id: oldId, new_episode_id: changed.episodeId, backup: changed.backup });
          log(`Episode ID ${oldId} was already in use; created ${changed.episodeId}. Original TOML: ${changed.backup}`);
          preparedPlans.splice(index + 1, 0, prepared);
          continue;
        }
        failures++;
        if (!options.json) reportAcceptedLocalFailure(result, receiptSaved);
        const message = error instanceof Error ? error.message : String(error);
        const rejection = error instanceof RejectedReceiptCleanupError ? error.rejection : error instanceof RejectedOperationError ? error : undefined;
        reports.push({ show_id: plan.showId, ...(receiptSaved || result || rejection ? { operation_id: operationId } : {}), ...(result ? { result } : {}),
          acceptance: result?.acceptance ?? (rejection ? "rejected" : error instanceof UncertainOperationError ? "unknown" : "not_submitted"),
          receipt_retained: receiptSaved, error: { message, ...(rejection ? { code: rejection.code, status: rejection.status, ...(rejection.path ? { path: rejection.path } : {}) } : {}) } });
        report(`${plan.showId}: ${message}`);
        const code = error instanceof RejectedOperationError ? error.status === 409 ? 3 : [400, 413].includes(error.status) ? 2 : 1 : 1;
        process.exitCode = Math.max(Number(process.exitCode ?? 0), code);
      }
    }
    if (!preparedPlans.length) log("No changed metadata.");
    if (failures) report("Push was incomplete; review the reported shows.");
  } finally { client.destroy(); }
  if (options.json) console.log(JSON.stringify({ version: 1, shows: reports, normalizations, id_changes: idChanges, show_id_changes: showIdChanges, exit_code: Number(process.exitCode ?? 0) }));
  } catch (error) {
    if (!options.json) throw error;
    const code = error instanceof CancelledOperation ? 4 : error instanceof MetadataPreflightError || error instanceof UsageError ? 2 : 1;
    process.exitCode = code;
    console.log(JSON.stringify({ version: 1, shows: reports, normalizations, id_changes: idChanges, show_id_changes: showIdChanges, error: { message: error instanceof Error ? error.message : String(error) }, exit_code: code }));
  }
});
const operations = program.command("operation").description("Manage uncertain operations");
operations.command("recover-local").description("Restore a local ID change interrupted before completion").option("--json", "output a machine-readable result").action(async (options: { json?: boolean }) => {
  try {
    const recovered = await recoverReidentification(process.cwd());
    if (options.json) console.log(JSON.stringify({ version: 1, recovered, exit_code: 0 }));
    else if (recovered) console.log(`Restored interrupted ID change ${recovered.newId} to ${recovered.oldId}.`);
    else console.log("No interrupted ID change.");
  } catch (error) {
    if (!options.json) throw error;
    process.exitCode = 1;
    console.log(JSON.stringify({ version: 1, recovered: null, error: { message: error instanceof Error ? error.message : String(error) }, exit_code: 1 }));
  }
});
operations.command("retry <operation-id>").description("Replay a saved operation exactly").option("--json", "output a machine-readable result").action(async (operationId: string, options: { json?: boolean }) => {
  let result: OperationResponse | undefined;
  let showId: string | undefined;
  let receiptSaved = false;
  try {
    const root = process.cwd();
    const receipt = await readPendingOperation(root, operationId);
    receiptSaved = true;
    showId = receipt.show_id;
    const config = await readConfig(root);
    const secrets = await readSecrets(credentialsDirectory());
    if (!config.management_url || !secrets.admin_token) throw new Error("Management URL and token must be configured");
    result = await submitOperation(config.management_url, secrets.admin_token, receipt.show_id, receipt.operation);
    const baselineUpdated = await recordAcceptedOperation(root, receipt.show_id, receipt.operation, result.accepted_revision);
    await removePendingOperation(root, operationId);
    receiptSaved = false;
    if (result.validation_issues.some(issue => issue.severity === "error")) process.exitCode = 2;
    else if (result.delivery === "failed" || result.delivery === "pending" || (result.delivery === "blocked" && receipt.operation.action !== "restore")) process.exitCode = 1;
    if (options.json) console.log(JSON.stringify({ version: 1, show_id: showId, result, baseline_updated: baselineUpdated, exit_code: process.exitCode ?? 0 }));
    else {
      console.log(`Operation ${operationId} accepted at revision ${result.accepted_revision}; delivery: ${result.delivery}.`);
      if (result.delivery === "pending") console.log(`Delivery is incomplete; run castloop check --show ${showId}, then castloop recover ${showId} if still pending.`);
      if (!baselineUpdated) console.log("Local metadata baseline is older; run pull before editing or pushing.");
      for (const issue of result.validation_issues) console.error(`${issue.path}: ${issue.message}`);
    }
  } catch (error) {
    if (error instanceof RejectedOperationError && receiptSaved) {
      try { await removeRejectedReceipt(process.cwd(), operationId, error); receiptSaved = false; }
      catch (cleanupError) { error = cleanupError; }
    }
    if (!options.json) { reportAcceptedLocalFailure(result, receiptSaved); throw error; }
    const rejection = error instanceof RejectedReceiptCleanupError ? error.rejection : error instanceof RejectedOperationError ? error : undefined;
    const code = error instanceof UsageError ? 2 : error instanceof RejectedOperationError ? error.status === 409 ? 3 : [400, 413].includes(error.status) ? 2 : 1 : 1;
    console.log(JSON.stringify({ version: 1, show_id: showId ?? null, operation_id: operationId, ...(result ? { result } : {}),
      acceptance: result?.acceptance ?? (rejection ? "rejected" : error instanceof UncertainOperationError ? "unknown" : "not_submitted"),
      receipt_retained: receiptSaved, error: { message: error instanceof Error ? error.message : String(error), ...(rejection ? { code: rejection.code, status: rejection.status, ...(rejection.path ? { path: rejection.path } : {}) } : {}) }, exit_code: code }));
    process.exitCode = code;
  }
});

operations.command("abandon <operation-id>").description("Stop retrying an uncertain operation and keep its local record").option("--yes", "confirm without a prompt").option("--json", "output a machine-readable result").action(async (operationId: string, options: { yes?: boolean; json?: boolean }) => {
  let showId: string | undefined;
  try {
    const root = process.cwd();
    const receipt = await readPendingOperation(root, operationId);
    showId = receipt.show_id;
    if (options.json && !options.yes) throw new CancelledOperation("Abandoning an operation requires --yes in JSON mode");
    await confirmAction(`Stop retrying operation ${operationId}? It may already have been accepted`, options.yes);
    await abandonPendingOperation(root, operationId);
    if (options.json) console.log(JSON.stringify({ version: 1, operation_id: operationId, show_id: showId, abandoned: true, exit_code: 0 }));
    else console.log(`Stopped retrying ${operationId}; its local record is in .castloop/abandoned/. Run castloop pull --show ${showId} to refresh the remote state.`);
  } catch (error) {
    if (!options.json) throw error;
    const code = error instanceof CancelledOperation ? 4 : error instanceof UsageError ? 2 : 1;
    process.exitCode = code;
    console.log(JSON.stringify({ version: 1, operation_id: operationId, show_id: showId ?? null, abandoned: false, error: { message: error instanceof Error ? error.message : String(error) }, exit_code: code }));
  }
});

try { await program.parseAsync(); }
catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.code === "castloop.recoveryRequired" ? 1 : error.exitCode === 0 ? 0 : 2;
  else { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = error instanceof CancelledOperation ? 4 : error instanceof MetadataPreflightError || error instanceof UsageError ? 2 : error instanceof RejectedOperationError && error.status === 409 ? 3 : 1; }
}
