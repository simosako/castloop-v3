/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { notifyFailures, sendFailureNotice } from "../src/notification";
import type { ShowDO } from "../src";

const showId = "s-01234567";
const operationId = "12345678-1234-4234-8234-123456789abc";
const failure = () => ({ target: "feed", desired_identity: "a", attempt_revision: 1, state: "failed", error: { code: "delivery_failed", operation_id: operationId, at: 1000 }, notification: "unconfigured" });

test("private notifier service reports an unconfigured installation", async () => {
  expect(await env.NOTIFIER.send({ showId, target: "feed", revision: 1, operationId, at: 1000, code: "delivery_failed" })).toBe("unconfigured");
});

test("email uses only configured addresses and safe failure details", async () => {
  const sent: unknown[] = [];
  const email = { send: async (message: unknown) => { sent.push(message); return { messageId: "id" }; } } as SendEmail;
  const notice = { showId, target: "feed", revision: 1, operationId, at: 1000, code: "delivery_failed" };
  expect(await sendFailureNotice(email, "", "admin@example.com", notice)).toBe("unconfigured");
  expect(await sendFailureNotice(email, "from@example.com", "admin@example.com", notice)).toBe("accepted");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ from: "from@example.com", to: "admin@example.com", subject: `Castloop publication failed: ${showId}` });
  await expect(sendFailureNotice(email, "from@example.com", "admin@example.com", { ...notice, code: "secret:foo" })).rejects.toThrow();
});

test("failure is persisted before notification, and send failure is not retried", async () => {
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES ('feed', 'failed', ?)", JSON.stringify(failure()));
    let sends = 0;
    const send = async () => {
      sends++;
      const current = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = 'feed'").one().record_json);
      expect(current.state).toBe("failed");
      expect(current.notification).toBe("pending");
      throw new Error("mail unavailable");
    };
    await notifyFailures(state.storage, showId, 1, send);
    await notifyFailures(state.storage, showId, 1, send);
    const result = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = 'feed'").one().record_json);
    expect(result.notification).toBe("failed");
    expect(result.error.code).toBe("delivery_failed");
    expect(sends).toBe(1);
  });
});

test("an older notification cannot overwrite a newer failure", async () => {
  await runInDurableObject(env.SHOWS.getByName("s-12345678"), async (_instance, state) => {
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES ('feed', 'failed', ?)", JSON.stringify(failure()));
    await notifyFailures(state.storage, showId, 1, async () => {
      const newer = { ...failure(), desired_identity: "new", attempt_revision: 2 };
      state.storage.sql.exec("UPDATE publication_outcomes SET record_json = ? WHERE target = 'feed'", JSON.stringify(newer));
      return "accepted";
    });
    const result = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = 'feed'").one().record_json);
    expect(result.desired_identity).toBe("new");
    expect(result.notification).toBe("unconfigured");
  });
});

test("a failure remains eligible for notification when a newer revision is accepted", async () => {
  const id = "s-23456789";
  await runInDurableObject(env.SHOWS.getByName(id), async (instance: ShowDO, state) => {
    const control = { record_version: 1, show_id: id, revision: 1, metadata: null, cover: null, deleted: false, accepted_at: 1,
      last_receipt: null, current_delivery: { base: "https://delivery.example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", id, JSON.stringify(control));
    const target = instance as unknown as { publishOnce: () => Promise<"failed">; runPublication: (show: string, trigger: "acceptance") => Promise<string>; env: Omit<Env, "EMAIL_FROM" | "EMAIL_TO"> & { EMAIL_FROM: string; EMAIL_TO: string } };
    const previousFrom = target.env.EMAIL_FROM, previousTo = target.env.EMAIL_TO;
    target.env.EMAIL_FROM = "sender@example.com";
    target.env.EMAIL_TO = "admin@example.com";
    const send = vi.spyOn(target.env.NOTIFIER, "send").mockResolvedValue("accepted");
    const publish = vi.spyOn(target, "publishOnce").mockImplementation(async () => {
      state.storage.sql.exec("INSERT INTO publication_outcomes VALUES ('feed', 'failed', ?)", JSON.stringify(failure()));
      state.storage.sql.exec("INSERT INTO publication_outcomes VALUES ('e-01234567', 'failed', ?)", JSON.stringify({ ...failure(), target: "e-01234567", attempt_revision: 2 }));
      state.storage.sql.exec("UPDATE show_control SET revision = 3, record_json = ?", JSON.stringify({ ...control, revision: 3 }));
      return "failed";
    });
    try {
      expect(await target.runPublication(id, "acceptance")).toBe("failed");
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ showId: id, revision: 1, target: "feed" }));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ showId: id, revision: 2, target: "e-01234567" }));
      expect(send).toHaveBeenCalledTimes(2);
      const outcome = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = 'feed'").one().record_json);
      expect(outcome.notification).toBe("accepted");
    } finally { send.mockRestore(); publish.mockRestore(); target.env.EMAIL_FROM = previousFrom; target.env.EMAIL_TO = previousTo; }
  });
});

test("unconfigured email does not dispatch notification service calls", async () => {
  const id = "s-3456789a";
  await runInDurableObject(env.SHOWS.getByName(id), async (instance: ShowDO, state) => {
    const target = instance as unknown as { publishOnce: () => Promise<"failed">; runPublication: (show: string, trigger: "acceptance") => Promise<string>; env: Env };
    const previousFrom = target.env.EMAIL_FROM, previousTo = target.env.EMAIL_TO;
    target.env.EMAIL_FROM = ""; target.env.EMAIL_TO = "";
    const send = vi.spyOn(target.env.NOTIFIER, "send");
    const publish = vi.spyOn(target, "publishOnce").mockImplementation(async () => {
      state.storage.sql.exec("INSERT INTO publication_outcomes VALUES ('feed', 'failed', ?)", JSON.stringify(failure()));
      return "failed";
    });
    try {
      expect(await target.runPublication(id, "acceptance")).toBe("failed");
      expect(send).not.toHaveBeenCalled();
      const outcome = JSON.parse(state.storage.sql.exec<{record_json:string}>("SELECT record_json FROM publication_outcomes WHERE target = 'feed'").one().record_json);
      expect(outcome.notification).toBe("unconfigured");
    } finally { send.mockRestore(); publish.mockRestore(); target.env.EMAIL_FROM = previousFrom; target.env.EMAIL_TO = previousTo; }
  });
});
