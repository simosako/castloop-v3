# Publication errors and administrator notification

**Authority:** [Approved design](../castloop-mvp.md#detailed-implementation-plan). The approved Detailed Implementation Plan defines Workers Logs plus compact current SQL failure state, optional restricted email through the management Worker, SQL/alarm transactions and explicit recover commands. Historical Issues/notification candidates below are not required integrations.

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Show DO alarms accepted for scheduled publication. The user requires bounded failure handling, prioritizes recording and notification, and selected administrator email with name/address in show TOML. Accepted retry policy: no automatic application retries in the MVP. Record/report failures, email when optional Cloudflare mail setup is configured, and let the administrator initiate recovery from latest accepted input.

## Email selected by the user

Administrator name and email belong in management-only show TOML; proposed fields are `[admin].name` and `[admin].email`. Do not insert them into public RSS automatically. Apple no longer recommends the owner contact tag/email; it is not required by the Apple baseline. See [Apple's technical update](https://podcasters.apple.com/4115-technical-updates-for-hosting-providers).

For a Cloudflare-only implementation, sending to an account's verified destination address is free on Free and Paid plans. An arbitrary recipient is not equivalent to a verified destination, and TOML alone does not verify an address. See [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/). Sender addresses must belong to a configured routing/sending domain; do not assume a workers.dev deployment supplies an email sender domain. See [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) and [send binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

Recommend direct Email Service notification of a recorded publication error for installations with mail configured, using the platform Workers binding from the management layer where supported. Verify exact DO/Worker binding placement during drafting. Keep sender-domain and binding configuration at installation scope, with each show's TOML selecting its verified administrator recipient. Do not require a paid arbitrary-recipient sending service when only a verified administrator destination is needed.

Record the original failure before sending a concise email containing target, time, error ID/message and how to inspect/retry. Sending failure is a separate recorded notification outcome and must not cause publication to run again or send an email about its own email failure. A successful send API response means provider acceptance, not guaranteed inbox delivery. Preserve logs/CLI inspection when mail or SQL is unavailable.

Accepted policy: Cloudflare email notification setup is optional. With a configured sender domain and verified administrator destination, send publication-error emails. Without mail setup, podcast hosting still works without a custom domain; retain error records, platform logs and CLI inspection, and clearly report notification as unconfigured. Administrator name/email in show TOML are private management information and are not automatically included in RSS. Workers Issues remains useful for hard failures and diagnostic monitoring, but is no longer the assumed way to deliver application-specific error emails. The separately accepted application policy is no automatic retry in the MVP.

## Accepted MVP behavior

The user accepted no automatic application retries in the MVP. On a catchable publication failure, record the failure, stop that publication attempt, return an error to a connected CLI, and emit a structured error log for unattended operations. Keep accepted SQL source references intact and leave delivery marked incomplete. An administrator may explicitly request a new full attempt from latest accepted state after investigating; exact CLI recovery syntax remains to define. This is an error-recovery action, not a required manual publish gate.

Possible infrastructure failures include R2 API errors/timeouts, invalid or revoked copy credentials, a selected source object missing unexpectedly, and a failed cache purge. These illustrate where errors arise; they are not a reason to build a classification engine or assume retry fixes configuration. Validation errors remain input feedback under the existing rules, with different invalid-show and invalid-episode consequences.

## Durable failure information

Store a small current unresolved failure record per affected publication target, retaining at least:

* Error ID, occurrence time, show ID and affected episode ID if applicable.
* Accepted revision and operation ID when applicable; trigger origin (CLI or scheduled release).
* Error code, short actionable message, and the operation that failed (source read, copy, feed write or cache purge).
* Public outcome: input rejected, validation blocked, or accepted but delivery incomplete.

An error's failed operation is diagnostic context, never a saved execution cursor. Recovery always starts affected publication from the beginning. Preserve an unresolved failure until successful repair or explicit resolution; unrelated successful work must not silently erase it. Avoid an indefinite audit-history subsystem; detailed stack traces can remain in platform logs.

Include unresolved publication failures in the existing read-only `castloop check` result and show a concise warning during ordinary management commands. CLI feedback and later inspection are useful but do not notify an administrator while the CLI is closed.

If SQLite is unavailable, a failure may not be persistable there. Log through platform observability as a second diagnostic path. Hard termination and resource exhaustion can bypass application catch/record code; do not promise every failure reaches SQL or that application code can notify after execution has stopped.

## Historical notification alternative (superseded)

Prefer platform observability and a configured notification destination before writing a notification delivery service inside castloop. Workers Logs provides diagnostic logs. Workers Issues can detect handled errors sent to `console.error`, group them, and use automation to send an issue to a webhook/chat destination. It is available to all Workers accounts and free during its current open beta. These are current service properties, not a permanent pricing guarantee. See [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/).

Issue automations can trigger at an occurrence threshold or after inactivity; they do not necessarily send one notification per publication failure. Notification is a prompt to inspect the durable castloop error result. See [Issue automations](https://developers.cloudflare.com/workers/observability/issues/automations/).

At the time of this historical alternative, the administrator destination had not been selected; the later accepted policy is optional verified administrator email. Do not claim that logging alone is proactive notification, that an arbitrary email destination is supported by Issues, or that an unspecified webhook can send messages without setup. Confirm the desired destination before settling the integration. Validate DO alarm error capture in the selected observability configuration during implementation. No alerts or messages have been configured or sent during brainstorming.

If notification delivery fails, do not rerun podcast publication merely to resend the notification. The recorded publication failure remains visible through CLI inspection and platform logs. Avoid a dedicated notification queue for the MVP unless an agreed requirement makes it necessary.

## Alarm retry policy

Cloudflare's alarm handler has at-least-once execution and retries uncaught exceptions with exponential backoff, starting at two seconds, up to six retries. Merely omitting a castloop retry loop does not disable these platform retries. See [DO alarm handler](https://developers.cloudflare.com/durable-objects/api/base/#alarm).

Under the accepted no-application-retry policy, catch expected publication failures, record/log them, and finish that alarm occurrence without rethrowing solely to invoke platform retry. A failed reservation must not keep scheduling itself immediately because its original due time is in the past. Mark that publication target failed and awaiting administrator action; continue to schedule genuinely different future reservations. Do not let a later reservation incidentally erase that error or silently spend another automatic attempt on the failed target. The shared-feed effect of a later reservation must respect persisted failure state until explicitly repaired or replaced by a newly accepted change.

Repeated delivery of an alarm must check durable outcome before doing work. A matching completed/failed occurrence should not blindly rerun public side effects. A hard termination before outcome recording is still uncertain; at-least-once infrastructure means this design cannot promise exactly one physical attempt under every crash condition. Use bounded durable attempt accounting if a strict application-attempt cap is selected; do not add stage-resume machinery.

One show alarm schedules the next actual reservation, not a periodic failed-work scan. Safe timer arming around acceptance and handler termination remains an implementation design detail to settle. A one-extra-attempt policy was considered and not selected for the MVP. Do not layer an independent retry timer over uncaught platform retries and call the total bounded by one.
