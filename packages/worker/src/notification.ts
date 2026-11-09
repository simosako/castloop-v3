import { showIdPattern, episodeIdPattern } from "@castloop/domain";

export interface FailureNotice {
  showId: string;
  target: string;
  revision: number;
  operationId: string | null;
  at: number;
  code: string;
}

/** Only fixed text and identifiers enter email; raw exceptions may contain secrets. */
export async function sendFailureNotice(email: SendEmail | undefined, from: string, to: string, notice: FailureNotice): Promise<"accepted" | "unconfigured"> {
  if (!email || !from || !to) return "unconfigured";
  if (!showIdPattern.test(notice.showId) || !(notice.target === "feed" || notice.target === "show-withdrawal" || episodeIdPattern.test(notice.target)) ||
      !Number.isSafeInteger(notice.revision) || !Number.isSafeInteger(notice.at) || !/^[a-z_]{1,80}$/.test(notice.code) ||
      (notice.operationId !== null && !/^[0-9a-f-]{36}$/.test(notice.operationId))) throw new Error("Invalid notification details");
  await email.send({ from, to, subject: `Castloop publication failed: ${notice.showId}`,
    text: [`Show: ${notice.showId}`, `Target: ${notice.target}`, `Revision: ${notice.revision}`, `Operation: ${notice.operationId ?? "unknown"}`,
      `Time: ${new Date(notice.at).toISOString()}`, `Reason: ${notice.code}`, "Run castloop check and use castloop recover after correcting the problem."].join("\n") });
  return "accepted";
}

interface FailedOutcome {
  target: string; desired_identity: string; attempt_revision: number | null; state: string;
  error: { code: string; operation_id: string | null; at: number } | null;
  notification: "unconfigured" | "pending" | "accepted" | "failed" | null;
}

/** Claim each failure before invoking the notifier, and only update the same failure afterwards. */
export async function notifyFailures(storage: DurableObjectStorage, showId: string, revision: number | undefined,
  send: (notice: FailureNotice) => Promise<"accepted" | "unconfigured">): Promise<void> {
  const candidates = storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE state = 'failed'").toArray();
  for (const row of candidates) {
    const observed = JSON.parse(row.record_json) as FailedOutcome;
    if (observed.attempt_revision === null || (revision !== undefined && observed.attempt_revision !== revision) || observed.notification !== "unconfigured" || !observed.error) continue;
    const attemptedRevision = observed.attempt_revision;
    const claimed = storage.transactionSync(() => {
      const currentRow = storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ? AND state = 'failed'", observed.target).toArray()[0];
      if (!currentRow) return false;
      const current = JSON.parse(currentRow.record_json) as FailedOutcome;
      if (current.desired_identity !== observed.desired_identity || current.attempt_revision !== attemptedRevision || current.error?.at !== observed.error?.at || current.notification !== "unconfigured") return false;
      current.notification = "pending";
      storage.sql.exec("UPDATE publication_outcomes SET record_json = ? WHERE target = ?", JSON.stringify(current), current.target);
      return true;
    });
    if (!claimed) continue;
    let result: "accepted" | "unconfigured" | "failed";
    try { result = await send({ showId, target: observed.target, revision: attemptedRevision, operationId: observed.error.operation_id, at: observed.error.at, code: observed.error.code }); }
    catch { result = "failed"; console.error(JSON.stringify({ event: "notification_failed", show_id: showId, target: observed.target, revision: attemptedRevision })); }
    storage.transactionSync(() => {
      const currentRow = storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ? AND state = 'failed'", observed.target).toArray()[0];
      if (!currentRow) return;
      const current = JSON.parse(currentRow.record_json) as FailedOutcome;
      if (current.desired_identity !== observed.desired_identity || current.attempt_revision !== attemptedRevision || current.error?.at !== observed.error?.at || current.notification !== "pending") return;
      current.notification = result;
      storage.sql.exec("UPDATE publication_outcomes SET record_json = ? WHERE target = ?", JSON.stringify(current), current.target);
    });
  }
}
