import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { configuredHttpsOrigin } from "@castloop/domain";
import { canonicalJson, cleanupClaimSchema, cleanupCompleteSchema, inventoryRegisterSchema, operationSchema, recoverRequestSchema, restoreRequestSchema, restoreResumeRequestSchema, showIdPattern, type CleanupClaim, type CleanupComplete, type InventoryRegister, type Operation, type RecoverRequest, type RestoreRequest, type RestoreResumeRequest } from "@castloop/domain";
import { commitAcceptance, CreationCollision, IdentityConflict, initializeSchema, lookupReceipt, nextScheduledAlarm, readShowControl, readSnapshot, RevisionConflict, SnapshotChanged, SnapshotNotFound } from "./storage";
import { acceptShowMetadata, checkShow, UnsupportedOperation, ValidationFailure } from "./show";
import { applyCandidate, hasCurrentWithdrawal, stoppedWithdrawalIdentity, withdrawDeletedShow } from "./publication";
import { prepareCandidate } from "./candidate";
import { SourceIdentityError, SourceMetadataError } from "./objects";
import { claimCleanup, completeCleanupKeys } from "./cleanup";
import { readInventory, registerInventory } from "./inventory";
import { exportShow } from "./export";
import { acceptRestore } from "./restore";
import { notifyFailures, sendFailureNotice, type FailureNotice } from "./notification";
import { configuredRestoreOrigins, probeCustomDelivery, purgeZonePaths } from "./delivery";

/** Private service entrypoint; no recipient or sender is supplied by the caller. */
export class Notifier extends WorkerEntrypoint<Env> {
  send(notice: FailureNotice) {
    return sendFailureNotice(this.env.EMAIL, this.env.EMAIL_FROM, this.env.EMAIL_TO, notice);
  }
}

/** Only delivery routing facts are exposed through this private binding. */
export class Routing extends WorkerEntrypoint<Env> {
  async route(showId: string) {
    if (!showIdPattern.test(showId)) return { state: "missing" as const, base: null };
    return this.env.SHOWS.getByName(showId).publicRoute(showId);
  }
}

/** Per-show storage host; management routes are added with their acceptance checks. */
export class ShowDO extends DurableObject<Env> {
  private runner?: Promise<"applied" | "scheduled" | "failed" | "pending" | "blocked">;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => initializeSchema(ctx.storage));
  }

  async publicRoute(showId: string): Promise<{ state: "serve" | "missing" | "redirect"; base: string | null }> {
    const control = readShowControl(this.ctx.storage, showId);
    if (!control?.metadata || !control.revision || control.deleted || control.restore_hold) return { state: "missing", base: null };
    if (await hasCurrentWithdrawal(this.ctx.storage, showId)) return { state: "missing", base: null };
    const current = readShowControl(this.ctx.storage, showId);
    if (!current || current.revision !== control.revision) throw new Error("Show changed during route lookup");
    if (current.current_delivery.base === configuredHttpsOrigin(this.env.DELIVERY_BASE)) return { state: "serve", base: null };
    if (current.current_delivery.base !== configuredHttpsOrigin(this.env.CUSTOM_DELIVERY_BASE)) throw new Error("Delivery origin is not configured");
    return { state: "redirect", base: current.current_delivery.base };
  }

  snapshot(showId: string, cursor?: string) {
    try { return { ok: true as const, data: readSnapshot(this.ctx.storage, showId, cursor) }; }
    catch (error) {
      if (error instanceof SnapshotChanged) return { ok: false as const, status: 409, code: "snapshot_revision_changed", message: error.message };
      if (error instanceof SnapshotNotFound) return { ok: false as const, status: 404, code: "not_found", message: error.message };
      if (error instanceof IdentityConflict) return { ok: false as const, status: 400, code: "malformed_input", message: error.message };
      throw error;
    }
  }

  cleanupClaim(showId: string, raw: CleanupClaim) {
    const request = cleanupClaimSchema.parse(raw);
    const now = Date.now();
    const result = claimCleanup(this.ctx.storage, showId, request.operation_id, request.candidates, request.older_than_days, now);
    return { protocol_version: 1 as const, show_id: showId, operation_id: request.operation_id, cutoff_at: now - request.older_than_days * 86400000,
      claimed: result.claimed, skipped: result.skipped.map(item => ({ key: item.key, issues: [item.reason] })) };
  }

  async cleanupComplete(showId: string, raw: CleanupComplete) {
    const request = cleanupCompleteSchema.parse(raw);
    const result = await completeCleanupKeys(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId, request.operation_id, request.keys);
    return { protocol_version: 1 as const, show_id: showId, operation_id: request.operation_id, ...result };
  }

  inventory(showId: string, cursor?: string) {
    try { return { ok: true as const, data: readInventory(this.ctx.storage, showId, cursor) }; }
    catch (error) { if (error instanceof IdentityConflict) return { ok: false as const, message: error.message }; throw error; }
  }

  async inventoryRegister(showId: string, raw: InventoryRegister) {
    const input = inventoryRegisterSchema.parse(raw);
    const result = await registerInventory(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId, input.objects);
    return { protocol_version: 1 as const, show_id: showId, ...result };
  }

  async exportSnapshot(showId: string) {
    try { return { ok: true as const, data: await exportShow(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId) }; }
    catch (error) {
      if (error instanceof SnapshotNotFound) return { ok: false as const, status: 404, code: "not_found", message: error.message };
      console.error(JSON.stringify({ event: "export_failed", show_id: showId, message: error instanceof Error ? error.message : "unknown" }));
      return { ok: false as const, status: 503, code: "dependency_unavailable", message: "Export is unavailable or required source objects do not match" };
    }
  }

  async restore(showId: string, request: RestoreRequest) {
    const input = restoreRequestSchema.parse(request);
    const operation: Extract<Operation, { action: "restore" }> = { protocol_version: 1, action: "restore", operation_id: input.operation_id,
      expected_revision: input.expected_revision, payload: { snapshot: input.snapshot, replace: input.replace, confirmed: input.confirmed } };
    try {
      const data = await acceptRestore(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId, operation, this.env.R2_MANAGEMENT_BUCKET, this.env.R2_DELIVERY_BUCKET, () => !!this.runner);
      return { ok: true as const, data };
    } catch (error) {
      if (error instanceof RevisionConflict) return { ok: false as const, status: 409, code: "revision_conflict", message: error.message };
      if (error instanceof IdentityConflict) return { ok: false as const, status: 409, code: "identity_conflict", message: error.message };
      console.error(JSON.stringify({ event: "restore_failed", show_id: showId, message: error instanceof Error ? error.message : "unknown" }));
      return { ok: false as const, status: 400, code: "malformed_input", message: "Restore data is invalid or unavailable" };
    }
  }

  async restorePreview(showId: string) {
    const control = readShowControl(this.ctx.storage, showId);
    if (!control || !control.metadata || !control.revision) return { ok: false as const, status: 404, code: "not_found", message: "Show not found" };
    if (!control.restore_hold) return { ok: false as const, status: 409, code: "identity_conflict", message: "Show is not awaiting restore resume" };
    try {
      const candidate = await prepareCandidate(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId, Date.now(), true, true);
      try {
        if (readShowControl(this.ctx.storage, showId)?.revision !== candidate.revision) return { ok: false as const, status: 409, code: "revision_conflict", message: "Show changed during preview" };
        return { ok: true as const, data: { protocol_version: 1 as const, show_id: showId, revision: candidate.revision, state: candidate.state,
          issues: candidate.state === "hold" ? candidate.issues : [], episodes: candidate.episodes.map(item => ({ id: item.id, state: item.state, at: item.at ?? null, issues: item.issues ?? [] })) } };
      } finally { candidate.release(); }
    } catch (error) {
      console.error(JSON.stringify({ event: "restore_preview_failed", show_id: showId, message: error instanceof Error ? error.message : "unknown" }));
      return { ok: false as const, status: 503, code: "dependency_unavailable", message: "Restore preview unavailable" };
    }
  }

  async restoreResume(showId: string, raw: RestoreResumeRequest) {
    const request = restoreResumeRequestSchema.parse(raw);
    const operation: Extract<Operation, { action: "restore-resume" }> = { protocol_version: 1, action: "restore-resume", operation_id: request.operation_id,
      expected_revision: request.expected_revision, payload: { confirmed: true } };
    let accepted = false;
    try {
      const before = readShowControl(this.ctx.storage, showId);
      if ((before?.revision ?? 0) !== request.expected_revision) {
        const receipt = await lookupReceipt(this.ctx.storage, showId, operation);
        if (receipt) return { ok: true as const, data: receipt };
        throw new RevisionConflict("Show revision changed; preview again");
      }
      if (!before?.metadata || !before.restore_hold) throw new IdentityConflict("Show is not awaiting restore resume");
      if (this.runner) throw new IdentityConflict("Publication is running; retry later");
      const candidate = await prepareCandidate(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId, Date.now(), true, true);
      let withdrawalIdentity: string | null = null;
      try {
        if (candidate.state === "hold") return { ok: false as const, status: 400, code: "publication_invalid", message: "Repair Show validation errors before resuming" };
        if (candidate.state === "ready" && !configuredRestoreOrigins(before.current_delivery.base, before.pending_delivery?.base ?? null, this.env.DELIVERY_BASE, this.env.CUSTOM_DELIVERY_BASE)) {
          return { ok: false as const, status: 409, code: "identity_conflict", message: "Restored delivery origins do not match this installation; configure them before resuming" };
        }
        if (candidate.state === "withdraw") {
          withdrawalIdentity = before.deleted ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson({ version: 1, show_id: showId, deleted: true })))), byte => byte.toString(16).padStart(2, "0")).join("") : await stoppedWithdrawalIdentity(showId, before.metadata);
        }
        const data = await commitAcceptance(this.ctx.storage, showId, operation, (sql, current, revision) => {
          if (!current || !current.restore_hold || current.revision !== candidate.revision || this.runner) throw new IdentityConflict("Restore state changed or publication is running");
          current.restore_hold = false; current.revision = revision; current.accepted_at = Date.now();
          current.scheduling = { enabled: candidate.state === "ready", serial: candidate.state === "ready" && candidate.serial === true };
          // Imported references describe delivery before the export; the target
          // was stopped before restore, so rebuild public objects from scratch.
          sql.exec("DELETE FROM delivery_refs");
          for (const item of candidate.episodes) {
            const episodeRow = sql.exec<{ record_json: string }>("SELECT record_json FROM episodes WHERE episode_id = ?", item.id).one();
            const episode = JSON.parse(episodeRow.record_json) as { scheduling?: { ready: boolean; serial_ready: boolean } };
            episode.scheduling = { ready: item.state === "eligible" || item.state === "scheduled", serial_ready: item.serialReady === true };
            sql.exec("UPDATE episodes SET record_json = ? WHERE episode_id = ?", JSON.stringify(episode), item.id);
            if (item.state !== "scheduled") continue;
            const row = sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ?", item.id).toArray()[0];
            if (row) {
              const outcome = JSON.parse(row.record_json) as { state: string; desired_identity: string; error: unknown; notification: unknown; trigger: string };
              if (outcome.state === "failed" && outcome.desired_identity === item.desiredIdentity) {
                outcome.state = "pending"; outcome.error = null; outcome.notification = null; outcome.trigger = "restore-resume";
                sql.exec("UPDATE publication_outcomes SET state = 'pending', record_json = ? WHERE target = ?", JSON.stringify(outcome), item.id);
              }
            }
          }
          if (withdrawalIdentity) {
            const outcome = { record_version: 1, target: "show-withdrawal", desired_identity: withdrawalIdentity, applied_identity: null, attempt_revision: null, state: "pending", trigger: "restore-resume", error: null, notification: null };
            sql.exec("INSERT INTO publication_outcomes VALUES ('show-withdrawal', 'pending', ?) ON CONFLICT(target) DO UPDATE SET state = excluded.state, record_json = excluded.record_json", JSON.stringify(outcome));
          }
          return { control: current, issues: [], delivery: "pending" as const, alarm: nextScheduledAlarm(sql, current, Date.now()) };
        });
        accepted = true;
        if (data.acceptance === "accepted") {
          let delivery: "applied" | "scheduled" | "failed" | "pending" | "blocked" = "pending";
          try { delivery = await this.runPublication(showId, "recover"); }
          catch (error) { console.error(JSON.stringify({ event: "restore_resume_publication_unavailable", show_id: showId, message: error instanceof Error ? error.message : "unknown" })); }
          data.delivery = this.ctx.storage.transactionSync(() => {
            const current = readShowControl(this.ctx.storage, showId);
            if (!current || current.revision !== data.accepted_revision) return "pending";
            if (current.last_receipt?.response.accepted_revision === data.accepted_revision) {
              current.last_receipt.response.delivery = delivery;
              this.ctx.storage.sql.exec("UPDATE show_control SET record_json = ? WHERE singleton = 1", JSON.stringify(current));
            }
            return delivery;
          });
        }
        return { ok: true as const, data };
      } finally { candidate.release(); }
    } catch (error) {
      if (accepted) throw error;
      if (error instanceof RevisionConflict) return { ok: false as const, status: 409, code: "revision_conflict", message: error.message };
      if (error instanceof IdentityConflict) return { ok: false as const, status: 409, code: "identity_conflict", message: error.message };
      console.error(JSON.stringify({ event: "restore_resume_failed", show_id: showId, message: error instanceof Error ? error.message : "unknown" }));
      return { ok: false as const, status: 503, code: "dependency_unavailable", message: "Restore resume unavailable" };
    }
  }

  async operation(showId: string, raw: Operation) {
    try {
      const operation = operationSchema.parse(raw);
      const data = operation.action === "delivery.set"
        ? await this.acceptDelivery(showId, operation)
        : await acceptShowMetadata(this.ctx.storage, this.env.MANAGEMENT_BUCKET, this.env.DELIVERY_BASE, showId, operation);
      if (data.acceptance === "accepted") {
        let delivery: "applied" | "scheduled" | "failed" | "pending" | "blocked" = "pending";
        try { delivery = await this.runPublication(showId, "acceptance"); }
        catch (error) {
          // Acceptance already committed. Never turn an executor exception into
          // a rejected operation or encourage replay under a fresh identity.
          console.error(JSON.stringify({ event: "publication_executor_unavailable", show_id: showId, error: error instanceof Error ? error.message : "unknown" }));
        }
        data.delivery = this.ctx.storage.transactionSync(() => {
          const current = readShowControl(this.ctx.storage, showId);
          if (!current || current.revision !== data.accepted_revision) return "pending";
          if (current.last_receipt?.response.accepted_revision === data.accepted_revision) {
            current.last_receipt.response.delivery = delivery;
            this.ctx.storage.sql.exec("UPDATE show_control SET record_json = ? WHERE singleton = 1", JSON.stringify(current));
          }
          return delivery;
        });
      }
      return { ok: true as const, data };
    }
    catch (error) {
      if (error instanceof RevisionConflict) return { ok: false as const, status: 409, code: "revision_conflict", message: error.message };
      if (error instanceof CreationCollision) return { ok: false as const, status: 409, code: "identity_conflict", message: error.message, path: error.path };
      if (error instanceof IdentityConflict || error instanceof SourceIdentityError) return { ok: false as const, status: 409, code: "identity_conflict", message: error.message };
      if (error instanceof SourceMetadataError) return { ok: false as const, status: 400, code: "malformed_input", message: error.message };
      if (error instanceof ValidationFailure) return { ok: false as const, status: 400, code: "publication_invalid", message: error.message };
      if (error instanceof UnsupportedOperation) return { ok: false as const, status: 503, code: "dependency_unavailable", message: error.message };
      throw error;
    }
  }

  private async acceptDelivery(showId: string, operation: Extract<Operation, { action: "delivery.set" }>) {
    const receipt = await lookupReceipt(this.ctx.storage, showId, operation);
    if (receipt) return receipt;
    const control = readShowControl(this.ctx.storage, showId);
    if ((control?.revision ?? 0) !== operation.expected_revision) throw new RevisionConflict("Show changed; check and retry");
    if (!control?.metadata || control.deleted || control.restore_hold || await hasCurrentWithdrawal(this.ctx.storage, showId)) throw new IdentityConflict("Show must be active before migration");
    const target = operation.payload.target_base;
    const workersBase = configuredHttpsOrigin(this.env.DELIVERY_BASE), customBase = configuredHttpsOrigin(this.env.CUSTOM_DELIVERY_BASE);
    if (target !== workersBase && target !== customBase) throw new ValidationFailure("Destination is not configured for this installation");
    if (target === control.current_delivery.base && !control.pending_delivery) throw new IdentityConflict("Destination is already current");
    if (this.runner) throw new IdentityConflict("Publication is running; retry later");
    const candidate = await prepareCandidate(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId, Date.now());
    try {
      const checked = await checkShow(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId);
      if (candidate.state !== "ready" || candidate.episodes.some(item => item.state === "invalid") || checked.issues.some(item => item.severity === "error")) throw new ValidationFailure("Repair Show and Episode validation errors before migration");
      if (target === customBase) {
        const refs = this.ctx.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM delivery_refs WHERE target != 'feed' ORDER BY target").toArray();
        const prefix = `/${showId}/`;
        const audio = refs.flatMap(row => {
          const record = JSON.parse(row.record_json) as { public_paths?: string[] };
          return Array.isArray(record.public_paths) ? record.public_paths.filter(path => typeof path === "string" && path.startsWith(prefix) && path.endsWith("/audio.mp3")) : [];
        })[0];
        if (!audio) throw new ValidationFailure("Migration requires a published audio object for destination verification");
        try {
          await probeCustomDelivery(target, this.env.CUSTOM_DELIVERY_BASE, audio);
          const token = (this.env as Env & { ZONE_PURGE_TOKEN?: string }).ZONE_PURGE_TOKEN ?? "";
          await purgeZonePaths({ base: target, configuredBase: this.env.CUSTOM_DELIVERY_BASE, zoneId: this.env.CUSTOM_ZONE_ID, token }, [`/${showId}/feed.xml`]);
        } catch (error) {
          console.error(JSON.stringify({ event: "custom_delivery_preflight_failed", show_id: showId, error: error instanceof Error ? error.message : "unknown" }));
          throw new UnsupportedOperation("Custom-domain access, cache or purge preflight failed");
        }
      }
      return await commitAcceptance(this.ctx.storage, showId, operation, (_sql, current, revision) => {
        if (!current || current.deleted || current.restore_hold || current.revision !== candidate.revision || this.runner) throw new IdentityConflict("Show changed or publication is running");
        current.revision = revision; current.accepted_at = Date.now();
        current.pending_delivery = { base: target, migration_operation_id: operation.operation_id, accepted_revision: revision };
        return { control: current, issues: [], delivery: "pending" };
      });
    } finally { candidate.release(); }
  }

  async alarm(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ show_id: string }>("SELECT show_id FROM show_control WHERE singleton = 1").toArray()[0];
    if (!row) return;
    try {
      if (this.runner) {
        // The running batch may have captured an older revision or a time
        // before this reservation became due. Wait for it, then preserve a
        // due, still-pending reservation for a separate alarm invocation.
        await this.runner.catch(() => {});
        await this.ctx.storage.transaction(async () => {
          const control = readShowControl(this.ctx.storage, row.show_id);
          if (!control) return;
          const now = Date.now();
          const due = nextScheduledAlarm(this.ctx.storage.sql, control, now, true);
          if (due === null || due > now) return;
          const existing = await this.ctx.storage.getAlarm();
          const recheck = now + 1000;
          if (existing === null || existing > recheck) await this.ctx.storage.setAlarm(recheck);
        });
        return;
      }
      await this.runPublication(row.show_id, "alarm");
    }
    catch (error) { console.error(JSON.stringify({ event: "alarm_execution_failed", show_id: row.show_id, error: error instanceof Error ? error.message : "unknown" })); }
  }

  private async runPublication(showId: string, trigger: "acceptance" | "alarm" | "recover", episodeId?: string) {
    // An in-flight batch captured an earlier intent. Its result cannot describe
    // a newly accepted revision; leave that revision pending for recovery.
    if (this.runner) return trigger === "alarm" ? this.runner : "pending" as const;
    const running = this.publishOnce(showId, trigger, episodeId);
    this.runner = running;
    try {
      const result = await running;
      if (result === "failed" && this.env.EMAIL_FROM && this.env.EMAIL_TO) {
        // Publication may capture a newer revision after an await, and another
        // update may be accepted after it records failure. Use each persisted
        // failure's own revision instead of guessing from current Show state.
        try { await notifyFailures(this.ctx.storage, showId, undefined, notice => this.env.NOTIFIER.send(notice)); }
        catch { console.error(JSON.stringify({ event: "notification_dispatch_failed", show_id: showId })); }
      }
      return result;
    } finally { if (this.runner === running) this.runner = undefined; }
  }

  private async publishOnce(showId: string, trigger: "acceptance" | "alarm" | "recover", episodeId?: string): Promise<"applied" | "scheduled" | "failed" | "pending" | "blocked"> {
    const control = readShowControl(this.ctx.storage, showId);
    if (!control) return "pending";
    const purge = async (paths: string[]) => {
      for (const base of new Set([control.current_delivery.base, ...(control.pending_delivery ? [control.pending_delivery.base] : [])])) {
        if (base === configuredHttpsOrigin(this.env.DELIVERY_BASE)) await this.env.DELIVERY_SERVICE.purge(paths);
        else {
          const token = (this.env as Env & { ZONE_PURGE_TOKEN?: string }).ZONE_PURGE_TOKEN ?? "";
          await purgeZonePaths({ base, configuredBase: this.env.CUSTOM_DELIVERY_BASE, zoneId: this.env.CUSTOM_ZONE_ID, token }, paths);
        }
      }
    };
    if (await hasCurrentWithdrawal(this.ctx.storage, showId)) return withdrawDeletedShow(this.ctx.storage, this.env.DELIVERY_BUCKET, showId, purge, trigger === "alarm" ? "acceptance" : trigger);
    const inputs = this.ctx.storage.transactionSync(() => ({ control: readShowControl(this.ctx.storage, showId),
      episodes: this.ctx.storage.sql.exec<{ episode_id: string; record_json: string }>("SELECT episode_id, record_json FROM episodes ORDER BY episode_id").toArray() }));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson({ version: 1, kind: "preparation", metadata: inputs.control?.metadata,
      cover: inputs.control?.cover, delivery: inputs.control?.current_delivery, episodes: inputs.episodes })));
    const identity = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    if (trigger !== "recover") {
      const row = this.ctx.storage.sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM publication_outcomes WHERE target = 'feed'").toArray()[0];
      if (row?.state === "failed" && (JSON.parse(row.record_json) as { desired_identity?: string }).desired_identity === identity) return "failed";
    }
    try {
      const candidate = await prepareCandidate(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId, Date.now(), episodeId ?? (trigger === "recover"));
      try {
        if (candidate.state === "hold") return "blocked";
        if (candidate.state === "withdraw") return "pending";
        const result = await applyCandidate(this.ctx.storage, this.env.DELIVERY_BUCKET, showId, candidate,
          async () => { throw new Error("Copy service is required"); }, purge, trigger, items => this.env.COPIER.copy(items));
        if (result === "applied" && candidate.episodes.some(item => item.state === "invalid")) return "blocked";
        return result === "applied" && candidate.nextAlarm !== null ? "scheduled" : result;
      } finally { candidate.release(); }
    } catch (error) {
      console.error(JSON.stringify({ event: "publication_preparation_failed", show_id: showId, target: episodeId ?? "feed", ...(episodeId ? { episode_id: episodeId } : {}),
        revision: control.revision, operation_id: control.last_receipt?.operation_id ?? null, trigger, code: "dependency_unavailable", error: error instanceof Error ? error.message : "unknown" }));
      return this.ctx.storage.transaction(async () => {
        const current = readShowControl(this.ctx.storage, showId);
        if (!current || current.revision !== control.revision || inputs.control?.revision !== control.revision) return "pending";
        const row = this.ctx.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = 'feed'").toArray()[0];
        const previous = row ? JSON.parse(row.record_json) as { applied_identity?: string | null } : null;
        const outcome = { record_version: 1, target: "feed", desired_identity: identity, applied_identity: previous?.applied_identity ?? null,
          attempt_revision: control.revision, state: "failed", trigger, error: { code: "dependency_unavailable", message: "Publication preparation failed", operation_id: current.last_receipt?.operation_id ?? null, at: Date.now() }, notification: "unconfigured" };
        this.ctx.storage.sql.exec("INSERT INTO publication_outcomes (target, state, record_json) VALUES ('feed', 'failed', ?) ON CONFLICT(target) DO UPDATE SET state = excluded.state, record_json = excluded.record_json", JSON.stringify(outcome));
        if (!episodeId && current.last_receipt?.response.accepted_revision === current.revision) {
          current.last_receipt.response.delivery = "failed";
          this.ctx.storage.sql.exec("UPDATE show_control SET record_json = ? WHERE singleton = 1", JSON.stringify(current));
        }
        const next = nextScheduledAlarm(this.ctx.storage.sql, current, Date.now());
        if (next === null) await this.ctx.storage.deleteAlarm();
        else await this.ctx.storage.setAlarm(next);
        return "failed";
      });
    }
  }

  async recover(showId: string, raw: RecoverRequest) {
    const request = recoverRequestSchema.parse(raw);
    const control = readShowControl(this.ctx.storage, showId);
    if (!control || !control.metadata || control.revision === 0) return { ok: false as const, status: 404, code: "not_found", message: "Show not found" };
    if (control.pending_delivery && request.episode_id) return { ok: false as const, status: 409, code: "identity_conflict", message: "Recover the pending delivery migration for the whole Show" };
    if (control.revision !== request.expected_revision) return { ok: false as const, status: 409, code: "revision_conflict", message: "Show revision changed; check and retry" };
    if (request.episode_id && !this.ctx.storage.sql.exec("SELECT episode_id FROM episodes WHERE episode_id = ?", request.episode_id).toArray().length)
      return { ok: false as const, status: 404, code: "not_found", message: "Episode not found" };
    const delivery = await this.runPublication(showId, "recover", request.episode_id);
    const current = readShowControl(this.ctx.storage, showId);
    return { ok: true as const, data: { protocol_version: 1 as const, operation_id: request.operation_id, observed_revision: control.revision,
      issues: [], delivery: current?.revision === control.revision ? delivery : "pending" as const } };
  }

  async check(showId: string) {
    try { return { ok: true as const, data: await checkShow(this.ctx.storage, this.env.MANAGEMENT_BUCKET, showId) }; }
    catch (error) {
      if (error instanceof SnapshotChanged) return { ok: false as const, status: 409, code: "revision_conflict", message: error.message };
      if (error instanceof SnapshotNotFound) return { ok: false as const, status: 404, code: "not_found", message: error.message };
      throw error;
    }
  }
}

async function isAuthorized(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const header = request.headers.get("Authorization") ?? "";
  const provided = /^Bearer (.+)$/.exec(header)?.[1] ?? "";
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(provided)), crypto.subtle.digest("SHA-256", encoder.encode(expected))]);
  // Bun's DOM globals omit this Workers extension; it is present in generated runtime types.
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean };
  return subtle.timingSafeEqual(a, b);
}

function issue(status: number, code: string, message: string): Response {
  return Response.json({ protocol_version: 1, issues: [{ code, path: "", message, severity: "error" }] }, { status, headers: { "Cache-Control": "no-store" } });
}

function rejected(status: number, code: string, message: string, operationId: string | null, path = ""): Response {
  return Response.json({ protocol_version: 1, operation_id: operationId, acceptance: "rejected", issues: [{ code, path, message, severity: "error" }] }, { status, headers: { "Cache-Control": "no-store" } });
}

class BodyTooLarge extends Error {}
async function readBoundedJson(request: Request): Promise<unknown> {
  const limit = 1024 * 1024;
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > limit) throw new BodyTooLarge();
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { await reader.cancel(); throw new BodyTooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await isAuthorized(request, env.ADMIN_TOKEN))) return issue(401, "unauthorized", "Authentication required");
    const url = new URL(request.url);
    const resume = /^\/v1\/shows\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})\/restore-resume$/.exec(url.pathname);
    if (resume && (request.method === "GET" || request.method === "POST")) {
      if (url.search) return issue(400, "malformed_input", "Unexpected query parameters");
      if (request.method === "GET") {
        try {
          const result = await env.SHOWS.getByName(resume[1]!).restorePreview(resume[1]!);
          return result.ok ? Response.json(result.data, { headers: { "Cache-Control": "no-store" } }) : issue(result.status, result.code, result.message);
        } catch { return issue(503, "dependency_unavailable", "Restore preview unavailable"); }
      }
      let body: unknown;
      try { body = await readBoundedJson(request); }
      catch (error) { return rejected(error instanceof BodyTooLarge ? 413 : 400, error instanceof BodyTooLarge ? "size_limit" : "malformed_input", "Invalid or oversized request body", null); }
      const parsed = restoreResumeRequestSchema.safeParse(body);
      if (!parsed.success) return rejected(400, "malformed_input", "Invalid restore resume request", null);
      try {
        const result = await env.SHOWS.getByName(resume[1]!).restoreResume(resume[1]!, parsed.data);
        return result.ok ? Response.json(result.data, { headers: { "Cache-Control": "no-store" } }) : rejected(result.status, result.code, result.message, parsed.data.operation_id);
      } catch { return issue(503, "dependency_unavailable", "Restore resume outcome is uncertain; retry the saved operation"); }
    }
    const restore = /^\/v1\/shows\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})\/restore$/.exec(url.pathname);
    if (request.method === "POST" && restore) {
      if (url.search) return rejected(400, "malformed_input", "Unexpected query parameters", null);
      let body: unknown;
      try { body = await readBoundedJson(request); }
      catch (error) { return rejected(error instanceof BodyTooLarge ? 413 : 400, error instanceof BodyTooLarge ? "size_limit" : "malformed_input", "Invalid or oversized request body", null); }
      const parsed = restoreRequestSchema.safeParse(body);
      if (!parsed.success) return rejected(400, "malformed_input", "Invalid restore request", null);
      try {
        const result = await env.SHOWS.getByName(restore[1]!).restore(restore[1]!, parsed.data);
        return result.ok ? Response.json(result.data, { headers: { "Cache-Control": "no-store" } }) : rejected(result.status, result.code, result.message, parsed.data.operation_id);
      } catch { return issue(503, "dependency_unavailable", "Restore outcome is uncertain; retry the saved operation"); }
    }
    const exportRoute = /^\/v1\/shows\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})\/export$/.exec(url.pathname);
    if (request.method === "GET" && exportRoute) {
      if (url.search) return issue(400, "malformed_input", "Unexpected query parameters");
      try {
        const result = await env.SHOWS.getByName(exportRoute[1]!).exportSnapshot(exportRoute[1]!);
        return result.ok ? Response.json(result.data, { headers: { "Cache-Control": "no-store" } }) : issue(result.status, result.code, result.message);
      } catch { return issue(503, "dependency_unavailable", "Export unavailable"); }
    }
    if (request.method === "GET" && url.pathname === "/v1/shows") {
      if ([...url.searchParams.keys()].some(key => key !== "cursor") || url.searchParams.getAll("cursor").length > 1) return issue(400, "malformed_input", "Invalid query parameters");
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null && (!cursor || cursor.length > 4096)) return issue(400, "malformed_input", "Invalid listing cursor");
      try {
        const page = await env.MANAGEMENT_BUCKET.list({ delimiter: "/", limit: 100, ...(cursor ? { cursor } : {}) });
        if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error("Listing cursor did not advance");
        const shows: { show_id: string; revision: number; deleted: boolean }[] = [];
        const issues: { code: string; path: string; message: string; severity: "error" }[] = [];
        for (const prefix of page.delimitedPrefixes) {
          const showId = prefix.endsWith("/") ? prefix.slice(0, -1) : "";
          if (!showIdPattern.test(showId)) continue;
          try {
            const result = await env.SHOWS.getByName(showId).snapshot(showId);
            if (result.ok) shows.push({ show_id: showId, revision: result.data.revision, deleted: result.data.show.deleted });
            else if (result.status !== 404) issues.push({ code: "dependency_unavailable", path: showId, message: result.message, severity: "error" });
          } catch { issues.push({ code: "dependency_unavailable", path: showId, message: "Show state is unavailable", severity: "error" }); }
        }
        return Response.json({ protocol_version: 1, shows, incomplete: issues.length > 0, issues, next_cursor: page.truncated ? page.cursor : null }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error(JSON.stringify({ event: "show_listing_failed", message: error instanceof Error ? error.message : "unknown" }));
        return issue(503, "dependency_unavailable", "Show listing is unavailable");
      }
    }
    const inventory = /^\/v1\/shows\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})\/inventory$/.exec(url.pathname);
    if (inventory && (request.method === "GET" || request.method === "POST")) {
      const showId = inventory[1]!;
      if (request.method === "GET") {
        if ([...url.searchParams.keys()].some(key => key !== "cursor") || url.searchParams.getAll("cursor").length > 1) return issue(400, "malformed_input", "Invalid query parameters");
        try {
          const result = await env.SHOWS.getByName(showId).inventory(showId, url.searchParams.get("cursor") ?? undefined);
          return result.ok ? Response.json(result.data, { headers: { "Cache-Control": "no-store" } }) : issue(400, "malformed_input", result.message);
        } catch { return issue(503, "dependency_unavailable", "Inventory unavailable"); }
      }
      if (url.search) return issue(400, "malformed_input", "Unexpected query parameters");
      let body: unknown;
      try { body = await readBoundedJson(request); }
      catch (error) { return issue(error instanceof BodyTooLarge ? 413 : 400, error instanceof BodyTooLarge ? "size_limit" : "malformed_input", "Invalid or oversized request body"); }
      const parsed = inventoryRegisterSchema.safeParse(body);
      if (!parsed.success) return issue(400, "malformed_input", "Invalid inventory request");
      try { return Response.json(await env.SHOWS.getByName(showId).inventoryRegister(showId, parsed.data), { headers: { "Cache-Control": "no-store" } }); }
      catch { return issue(503, "dependency_unavailable", "Inventory inspection unavailable"); }
    }
    const cleanup = /^\/v1\/shows\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})\/cleanup\/(claim|complete)$/.exec(url.pathname);
    if (request.method === "POST" && cleanup) {
      if (url.search) return issue(400, "malformed_input", "Unexpected query parameters");
      let body: unknown;
      try { body = await readBoundedJson(request); }
      catch (error) { return issue(error instanceof BodyTooLarge ? 413 : 400, error instanceof BodyTooLarge ? "size_limit" : "malformed_input", "Invalid or oversized request body"); }
      const showId = cleanup[1]!;
      try {
        if (cleanup[2] === "claim") {
          const parsed = cleanupClaimSchema.safeParse(body);
          if (!parsed.success) return issue(400, "malformed_input", "Invalid cleanup claim");
          const result = await env.SHOWS.getByName(showId).cleanupClaim(showId, parsed.data);
          return Response.json(result, { headers: { "Cache-Control": "no-store" } });
        }
        const parsed = cleanupCompleteSchema.safeParse(body);
        if (!parsed.success) return issue(400, "malformed_input", "Invalid cleanup completion");
        const result = await env.SHOWS.getByName(showId).cleanupComplete(showId, parsed.data);
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error(JSON.stringify({ event: "cleanup_request_failed", message: error instanceof Error ? error.message : "unknown" }));
        return issue(503, "dependency_unavailable", "Cleanup outcome is uncertain; inspect claims before retrying");
      }
    }
    const recovery = /^\/v1\/shows\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})\/recover$/.exec(url.pathname);
    if (request.method === "POST" && recovery) {
      if (url.search) return issue(400, "malformed_input", "Unexpected query parameters");
      let body: unknown;
      try { body = await readBoundedJson(request); }
      catch (error) { return issue(error instanceof BodyTooLarge ? 413 : 400, error instanceof BodyTooLarge ? "size_limit" : "malformed_input", "Invalid or oversized request body"); }
      const parsed = recoverRequestSchema.safeParse(body);
      if (!parsed.success) return issue(400, "malformed_input", "Invalid recovery request");
      try {
        const result = await env.SHOWS.getByName(recovery[1]!).recover(recovery[1]!, parsed.data);
        if (!result.ok) return issue(result.status, result.code, result.message);
        return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error(JSON.stringify({ event: "recovery_failed", message: error instanceof Error ? error.message : "unknown" }));
        return issue(503, "dependency_unavailable", "Recovery outcome is uncertain; check before retrying");
      }
    }
    const check = /^\/v1\/shows\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})\/check$/.exec(url.pathname);
    if (request.method === "GET" && check) {
      if (url.search) return issue(400, "malformed_input", "Unexpected query parameters");
      try {
        const result = await env.SHOWS.getByName(check[1]!).check(check[1]!);
        if (!result.ok) return issue(result.status, result.code, result.message);
        return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error(JSON.stringify({ event: "check_failed", message: error instanceof Error ? error.message : "unknown" }));
        return issue(503, "dependency_unavailable", "Check unavailable");
      }
    }
    const mutation = /^\/v1\/shows\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})\/operations$/.exec(url.pathname);
    if (request.method === "POST" && mutation) {
      if (url.search) return rejected(400, "malformed_input", "Unexpected query parameters", null);
      let body: unknown;
      try { body = await readBoundedJson(request); }
      catch (error) { return rejected(error instanceof BodyTooLarge ? 413 : 400, error instanceof BodyTooLarge ? "size_limit" : "malformed_input", "Invalid or oversized request body", null); }
      const parsed = operationSchema.safeParse(body);
      if (!parsed.success) return rejected(400, "malformed_input", "Invalid operation", null);
      try {
        const result = await env.SHOWS.getByName(mutation[1]!).operation(mutation[1]!, parsed.data);
        if (!result.ok) return rejected(result.status, result.code, result.message, parsed.data.operation_id, "path" in result ? result.path : "");
        return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error(JSON.stringify({ event: "operation_failed", message: error instanceof Error ? error.message : "unknown" }));
        return issue(503, "dependency_unavailable", "Operation outcome is uncertain; retry the saved operation");
      }
    }
    const match = /^\/v1\/shows\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})\/snapshot$/.exec(url.pathname);
    if (request.method !== "GET" || !match || !showIdPattern.test(match[1]!)) return issue(404, "not_found", "Route not found");
    if ([...url.searchParams.keys()].some(key => key !== "cursor") || url.searchParams.getAll("cursor").length > 1) return issue(400, "malformed_input", "Invalid query parameters");
    try {
      const result = await env.SHOWS.getByName(match[1]!).snapshot(match[1]!, url.searchParams.get("cursor") ?? undefined);
      if (!result.ok) return issue(result.status, result.code, result.message);
      return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error(JSON.stringify({ event: "snapshot_failed", message: error instanceof Error ? error.message : "unknown" }));
      return issue(503, "dependency_unavailable", "Snapshot unavailable");
    }
  },
};
