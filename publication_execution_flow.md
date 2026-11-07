# Publication and full-restart recovery

**Authority:** [Approved design](./docs/designs/castloop-mvp.md#detailed-implementation-plan). The approved Detailed Implementation Plan, sections 4–7, defines the shared executor, target signatures, source pins, atomic SQL/alarm changes and restore hold/resume. Older outstanding-topic references below are historical, not open author decisions.

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Proposed step 3, following accepted staged R2 uploads and atomic SQLite acceptance. The user has accepted the minimum SQLite information groups and show DO alarms for scheduled publication. The user selected no automatic application retries in the MVP: record/report failures, email when configured, and restart from latest accepted state on administrator action.

## One publication operation

Use one show publication function for accepted CLI updates, due releases and retries. It reads current accepted SQLite references and their immutable R2 contents. The caller does not supply a stale publication plan to replay.

For each invocation:

1. Read the accepted show revision, source references and current time. Load current TOML and existing persisted media facts; do not download MP3 bodies for validation. Check show validity before changing public storage.
2. If the show is invalid, report the show error and preserve the last valid feed and its media/cover. Block new episode publication and due reservations. Invalid input is not a transient infrastructure failure to retry repeatedly without a source change.
3. If the show is intentionally unpublished with the required earlier confirmation, withdraw its delivery feed, audio and cover, including cache invalidation. Source assets stay private in management R2. An unpublished show has no active scheduled episode release.
4. Otherwise, validate episodes and determine the complete currently eligible set: show and episode publication flags true, required metadata/media valid, and release instant reached. Future episodes remain scheduled. Invalid, unpublished or deleted episodes must be absent from the public feed and have no publicly served audio. Prepare and validate the complete new XML before destructive public changes where possible. Never patch the old XML.
5. Apply media changes for affected episodes only. For first publication, replacement or a failed attempt being retried, delete that episode's delivery files and copy current eligible source through R2-side requests. For withdrawal or invalidity, delete the public copies without recopying. Preserve unrelated episodes' correct MP3s. Apply the same retained-source principle to cover changes; the invalid-show exception takes precedence.
6. Ensure newly advertised media is available through the applicable delivery/cache path, then delete the previous feed and write the complete newly generated feed. Apply feed/media cache invalidation as required. Exact cache APIs and ordering belong to step 4 of the outstanding design topics. Cache failure counts as incomplete delivery.
7. Record the outcome in SQLite only after the necessary public work succeeds. Recheck that the accepted revision still matches before marking it applied. A source change during external I/O must not be marked completed by an older run; arrange another run against latest accepted input. A scheduled release can require work even when the source revision has not changed, so completion cannot be judged by source revision alone.

This is not atomic public delivery. Temporary missing feed/audio or stale delivery during retries is accepted. Do not add a distributed transaction to eliminate that window.

## Selecting affected episodes

Use accepted references and small per-episode publication outcomes to determine which episodes need publication, replacement or withdrawal. Keep a withdrawn/deleted target discoverable until its public cleanup succeeds; deleting its SQL row immediately would lose that information. A pending cleanup identity is an outcome requirement, not a copy/render stage journal.

Metadata-only changes rebuild the whole feed but need not recopy an unchanged MP3. A retry of incomplete episode publication does restart its public file handling from deletion. Do not inspect which part of the previous copy succeeded. Do not use whole-feed regeneration as a reason to recopy the whole audio archive.

Last-valid-show delivery may reference older source objects than current accepted input. Keep that minimal retained information and its assets until valid replacement or deliberate withdrawal. Cleanup must not delete them simply because new invalid show TOML was accepted.

## Concurrency

Prefer at most one active publication run per show. A small in-memory busy flag can prevent ordinary overlapping execution; it is not a persistent distributed lock. Do not hold an SQL transaction or a broad concurrency block across R2 copying and cache requests.

If another update is accepted while publication is busy, its SQL state remains pending and the caller receives accepted-but-pending rather than a false published result. One invocation performs one captured affected-show batch and does not loop over newer revisions. Any uncovered concurrent update remains visibly pending for explicit manual recovery, even if runtime remains. A restarted instance or late external write can still cause temporary overlap; preserve the accepted eventual-convergence policy. Do not make correctness depend solely on an in-memory pending flag.

No durable FIFO is required. Coalescing several accepted changes into one application of latest intent is allowed. Stale runs never restore old accepted source state.

## Failure reporting and retry

* Source rejection: no accepted SQL change. Explain the conflict or input acceptance error.
* Source accepted but publication-invalid: keep source and return validation details. Invalid show preserves working delivery; invalid episode is withdrawn. Distinguish successful withdrawal with validation errors from an infrastructure failure during withdrawal.
* Scheduled: accepted input is waiting for its release time; this is not a publication error.
* Delivery incomplete: source is accepted, but copying, feed replacement or cache work failed. Keep the target needing application and the error. Never return published success.
* Delivery applied: the current required public state was produced, including intended absence. A scheduled episode's future release can still remain pending.

The CLI can retry an uncertain request with its saved operation ID. An already accepted operation is not accepted again. A retry runs publication from latest accepted state; it does not replay old intent after newer input. Automatic application repair retries are excluded from the MVP. Administrator-initiated repair invokes this same function. No recovery path resumes at a stored copy/render stage.

## Timed invocation: next decision within step 3

**Accepted refinement:** Use the show DO's alarm for future release; the Cron routing candidate is superseded. The user selected no automatic application retries for the MVP; failures are recorded/reported and emailed when configured. Administrator-initiated recovery restarts from latest accepted input. First specify durable errors and administrator notification; see [failure handling](./publication_errors_and_notifications.md). Alarm retry infrastructure must not accidentally create more publication attempts than the selected policy. Earlier retry recommendations below remain proposals only.

Unattended future publication still needs a timer. Recommend evaluating a single DO alarm per show for the earliest due release or retry, rather than periodic Cron discovery of CLI source changes. This is a proposal, not yet an accepted scheduler change. It needs no Cloudflare Queue or Agents SDK.

The alarm handler must be idempotent, as the platform can repeat it. Timer arming must cover a process stopping after acceptance but before immediate publication, and stopping during alarm handling; merely setting an alarm at the end leaves a gap. Specify that ordering before claiming automatic recovery. There is no requirement for unnotified R2 staging objects to be automatically accepted.

See [DO idempotent alarm guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#make-alarm-handlers-idempotent). The precise alarm/transaction wiring and retry policy remain to settle. Do not combine Cron and alarms by default.
