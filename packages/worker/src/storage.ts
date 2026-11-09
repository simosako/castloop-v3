import { episodeIdPattern, operationFingerprint, operationSchema, showIdPattern, type ObjectRef, type Operation } from "@castloop/domain";

/** The JSON columns hold versioned logical records from the shared protocol. */
export function initializeSchema(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS schema_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL)");
    const version = sql.exec<{ schema_version: number }>("SELECT schema_version FROM schema_meta WHERE singleton = 1").toArray()[0]?.schema_version;
    if (version !== undefined && version !== 1) throw new Error(`Unsupported storage schema version ${version}`);
    if (version === 1) return;
    sql.exec(`CREATE TABLE show_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), show_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0), record_json TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE episodes (
      episode_id TEXT PRIMARY KEY, guid TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE source_assets (
      object_key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('present', 'delete_claimed', 'deleted', 'missing')),
      claim_operation_id TEXT, record_json TEXT NOT NULL,
      CHECK (state NOT IN ('delete_claimed', 'deleted') OR claim_operation_id IS NOT NULL),
      CHECK (state != 'present' OR claim_operation_id IS NULL)
    )`);
    sql.exec("CREATE INDEX source_assets_claim_idx ON source_assets (claim_operation_id)");
    sql.exec(`CREATE TABLE publication_outcomes (
      target TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'blocked', 'failed')),
      record_json TEXT NOT NULL
    )`);
    sql.exec("CREATE TABLE delivery_refs (target TEXT PRIMARY KEY, record_json TEXT NOT NULL)");
    sql.exec("CREATE TABLE source_pins (object_key TEXT NOT NULL, execution_id TEXT NOT NULL, PRIMARY KEY (object_key, execution_id))");
    sql.exec("INSERT INTO schema_meta (singleton, schema_version) VALUES (1, 1)");
  });
}

export type DeliveryStatus = "applied" | "scheduled" | "pending" | "blocked" | "failed";
export interface MutationIssue { code: string; path: string; message: string; severity: "error" | "warning" }
export interface AcceptanceResult {
  protocol_version: 1; operation_id: string; accepted_revision: number;
  acceptance: "accepted" | "already_accepted"; validation_issues: MutationIssue[]; delivery: DeliveryStatus;
}
export interface ShowControl {
  record_version: 1; show_id: string; revision: number; metadata: ObjectRef | null;
  cover: { logical_name: string; ref: ObjectRef; facts: { mime: "image/jpeg" | "image/png"; width: number; height: number; color: "rgb"; alpha: false } } | null;
  deleted: boolean; accepted_at: number | null;
  last_receipt: { operation_id: string; fingerprint: string; response: AcceptanceResult } | null;
  current_delivery: { base: string; previous_base: string | null; migration_operation_id: string | null; applied_revision: number };
  pending_delivery: { base: string; migration_operation_id: string; accepted_revision: number } | null;
  restore_hold: boolean;
  /** Derived scheduling facts; source TOML remains authoritative. */
  scheduling?: { enabled: boolean; serial: boolean };
}
export class RevisionConflict extends Error {}
export class IdentityConflict extends Error {}
/** Identifies a confirmed create collision without conflating other identity errors. */
export class CreationCollision extends IdentityConflict {
  constructor(message: string, readonly path: string) { super(message); }
}
export class SnapshotChanged extends Error {}
export class SnapshotNotFound extends Error {}

/** Compute the earliest eligible reservation; include due pending work when requested. */
export function nextScheduledAlarm(sql: SqlStorage, control: ShowControl, now: number, includeDue = false): number | null {
  if (control.deleted || control.restore_hold || !control.scheduling?.enabled) return null;
  const rows = sql.exec<{ record_json: string; state: string | null }>("SELECT e.record_json, o.state FROM episodes e LEFT JOIN publication_outcomes o ON o.target = e.episode_id").toArray();
  let earliest: number | null = null;
  for (const row of rows) {
    const record = JSON.parse(row.record_json) as { deleted?: boolean; publish?: boolean; time?: { instant_ms?: number } | null; scheduling?: { ready?: boolean; serial_ready?: boolean } };
    const at = record.time?.instant_ms;
    if (record.deleted || !record.publish || row.state === "failed" || !record.scheduling?.ready || (control.scheduling.serial && !record.scheduling.serial_ready) ||
      !Number.isSafeInteger(at) || (at! <= now && (!includeDue || row.state !== "pending"))) continue;
    if (earliest === null || at! < earliest) earliest = at!;
  }
  return earliest;
}

export function readShowControl(storage: DurableObjectStorage, showId: string): ShowControl | null {
  const row = storage.sql.exec<{ show_id: string; revision: number; record_json: string }>("SELECT show_id, revision, record_json FROM show_control WHERE singleton = 1").toArray()[0];
  if (!row) return null;
  const control = JSON.parse(row.record_json) as ShowControl;
  if (row.show_id !== showId || control.show_id !== showId || control.revision !== row.revision) throw new IdentityConflict("Show control identity is inconsistent");
  return control;
}

/** A previously accepted retry can be answered even when its old source is now unavailable. */
export async function lookupReceipt(storage: DurableObjectStorage, showId: string, operation: Operation): Promise<AcceptanceResult | null> {
  const fingerprint = await operationFingerprint(showId, operation);
  const receipt = readShowControl(storage, showId)?.last_receipt;
  if (!receipt || receipt.operation_id !== operation.operation_id) return null;
  if (receipt.fingerprint !== fingerprint) throw new IdentityConflict("Operation ID already used for a different request");
  return { ...receipt.response, acceptance: "already_accepted" };
}

interface EpisodeSnapshotRecord { episode_id: string; guid: string; metadata: ObjectRef; deleted: boolean }
interface SnapshotCursor { version: 1; show_id: string; revision: number; last_episode_id: string }

function encodeCursor(cursor: SnapshotCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(value: string, showId: string): SnapshotCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error();
    const raw: unknown = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error();
    const cursor = raw as Record<string, unknown>;
    if (Object.keys(cursor).sort().join(",") !== "last_episode_id,revision,show_id,version" || cursor.version !== 1 || cursor.show_id !== showId ||
      !Number.isSafeInteger(cursor.revision) || (cursor.revision as number) < 0 || typeof cursor.last_episode_id !== "string" || !episodeIdPattern.test(cursor.last_episode_id)) throw new Error();
    return { version: 1, show_id: showId, revision: cursor.revision as number, last_episode_id: cursor.last_episode_id };
  } catch { throw new IdentityConflict("Invalid metadata snapshot cursor"); }
}

/** Read each page and its revision in one SQL transaction. */
export function readSnapshot(storage: DurableObjectStorage, showId: string, cursorText?: string) {
  if (!showIdPattern.test(showId)) throw new IdentityConflict("Invalid show ID");
  const cursor = cursorText === undefined ? undefined : decodeCursor(cursorText, showId);
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const row = sql.exec<{ show_id: string; revision: number; record_json: string }>("SELECT show_id, revision, record_json FROM show_control WHERE singleton = 1").toArray()[0];
    if (!row || row.show_id !== showId || row.revision === 0) throw new SnapshotNotFound("Show not found");
    const control = JSON.parse(row.record_json) as ShowControl;
    if (control.show_id !== showId || control.revision !== row.revision || !control.metadata) throw new IdentityConflict("Show control identity is inconsistent");
    if (cursor && cursor.revision !== row.revision) throw new SnapshotChanged("Show changed during pull; run pull again");
    const lastId = cursor?.last_episode_id ?? "";
    if (cursor && !sql.exec("SELECT episode_id FROM episodes WHERE episode_id = ?", lastId).toArray().length) throw new IdentityConflict("Invalid metadata snapshot cursor");
    const rows = sql.exec<{ episode_id: string; guid: string; record_json: string }>("SELECT episode_id, guid, record_json FROM episodes WHERE episode_id > ? ORDER BY episode_id LIMIT 101", lastId).toArray();
    const more = rows.length > 100;
    const episodes = rows.slice(0, 100).map(item => {
      const record = JSON.parse(item.record_json) as EpisodeSnapshotRecord;
      if (record.episode_id !== item.episode_id || record.guid !== item.guid || !record.metadata || typeof record.deleted !== "boolean") throw new IdentityConflict("Episode record is inconsistent");
      return { episode_id: record.episode_id, metadata: record.metadata, guid: record.guid, deleted: record.deleted };
    });
    return { protocol_version: 1 as const, show_id: showId, revision: row.revision, show: { metadata: control.metadata, deleted: control.deleted }, episodes,
      next_cursor: more ? encodeCursor({ version: 1, show_id: showId, revision: row.revision, last_episode_id: episodes[episodes.length - 1]!.episode_id }) : null };
  });
}

/**
 * Commit a prevalidated source selection. R2 inspection must finish before this
 * function; apply executes only synchronous SQL and does no external I/O.
 */
export async function commitAcceptance(
  storage: DurableObjectStorage,
  showId: string,
  raw: Operation,
  apply: (sql: SqlStorage, current: ShowControl | null, revision: number) => {
    control: ShowControl; issues: MutationIssue[]; delivery: DeliveryStatus; alarm?: number | null;
  },
): Promise<AcceptanceResult> {
  if (!showIdPattern.test(showId)) throw new IdentityConflict("Invalid show ID");
  const operation = operationSchema.parse(raw);
  const fingerprint = await operationFingerprint(showId, operation);
  return storage.transaction(async () => {
    const sql = storage.sql;
    const row = sql.exec<{ show_id: string; revision: number; record_json: string }>("SELECT show_id, revision, record_json FROM show_control WHERE singleton = 1").toArray()[0];
    const current = row ? JSON.parse(row.record_json) as ShowControl : null;
    if (row && (row.show_id !== showId || current?.show_id !== showId || current.revision !== row.revision)) throw new IdentityConflict("Show control identity is inconsistent");
    const receipt = current?.last_receipt;
    if (receipt?.operation_id === operation.operation_id) {
      if (receipt.fingerprint !== fingerprint) throw new IdentityConflict("Operation ID already used for a different request");
      return { ...receipt.response, acceptance: "already_accepted" };
    }
    const revision = row?.revision ?? 0;
    if (operation.expected_revision !== revision) throw new RevisionConflict("Show revision changed; pull before retrying");
    if (revision >= Number.MAX_SAFE_INTEGER) throw new RevisionConflict("Show revision limit reached");
    const plan = apply(sql, current, revision + 1);
    if (plan.control.show_id !== showId || plan.control.revision !== revision + 1) throw new IdentityConflict("Mutation plan has inconsistent identity or revision");
    const response: AcceptanceResult = { protocol_version: 1, operation_id: operation.operation_id, accepted_revision: revision + 1,
      acceptance: "accepted", validation_issues: plan.issues, delivery: plan.delivery };
    plan.control.last_receipt = { operation_id: operation.operation_id, fingerprint, response };
    sql.exec(`INSERT INTO show_control (singleton, show_id, revision, record_json) VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET show_id = excluded.show_id, revision = excluded.revision, record_json = excluded.record_json`,
      showId, revision + 1, JSON.stringify(plan.control));
    if (plan.alarm === null) await storage.deleteAlarm();
    else if (plan.alarm !== undefined) {
      if (!Number.isSafeInteger(plan.alarm) || plan.alarm < 0) throw new Error("Invalid alarm time");
      await storage.setAlarm(plan.alarm);
    }
    return response;
  });
}
