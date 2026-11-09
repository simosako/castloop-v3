import { canonicalJson, cleanupClaimSchema, cleanupCompleteSchema, episodeIdPattern, objectRefSchema, operationSchema, recoverRequestSchema, showExportSchema, showIdPattern, type CleanupClaim, type CleanupComplete, type ObjectRef, type Operation, type RecoverRequest } from "@castloop/domain";

export interface SnapshotEpisode { episode_id: string; metadata: ObjectRef; guid: string; deleted: boolean }
export interface SnapshotPage { protocol_version: 1; show_id: string; revision: number; show: { metadata: ObjectRef; deleted: boolean }; episodes: SnapshotEpisode[]; next_cursor: string | null }
export interface Snapshot { show_id: string; revision: number; show: SnapshotPage["show"]; episodes: SnapshotEpisode[] }
export interface OperationResponse { protocol_version: 1; operation_id: string; accepted_revision: number; acceptance: "accepted" | "already_accepted"; validation_issues: { code: string; path: string; message: string; severity: "error" | "warning" }[]; delivery: "applied" | "scheduled" | "pending" | "blocked" | "failed" }
export class UncertainOperationError extends Error {}
export class ManagementNotFoundError extends Error {}
export class RejectedOperationError extends Error { constructor(message: string, readonly status: number, readonly code: string, readonly path = "", readonly operationMatched = false) { super(message); } }
export interface CheckResult {
  protocol_version: 1; show_id: string; revision: number;
  issues: { code: string; path: string; message: string; severity: "error" | "warning" }[];
  outcomes: { target: string; state: "pending" | "applied" | "blocked" | "failed"; notification?: "unconfigured" | "pending" | "accepted" | "failed" | null; error?: { code: string; message: string } | null }[];
  cleanup_claims: { object_key: string; claim_operation_id: string | null }[];
  delivery_base: string; previous_delivery_base?: string | null; pending_delivery_base?: string | null; delivery_paths: string[];
}
export interface RecoveryResponse { protocol_version: 1; operation_id: string; observed_revision: number; issues: { code: string; path: string; message: string; severity: "error" | "warning" }[]; delivery: "applied" | "scheduled" | "pending" | "blocked" | "failed" }
export interface InventoryRecord { ref: ObjectRef; state: "present" | "delete_claimed" | "deleted" | "missing"; claim_operation_id: string | null; stored_at: number; kind: string; episode_id: string | null }

async function boundedJson(response: Response, limit = 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing management response body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new Error("Management response exceeds its size limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`Invalid management response (HTTP ${response.status})`); }
}

function parsePage(raw: unknown, showId: string): SnapshotPage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Malformed snapshot response");
  const page = raw as Record<string, unknown>;
  const show = page.show as Record<string, unknown> | null;
  if (page.protocol_version !== 1 || page.show_id !== showId || !Number.isSafeInteger(page.revision) || (page.revision as number) < 1 ||
    !show || typeof show !== "object" || typeof show.deleted !== "boolean" || !Array.isArray(page.episodes) || page.episodes.length > 100 ||
    !(page.next_cursor === null || (typeof page.next_cursor === "string" && page.next_cursor.length > 0 && page.next_cursor.length <= 512))) throw new Error("Malformed snapshot response");
  const episodes = page.episodes.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed episode snapshot");
    const entry = value as Record<string, unknown>;
    if (typeof entry.episode_id !== "string" || !episodeIdPattern.test(entry.episode_id) || typeof entry.guid !== "string" || !entry.guid || typeof entry.deleted !== "boolean") throw new Error("Malformed episode snapshot");
    return { episode_id: entry.episode_id, guid: entry.guid, metadata: objectRefSchema.parse(entry.metadata), deleted: entry.deleted };
  });
  return { protocol_version: 1, show_id: showId, revision: page.revision as number, show: { metadata: objectRefSchema.parse(show.metadata), deleted: show.deleted }, episodes, next_cursor: page.next_cursor as string | null };
}

/** Validate every page before exposing a snapshot to a local installer. */
export async function collectSnapshot(showId: string, getPage: (cursor?: string) => Promise<unknown>): Promise<Snapshot> {
  if (!showIdPattern.test(showId)) throw new Error("Invalid show ID");
  const seen = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | undefined;
  let revision: number | undefined;
  let first: SnapshotPage["show"] | undefined;
  let previousId = "";
  const episodes: SnapshotEpisode[] = [];
  do {
    const page = parsePage(await getPage(cursor), showId);
    if (revision !== undefined && (revision !== page.revision || JSON.stringify(first) !== JSON.stringify(page.show))) throw new Error("Show changed during pull; run pull again");
    revision = page.revision;
    first = page.show;
    for (const episode of page.episodes) {
      if (ids.has(episode.episode_id) || episode.episode_id <= previousId) throw new Error("Snapshot pages contain duplicate or unordered episodes");
      ids.add(episode.episode_id); previousId = episode.episode_id; episodes.push(episode);
    }
    if (page.next_cursor && (seen.has(page.next_cursor) || !page.episodes.length)) throw new Error("Snapshot pagination did not advance");
    if (page.next_cursor) seen.add(page.next_cursor);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return { show_id: showId, revision: revision!, show: first!, episodes };
}

/** Fetch an authenticated, bounded metadata page from the management Worker. */
export async function fetchSnapshotPage(origin: string, token: string, showId: string, cursor?: string, transport: (url: URL, options: RequestInit) => Promise<Response> = (url, options) => fetch(url, options)): Promise<unknown> {
  const base = new URL(origin);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) throw new Error("Management URL must be HTTPS or local HTTP");
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Management URL must be an origin");
  if (!showIdPattern.test(showId) || !token) throw new Error("Invalid show ID or missing management token");
  const url = new URL(`/v1/shows/${showId}/snapshot`, base);
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  const response = await transport(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
  const body = await boundedJson(response);
  if (!response.ok) {
    const issues = (body as { issues?: { code?: string; message?: string }[] }).issues;
    const firstIssue = Array.isArray(issues) ? issues[0] : undefined;
    if (response.status === 404 && firstIssue?.code === "not_found") throw new ManagementNotFoundError("Show not found");
    throw new Error(firstIssue?.code === "snapshot_revision_changed" ? "Show changed during pull; run pull again" : `Management request failed (HTTP ${response.status}): ${firstIssue?.message ?? "unknown error"}`);
  }
  return body;
}

export async function fetchCheck(origin: string, token: string, showId: string, transport: (url: URL, options: RequestInit) => Promise<Response> = (url, options) => fetch(url, options)): Promise<CheckResult> {
  const base = new URL(origin);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) || !showIdPattern.test(showId) || !token) throw new Error("Invalid management origin, show ID or token");
  const response = await transport(new URL(`/v1/shows/${showId}/check`, base), { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
  const raw = await boundedJson(response);
  if (!response.ok) throw new Error(`Check request failed (HTTP ${response.status})`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Malformed check response");
  const value = raw as Record<string, unknown>;
  if (value.protocol_version !== 1 || value.show_id !== showId || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
    !Array.isArray(value.issues) || !Array.isArray(value.outcomes) || !Array.isArray(value.cleanup_claims) || typeof value.delivery_base !== "string" || !Array.isArray(value.delivery_paths) ||
    !(value.previous_delivery_base === undefined || value.previous_delivery_base === null || typeof value.previous_delivery_base === "string") ||
    !(value.pending_delivery_base === undefined || value.pending_delivery_base === null || typeof value.pending_delivery_base === "string") ||
    !value.issues.every((item: unknown) => item && typeof item === "object" && typeof (item as Record<string, unknown>).code === "string" && typeof (item as Record<string, unknown>).path === "string" && typeof (item as Record<string, unknown>).message === "string" && ["error", "warning"].includes(String((item as Record<string, unknown>).severity))) ||
    !value.outcomes.every((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const outcome = item as Record<string, unknown>;
      const error = outcome.error;
      return typeof outcome.target === "string" && ["pending", "applied", "blocked", "failed"].includes(String(outcome.state)) &&
        (outcome.notification === undefined || outcome.notification === null || ["unconfigured", "pending", "accepted", "failed"].includes(String(outcome.notification))) &&
        (error === undefined || error === null || (typeof error === "object" && typeof (error as Record<string, unknown>).code === "string" && typeof (error as Record<string, unknown>).message === "string"));
    }) ||
    !value.cleanup_claims.every((item: unknown) => item && typeof item === "object" && typeof (item as Record<string, unknown>).object_key === "string" && (typeof (item as Record<string, unknown>).claim_operation_id === "string" || (item as Record<string, unknown>).claim_operation_id === null)) ||
    !value.delivery_paths.every((path: unknown) => typeof path === "string" && path.startsWith(`/${showId}/`))) throw new Error("Malformed check response");
  return value as unknown as CheckResult;
}

function inventoryUrl(origin: string, token: string, showId: string): URL {
  const base = new URL(origin);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) || !showIdPattern.test(showId) || !token) throw new Error("Invalid management origin, show ID or token");
  return new URL(`/v1/shows/${showId}/inventory`, base);
}

export async function fetchShows(origin: string, token: string): Promise<{ shows: { show_id: string; revision: number; deleted: boolean }[]; issues: { path: string; message: string }[] }> {
  const url = inventoryUrl(origin, token, "s-00000000");
  url.pathname = "/v1/shows";
  const shows: { show_id: string; revision: number; deleted: boolean }[] = [], issues: { path: string; message: string }[] = [];
  const seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor) url.searchParams.set("cursor", cursor); else url.searchParams.delete("cursor");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
    const raw = await boundedJson(response) as Record<string, unknown>;
    if (!response.ok || !raw || raw.protocol_version !== 1 || !Array.isArray(raw.shows) || !Array.isArray(raw.issues) || typeof raw.incomplete !== "boolean" || !(raw.next_cursor === null || typeof raw.next_cursor === "string") || raw.incomplete !== (raw.issues.length > 0)) throw new Error(`Invalid show listing response (HTTP ${response.status})`);
    for (const item of raw.shows) {
      if (!item || typeof item !== "object" || typeof item.show_id !== "string" || !showIdPattern.test(item.show_id) || seen.has(item.show_id) || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.deleted !== "boolean") throw new Error("Invalid show listing entry");
      seen.add(item.show_id); shows.push(item);
    }
    for (const item of raw.issues) {
      if (!item || typeof item !== "object" || typeof item.path !== "string" || typeof item.message !== "string" || item.severity !== "error") throw new Error("Invalid show listing issue");
      issues.push({ path: item.path, message: item.message });
    }
    const next = raw.next_cursor as string | null;
    if (next !== null && (!next || cursors.has(next))) throw new Error("Show listing cursor did not advance");
    if (next) cursors.add(next);
    cursor = next ?? undefined;
  } while (cursor);
  return { shows, issues };
}

export async function fetchShowExport(origin: string, token: string, showId: string): Promise<Record<string, unknown>> {
  const url = inventoryUrl(origin, token, showId); url.pathname = `/v1/shows/${showId}/export`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
  const raw = await boundedJson(response, 16 * 1024 * 1024) as Record<string, unknown>;
  const parsed = showExportSchema.safeParse(raw);
  if (!response.ok || !parsed.success || parsed.data.show_id !== showId) throw new Error(`Invalid or unavailable Show export (HTTP ${response.status})`);
  return parsed.data;
}

export async function fetchRestorePreview(origin: string, token: string, showId: string): Promise<{ revision: number; state: "ready" | "withdraw" | "hold"; issues: { path: string; message: string }[]; episodes: { id: string; state: string; at: number | null; issues: { path: string; message: string }[] }[] }> {
  const url = inventoryUrl(origin, token, showId); url.pathname = `/v1/shows/${showId}/restore-resume`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
  const raw = await boundedJson(response) as Record<string, unknown>;
  const isIssue = (item: unknown) => !!item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" && typeof (item as { message?: unknown }).message === "string";
  if (!response.ok || !raw || raw.protocol_version !== 1 || raw.show_id !== showId || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 ||
    !["ready", "withdraw", "hold"].includes(String(raw.state)) || !Array.isArray(raw.issues) || !raw.issues.every(isIssue) || !Array.isArray(raw.episodes) ||
    !raw.episodes.every((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const entry = item as Record<string, unknown>;
      return typeof entry.id === "string" && episodeIdPattern.test(entry.id) && ["withdraw", "invalid", "scheduled", "failed", "eligible"].includes(String(entry.state)) &&
        (entry.at === null || (Number.isSafeInteger(entry.at) && (entry.at as number) >= 0)) && Array.isArray(entry.issues) && entry.issues.every(isIssue);
    })) throw new Error(`Invalid or unavailable restore preview (HTTP ${response.status})`);
  return raw as unknown as { revision: number; state: "ready" | "withdraw" | "hold"; issues: { path: string; message: string }[]; episodes: { id: string; state: string; at: number | null; issues: { path: string; message: string }[] }[] };
}

export async function registerInventory(origin: string, token: string, showId: string, objects: ObjectRef[]): Promise<{ registered: ObjectRef[]; skipped: { key: string; issues: string[] }[] }> {
  if (!objects.length || objects.length > 100) throw new Error("Invalid inventory batch size");
  const url = inventoryUrl(origin, token, showId);
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ protocol_version: 1, objects }), redirect: "error" });
  const raw = await boundedJson(response) as Record<string, unknown>;
  if (!response.ok || !raw || raw.protocol_version !== 1 || raw.show_id !== showId || !Array.isArray(raw.registered) || !Array.isArray(raw.skipped)) throw new Error(`Inventory registration failed (HTTP ${response.status})`);
  const expected = new Map(objects.map(ref => [ref.key, canonicalJson(ref)]));
  const seen = new Set<string>();
  for (const ref of raw.registered) {
    const parsed = objectRefSchema.safeParse(ref);
    if (!parsed.success || seen.has(parsed.data.key) || expected.get(parsed.data.key) !== canonicalJson(parsed.data)) throw new Error("Invalid inventory registration response");
    seen.add(parsed.data.key);
  }
  for (const item of raw.skipped) {
    if (!item || typeof item !== "object" || typeof item.key !== "string" || !expected.has(item.key) || seen.has(item.key) || !Array.isArray(item.issues) || !item.issues.every((issue: unknown) => typeof issue === "string")) throw new Error("Invalid inventory registration response");
    seen.add(item.key);
  }
  if (seen.size !== expected.size) throw new Error("Incomplete inventory registration response");
  return raw as unknown as { registered: ObjectRef[]; skipped: { key: string; issues: string[] }[] };
}

export async function fetchInventory(origin: string, token: string, showId: string): Promise<InventoryRecord[]> {
  const records: InventoryRecord[] = [], keys = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const url = inventoryUrl(origin, token, showId);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
    const raw = await boundedJson(response) as Record<string, unknown>;
    if (!response.ok || !raw || raw.protocol_version !== 1 || raw.show_id !== showId || !Array.isArray(raw.records) || raw.records.length > 100 || !(raw.next_cursor === null || typeof raw.next_cursor === "string")) throw new Error(`Invalid inventory page (HTTP ${response.status})`);
    for (const item of raw.records) {
      if (!item || typeof item !== "object" || !objectRefSchema.safeParse(item.ref).success || !item.ref.key.startsWith(`${showId}/`) || keys.has(item.ref.key) ||
        !["present", "delete_claimed", "deleted", "missing"].includes(item.state) || !(item.claim_operation_id === null || typeof item.claim_operation_id === "string") ||
        !Number.isSafeInteger(item.stored_at) || item.stored_at < 0 || typeof item.kind !== "string" || !(item.episode_id === null || typeof item.episode_id === "string")) throw new Error("Invalid inventory record");
      keys.add(item.ref.key); records.push(item as InventoryRecord);
    }
    const next = raw.next_cursor as string | null;
    if (next !== null && (!next || cursors.has(next))) throw new Error("Inventory cursor did not advance");
    if (next) cursors.add(next);
    cursor = next ?? undefined;
  } while (cursor);
  return records;
}

export async function submitCleanupClaim(origin: string, token: string, showId: string, input: CleanupClaim): Promise<{ claimed: ObjectRef[]; skipped: { key: string; issues: string[] }[] }> {
  const request = cleanupClaimSchema.parse(input);
  const url = inventoryUrl(origin, token, showId); url.pathname = `/v1/shows/${showId}/cleanup/claim`;
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(request), redirect: "error" });
  const raw = await boundedJson(response) as Record<string, unknown>;
  if (!response.ok || !raw || raw.protocol_version !== 1 || raw.show_id !== showId || raw.operation_id !== request.operation_id || !Number.isSafeInteger(raw.cutoff_at) || !Array.isArray(raw.claimed) || !Array.isArray(raw.skipped)) throw new Error("Cleanup claim outcome is uncertain; inspect inventory before retrying");
  const expected = new Map(request.candidates.map(ref => [ref.key, canonicalJson(ref)])), seen = new Set<string>();
  for (const ref of raw.claimed) {
    const parsed = objectRefSchema.safeParse(ref);
    if (!parsed.success || seen.has(parsed.data.key) || expected.get(parsed.data.key) !== canonicalJson(parsed.data)) throw new Error("Invalid cleanup claim response");
    seen.add(parsed.data.key);
  }
  for (const item of raw.skipped) {
    if (!item || typeof item !== "object" || typeof item.key !== "string" || !expected.has(item.key) || seen.has(item.key) || !Array.isArray(item.issues) || !item.issues.every((s: unknown) => typeof s === "string")) throw new Error("Invalid cleanup claim response");
    seen.add(item.key);
  }
  if (seen.size !== expected.size) throw new Error("Incomplete cleanup claim response");
  return raw as unknown as { claimed: ObjectRef[]; skipped: { key: string; issues: string[] }[] };
}

export async function submitCleanupComplete(origin: string, token: string, showId: string, input: CleanupComplete): Promise<{ deleted: string[]; unresolved: { key: string; issues: string[] }[] }> {
  const request = cleanupCompleteSchema.parse(input);
  const url = inventoryUrl(origin, token, showId); url.pathname = `/v1/shows/${showId}/cleanup/complete`;
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(request), redirect: "error" });
  const raw = await boundedJson(response) as Record<string, unknown>;
  if (!response.ok || !raw || raw.protocol_version !== 1 || raw.show_id !== showId || raw.operation_id !== request.operation_id || !Array.isArray(raw.deleted) || !Array.isArray(raw.unresolved)) throw new Error("Cleanup completion outcome is uncertain; inspect inventory before retrying");
  const expected = new Set(request.keys), seen = new Set<string>();
  for (const key of raw.deleted) { if (typeof key !== "string" || !expected.has(key) || seen.has(key)) throw new Error("Invalid cleanup completion response"); seen.add(key); }
  for (const item of raw.unresolved) {
    if (!item || typeof item !== "object" || typeof item.key !== "string" || !expected.has(item.key) || seen.has(item.key) || !Array.isArray(item.issues) || !item.issues.every((s: unknown) => typeof s === "string")) throw new Error("Invalid cleanup completion response");
    seen.add(item.key);
  }
  if (seen.size !== expected.size) throw new Error("Incomplete cleanup completion response");
  return raw as unknown as { deleted: string[]; unresolved: { key: string; issues: string[] }[] };
}

export async function submitRecovery(origin: string, token: string, showId: string, input: RecoverRequest, transport: (url: URL, options: RequestInit) => Promise<Response> = (url, options) => fetch(url, options)): Promise<RecoveryResponse> {
  const request = recoverRequestSchema.parse(input);
  const base = new URL(origin);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) || !showIdPattern.test(showId) || !token) throw new Error("Invalid management origin, show ID or token");
  const response = await transport(new URL(`/v1/shows/${showId}/recover`, base), { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
  const raw = await boundedJson(response);
  if (!response.ok) {
    const issue = (raw as { issues?: { code?: string; message?: string }[] })?.issues?.[0];
    throw new RejectedOperationError(`Recovery failed (HTTP ${response.status}): ${issue?.message ?? "unknown error"}`, response.status, issue?.code ?? "unknown");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Malformed recovery response");
  const value = raw as Record<string, unknown>;
  if (value.protocol_version !== 1 || value.operation_id !== request.operation_id || value.observed_revision !== request.expected_revision ||
    !["applied", "scheduled", "pending", "blocked", "failed"].includes(String(value.delivery)) || !Array.isArray(value.issues) ||
    !value.issues.every((item: unknown) => item && typeof item === "object" && typeof (item as Record<string, unknown>).code === "string" && typeof (item as Record<string, unknown>).path === "string" && typeof (item as Record<string, unknown>).message === "string" && ["error", "warning"].includes(String((item as Record<string, unknown>).severity)))) throw new Error("Malformed recovery response");
  return value as unknown as RecoveryResponse;
}

/** Do not treat a connection failure or an invalid response as a rejected mutation. */
export async function submitOperation(origin: string, token: string, showId: string, input: Operation, transport: (url: URL, options: RequestInit) => Promise<Response> = (url, options) => fetch(url, options)): Promise<OperationResponse> {
  const operation = operationSchema.parse(input);
  if (!showIdPattern.test(showId) || !token) throw new Error("Invalid show ID or missing management token");
  const base = new URL(origin);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))) throw new Error("Management URL must be an HTTPS origin or local HTTP origin");
  const body = JSON.stringify(operation.action === "restore" || operation.action === "restore-resume"
    ? { protocol_version: operation.protocol_version, operation_id: operation.operation_id, expected_revision: operation.expected_revision, ...operation.payload } : operation);
  if (new TextEncoder().encode(body).length > 1024 * 1024) throw new Error("Operation exceeds 1 MiB");
  let response: Response;
  let payload: unknown;
  try {
    const route = operation.action === "restore" || operation.action === "restore-resume" ? operation.action : "operations";
    response = await transport(new URL(`/v1/shows/${showId}/${route}`, base), { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 1024 * 1024) { await reader.cancel(); throw new Error("Response too large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new UncertainOperationError("Operation outcome is uncertain; retry the saved operation"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new UncertainOperationError("Operation outcome is uncertain; retry the saved operation");
  const result = payload as Record<string, unknown>;
  if (result.protocol_version === 1 && result.acceptance === "rejected" && (result.operation_id === operation.operation_id || result.operation_id === null) && Array.isArray(result.issues) && result.issues.length) {
    const issue = result.issues[0] as { code?: unknown; message?: unknown; path?: unknown };
    if (typeof issue?.code === "string" && typeof issue.message === "string") throw new RejectedOperationError(issue.message, response.status, issue.code, typeof issue.path === "string" ? issue.path : "", result.operation_id === operation.operation_id);
  }
  const deliveries = ["applied", "scheduled", "pending", "blocked", "failed"];
  if (!response.ok || result.protocol_version !== 1 || result.operation_id !== operation.operation_id ||
    (result.acceptance !== "accepted" && result.acceptance !== "already_accepted") || !Number.isSafeInteger(result.accepted_revision) ||
    result.accepted_revision !== operation.expected_revision + 1 || !Array.isArray(result.validation_issues) || typeof result.delivery !== "string" || !deliveries.includes(result.delivery) ||
    !result.validation_issues.every((item: unknown) => item && typeof item === "object" && typeof (item as Record<string, unknown>).code === "string" && typeof (item as Record<string, unknown>).path === "string" && typeof (item as Record<string, unknown>).message === "string" && ["error", "warning"].includes(String((item as Record<string, unknown>).severity)))) {
    throw new UncertainOperationError("Operation outcome is uncertain; retry the saved operation");
  }
  return result as unknown as OperationResponse;
}
