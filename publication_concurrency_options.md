# Publication concurrency: bounded MVP options

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Revised after the user's consistency-policy clarification. Eventual convergence is accepted; the mechanism is not selected. The earlier strict-lock recommendation below is retained as discussion history and is superseded by the governing policy.

## Accepted policy and revised direction

Subsequent service decision: one show DO with SQLite is now accepted for full feed generation and derived state, without an explicit publish command. This does not adopt the historical non-expiring-lock option or an ordered queue, and does not strengthen the eventual-convergence requirement. See [the accepted decision](./feed_execution_and_state_options.md#accepted-decision). The earlier candidate comparisons below are historical where they conflict with that placement.

The user explicitly permits temporary incorrect public state during concurrent publication and recovery. If a stale Cron copy briefly restores an MP3 after withdrawal, detecting the mismatch and withdrawing it again is sufficient. Castloop must converge to the latest accepted administrator intent; it need not prevent every intermediate inconsistency.

The earlier assessment rejected simple retries against a stronger requirement than the product needs. Reconsider reconciliation/retry without locks first. Locks remain an option to reduce contention, not a prerequisite for correctness under this accepted policy. No automatic recovery deadline, permanent lock, command queue, or DO follows from the policy itself.

For a retry candidate, distinguish these responsibilities:

1. Preserve authoritative metadata with the accepted conditional push and backup-on-pull rules. A publication retry never re-saves stale user intent over newer accepted source.
2. Read the latest source and derive the desired effective delivery under the accepted validation, publication flags, release time, and last-valid-show rules.
3. Apply media, feed and cache changes. If relevant revisions changed or the observed result differs from current intended delivery, read again and reconcile. Do not replay an obsolete publish/unpublish command blindly.
4. Bound retries in each invocation and report incomplete work. Ensure repair remains discoverable after an invocation ends or crashes, including after a newer operation finishes but an older in-flight write completes later. A final revision check alone does not cover a crash before that check or a later stale write. Decide a small pending/verification mechanism or bounded periodic reconciliation during drafting; do not assume one check solves this.
5. Include cancellation/deletion/unpublish in repair discovery, not only future releases. A lock-free design that stops tracking an unpublished/deleted entity before late writes settle could otherwise leave it public indefinitely. The minimal retained evidence and cleanup policy remain open.

Normal publication should continue to prepare media before RSS. Temporary inconsistency tolerance does not remove syntax checks, source-edit protection, show-stop confirmation, media-upload separation, or useful failure reporting. A `check` operation remains read-only; any repair operation is separate. Avoid scanning the whole archive every minute without considering cost.

The [recovery options](./publication_recovery_options.md) compare periodic verification, pending-show records, and a combination. This is a revised investigation direction, not an adopted lock-free implementation.

## Boundary of the problem

The user expects timed publication to be short: issue R2-side media copies, update feed XML, and handle caches. No MP3 body goes through a Worker. Short duration lowers expected contention, but does not make separate R2 operations atomic. Copy latency and cache operations still require measurement; do not assume an upper bound from episode size or typical execution time.

The coordination scope is one show: its authoritative metadata changes, reservation changes, delivery media, and shared feed. Locking only the feed or only an individual episode does not protect this scope. Different shows can proceed independently.

## What official documentation establishes

* R2 atomically evaluates `If-Match` and `If-None-Match` on a single `PutObject`. Competing create-if-absent writes to the same key have at most one successful writer. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/), [S3 conditional operations](https://developers.cloudflare.com/r2/api/s3/extensions/#conditional-operations-in-putobject)
* A missing object read does not prove an earlier write with an unknown result failed. An in-flight request can commit later. This matters both for lock creation and publication recovery. [R2 negative reads and in-flight writes](https://developers.cloudflare.com/r2/reference/consistency/#negative-reads-and-in-flight-writes)
* Cloudflare Queues does not guarantee publication-order delivery and uses at-least-once delivery. Setting consumer concurrency to one does not turn delivery into FIFO or remove duplicates. [Queue ordering](https://developers.cloudflare.com/queues/reference/how-queues-works/), [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
* Durable Object handlers can interleave while awaiting external I/O, including R2. Routing all calls to one object is not by itself sufficient to serialize the whole publication operation. [Concurrency rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
* SQLite-backed Durable Objects are available on Workers Free, subject to compute and storage limits. Availability does not establish that a particular implementation fits the free allowance. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Earlier analysis: a revision check does not prevent every transient error

Consider a scheduled publisher A that has selected an episode while CLI operation B withdraws it:

1. A reads the old valid source and prepares its copy/feed writes.
2. B saves `publish = false`, removes the public MP3 and removes the feed entry.
3. A's previously started copy finishes after B's deletion, restoring public bytes.
4. A might detect a feed ETag mismatch and retry, but rejecting its feed write has not prevented the audio from reappearing.

Checking source revisions immediately before writing leaves a check/write window. A conditional feed write protects that feed object against another feed revision, not the metadata, media copies/deletions, or caches. Immutable candidate keys and a conditional publication pointer can simplify an alternative design, but direct CDN-to-R2 access does not consult a private pointer to authorize media, and withdrawal/cleanup still needs coordination. This is an architectural inference, not a claim that optimistic publication is impossible in every architecture.

Under the user's clarified policy, this example does not disqualify retry-based reconciliation: temporary resurrection is permitted if a later repair removes it. What remains necessary is detecting or revisiting the mismatch, including after crashes and late writes. The following lock discussion documents an earlier, stricter option; it is not the current baseline recommendation.

## Comparison

| Option | Added machinery | Main tradeoff |
| --- | --- | --- |
| R2 show lock with no automatic takeover | One private lock object per active show operation; conditional create; bounded CLI wait; explicit recovery | Lowest infrastructure cost; an interrupted/uncertain operation can block that show's updates until administrator recovery |
| R2 expiring lease | Lease renewal, ownership changes, protection against old writers | Expiration alone is unsafe: a paused old owner can resume after a new owner starts. Every relevant side effect needs effective stale-owner protection |
| Queues as an ordered command log | Staging, deduplication, order/version checks, publication status, common CLI/Cron consumer | Queue delivery is not FIFO; concurrency one is insufficient. More moving parts than short, infrequent operations require |
| Show Durable Object as executor | Common mutation endpoint, explicit in-flight gate, restart/recovery state, R2 integration | Avoids a custom distributed lease, but does not make external R2 operations transactional; no custom SQLite FIFO is necessary merely to reject busy requests |
| Cron as sole delivery writer | CLI saves desired source; scheduled worker reconciles latest state | Can avoid a CLI delivery writer, but changes immediate CLI publication/withdrawal into asynchronous work. Cron overlap and snapshot/recovery still need control |

## Earlier option: non-expiring lock with manual abnormal recovery

This option uses a non-expiring R2 lock per show and retries to wait for that lock. It is not selected. Its operational cost must be weighed against a reconciliation approach that permits transient errors.

Illustrative private key: `_castloop/locks/<show-id>.json`. Include a unique operation token, origin (CLI/Cron), start time, and operation description. The token identifies ownership; the timestamp is diagnostic, not permission to steal a lock. Exact key/field names remain draft details.

Ordinary CLI flow:

1. Parse and preflight all candidate TOML locally. Obtain any show-stop confirmation before making changes, and recheck its applicability if source changes during preparation.
2. Upload large media directly to a new private candidate object before obtaining the lock. Do not overwrite a source object already referenced by an active reservation or publication. Do not activate the candidate reference yet. This separates transfer time from the protected operation and requires a source-revision representation in the draft.
3. Acquire the show lock using `PutObject` with `If-None-Match: *`. Wait with a bounded retry/backoff on a definite contention response; show progress and return a clear busy error at the wait limit. Never change canonical metadata or public delivery while waiting.
4. Once acquired, re-read current authoritative revisions. Reject an obsolete local editing baseline under the accepted pull/push rules. If CLI-prepared validation/feed artifacts depend on a changed snapshot, regenerate or abandon preparation and retry; do not apply them merely because the lock is now held.
5. Apply the accepted metadata/reservation changes and publication/withdrawal steps while holding this lock. Invalidate/supersede affected prepared reservations in this same protected operation. Preserve the accepted invalid-show/invalid-episode behavior and media-before-feed rule including cache handling.
6. Report success only for completed stages. Release the lock after all initiated mutations have settled and the outcome is known. A known partial failure is publication incomplete and needs current-state reconciliation, not a false success.

Ordinary Cron flow:

1. Discover candidate due shows using the eventual bounded scheduling index/design.
2. Attempt the same show lock. If definitely held, skip that show for this tick; do not build a second durable queue. The next tick considers still-valid overdue work.
3. After acquiring, read current source and reservation identities again. Recheck publication flags, validity, due time, and whether any prepared result still matches its source. Never use a pre-lock snapshot as authority.
4. Apply eligible work through the same publication rules, then release after known completion.

CLI metadata push, delete, unpublish, cover activation, and audio-reference activation all participate. Metadata pull and read-only check do not take a write lock. Direct source-upload preparation can run concurrently only because it uses unreferenced candidate keys; manually changing canonical R2 objects outside Castloop bypasses this cooperative protocol.

This does not guarantee fairness. A busy minute can delay a reservation beyond the normal one-to-two-minute target. The wait/retry limits, preparation size, batch size, and copy/cache latency must be bounded and measured in drafting.

## Stuck locks and uncertain outcomes

There are distinct cases:

* **Known contention:** another owner holds the lock. CLI waits within its budget; Cron skips and retries on a later tick.
* **Definite operation failure with no outstanding mutations:** report partial state and reconcile from current authority before claiming publication completion. Release is possible once it is safe for the next owner to act.
* **Owner crash or unknown request result:** keep the lock. Do not delete it automatically because a deadline elapsed. A timed-out R2 request may still complete later; a read showing absence is not proof of cancellation.

Provide an inspection/recovery operation, exact command spelling undecided. It shows the owner and operation and explains the affected show. Recovery must quiesce writers (including Cron), establish that the old owner cannot resume, and resolve unknown in-flight writes before removing the lock. Then reconcile feed, media, reservations and caches against current accepted source. A force-delete followed immediately by a new publisher is not a safe recovery protocol. If outstanding writes cannot be resolved, leave the show blocked and report that limitation; do not promise an arbitrary sleep makes recovery safe.

Do not automatically delete a lock in an unconditional `finally` block when mutation outcomes remain unknown. Do not delete another operation's lock after manual recovery. Duplicate acquisition attempts from an owner that lost the creation response need an explicit token-based recovery rule, not blind create/read/delete loops.

The practical tradeoff is deliberate: retain existing delivery and stop new changes for this show until recovery, rather than automatically starting a competing publisher. A crash during actual publication can still leave partial delivery; this lock is concurrency control, not rollback across R2 and caches.

## If manual recovery is unacceptable

Evaluate one DO executor per show, with CLI and Cron both calling it to apply changes. Keep the direct MP3 upload and CLI-heavy validation/feed preparation. Do not have the DO merely grant an expiring lock to a client that writes independently.

The executor can reject concurrent calls as busy for retry rather than maintaining a general FIFO. It still needs an explicit gate across external awaits, a small persisted in-flight operation identity for restart diagnosis, idempotent reconciliation, and a policy for uncertain R2 outcomes. Do not claim DO restart or SQLite transactions undo/cancel an R2 request. SQLite can store a few coordination values through its storage API; a custom queue schema is not required by the current workload.

Whether that added component is simpler overall depends on the required abnormal recovery behavior. This note does not select it or claim a complete fault-tolerant implementation.

## Superseded decision framing

The earlier choice between manual lock recovery and a shared DO executor was too narrow: it assumed preventing temporary incorrect delivery. The accepted eventual-convergence policy admits a third candidate, retry/reconciliation without a lock. Evaluate that first, retaining a small lock or executor only if it reduces total implementation and operational complexity.
