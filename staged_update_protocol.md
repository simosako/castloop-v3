# Staged updates and repeatable publication

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Accepted by the user: stage immutable R2 objects, then commit accepted object references in DO SQLite. The older R2-manifest proposal below is retained for comparison and is superseded by this section.

## Accepted decision: SQLite is the acceptance point

The user accepted replacing the R2 `current.json` proposal with a small SQLite management table in the show DO. R2 holds immutable TOML/audio/cover contents; SQLite is authoritative for which versions are accepted. SQLite can also hold derived scheduling and publication facts. This changes the earlier rule that all SQLite state is disposable and reconstructible from R2 alone. Unreferenced staging files do not prove acceptance, so listing R2 cannot reconstruct the selected state reliably.

Use this responsibility split rather than keeping both an authoritative R2 manifest and an authoritative SQL selection table. Administrators still edit TOML; they do not edit SQL or a manifest.

### Minimum records

The user accepted storing show/episode source references, revision and operation identity, scheduled release times, and publication outcome/retry-needed information in SQLite. Exact columns and table boundaries remain implementation details. These records must describe accepted input and public outcomes, not individual completed processing stages.

* A show control row: current accepted revision and last accepting operation ID/request fingerprint.
* Accepted source references: entity ID, TOML key/identity, optional audio/cover key/identity and inspected media facts. Missing required metadata/media can still be saved and reported as publication-invalid under the existing rules.
* Small publication status: desired revision, last completed revision and the latest error as needed. These describe outcome, not completed copy/render stages.

These are logical information groups, not a requirement for three tables or an operation-history ledger. Keep the physical schema small during drafting.

### Update flow

1. CLI performs syntax preflight and prepares changed immutable R2 objects with a saved operation ID, request fingerprint and expected accepted revision. Large files upload directly through S3. Prepared keys are unique and are not overwritten for a different request.
2. CLI notifies the DO only after uploads finish. The DO verifies object identities, request eligibility and current show rules. R2 reads and media inspection checks happen before the SQL transaction; no network await belongs inside it.
3. In one synchronous SQLite transaction, recognize a matching duplicate first, recheck the current expected revision and relevant show state, replace all affected accepted references, advance the revision, record the operation identity and mark publication as needing application. Throwing aborts the transaction. The revision/state recheck is needed because external awaits before this transaction can interleave with other requests.
4. After commit, run publication using the latest accepted references. If publication fails, report accepted-but-incomplete. Retry restarts affected public work from the beginning and never undoes accepted source input merely because delivery failed.

An incomplete R2 preparation leaves no SQL change. A failure before SQL commit leaves the old selection. A lost response after commit is handled by retrying the same operation ID and request. A matching last operation must be recognized even though its original expected revision is now older. If a later operation has already committed, reject the stale request instead of replaying old intent. An operation ID reused with different input is an error.

Accepted object references point at immutable keys, so an R2 mutation is not required after SQL commit to finish source acceptance. Retain selected objects even if the prefix was initially used for preparation. If using a literal expiring `tmp/` area, copy to retained immutable keys before the SQL commit. Never expire accepted source files through a blanket staging lifecycle rule.

### Recovery and scope

The SQL transaction makes source acceptance atomic. It does not include R2 copies, RSS replacement or cache invalidation. Delivery remains repeatable and eventually convergent as already agreed. No transaction spans R2 and SQLite: all object preparation comes first, and only the reference selection needs to commit atomically.

Retry after DO termination reads durable SQL state; it does not need to infer which individual public copy/render stages completed. No Cron scan is required to accept unnotified uploads. Scheduled future release still needs a timer; its implementation remains separate.

Deleting the DO database would now lose accepted version selection. Treat it as persistent service data, not a throwaway cache. A minimal backup/export and restore policy belongs in drafting; do not introduce a second live authoritative manifest merely for this purpose. Cleanup must preserve SQL-selected and retained last-valid-show objects; if the management table is unavailable, do not guess that everything is unused.

Cloudflare provides `ctx.storage.transactionSync()` for synchronous SQLite operations and rolls the transaction back if its callback throws. External R2 operations are outside that boundary. See [DO SQLite transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync).

## Earlier alternative: R2 manifest

The following sections describe the previous alternative. References to an authoritative manifest or fully reconstructible SQL index apply only to that alternative.

## Boundary

Uploading a file does not accept a change. The CLI prepares all changed files in management R2, then asks the show DO to accept them. A CLI crash before that request leaves unused private files, not a partly accepted change. Do not use Cron to discover and accept abandoned uploads.

Separate two outcomes: accepting new source input, and finishing public delivery. Make source acceptance atomic through one R2 object replacement. Public MP3s, RSS and caches still change in several steps and follow the agreed eventual-convergence policy. No transaction spans those services.

## Proposed single acceptance point

Use a small `s-.../current.json` manifest per show. It identifies the accepted show TOML and each accepted episode's TOML, audio and generated media facts, plus the cover. Entries reference immutable management objects. Include a fresh revision and the accepting operation ID. A metadata-only change references the existing MP3; it does not upload it again.

The CLI prepares changed objects under a unique operation prefix, for example `s-.../_revisions/<operation-id>/...`. Until selected by the manifest, these are staging objects. Once selected, they are retained source objects. This avoids moving or copying the MP3 merely to rename a temporary directory. There are no real directories to rename in R2.

The CLI's local layout stays `s-.../show.toml` and `s-.../e-.../episode.toml`. Pull resolves accepted manifest references back into those filenames. This proposal refines the earlier physical R2 layout: authoritative TOML is still in R2, but its accepted version is selected by the manifest, rather than overwritten at a fixed TOML key. The manifest is generated control information, not another user-editable configuration file. Do not keep a second supposedly authoritative fixed-key TOML copy.

If a literal `tmp/` prefix is preferred, the DO must copy its files to immutable retained keys before committing the manifest. That adds copying but does not change the acceptance rule. Do not commit references into a prefix subject to unconditional expiry.

## Normal operation

1. CLI parses and normalizes TOML, inspects changed media, obtains the accepted manifest revision and persists an operation ID locally before upload. The ID denotes this exact request, including its base revision and prepared object identities. Changed input requires a new ID. Preserve the existing pull/push baseline check and show-stop confirmation.
2. CLI uploads only changed objects directly to management R2 through S3. Use unique immutable keys; complete uploads before sending the acceptance request. A final small request description identifies all prepared objects, their identities and intended target. It cannot select arbitrary objects outside the installation/show.
3. CLI asks the show DO to accept that operation. The DO reads the current manifest, checks the expected base revision, prepared objects and supported identities/formats, and applies acceptance rules. An invalid current show rejects episode changes before acceptance. Publication-readiness errors in otherwise acceptable TOML do not reject source storage.
4. DO writes the new complete manifest with an ETag condition against the previously read manifest. This single conditional write is the source acceptance point. For a new show, use a create-only condition. A failed condition is a conflict, not permission to overwrite newer input.
5. DO refreshes its derived SQLite index from the accepted manifest and runs the current publication operation. Publication-invalid show input preserves last valid delivery; publication-invalid episode input withdraws that episode as already agreed. Accepted but incomplete delivery is reported separately from rejected input.
6. CLI records the accepted baseline and reports the result. There is no separate publish command.

The manifest is small metadata, not a copy of every TOML or an audio body. It grows with the episode count; measure representative archives before fixing its format. Rewriting a small per-show object for an administrator update avoids adding a transaction service or a command queue.

## Failure and retry behavior

| Failure | Effect | Retry |
| --- | --- | --- |
| CLI stops during preparation or before notification | Accepted manifest and public delivery are unchanged | Finish/repeat preparation and submit; unused objects can be cleaned later |
| DO stops before manifest commit | Previous input remains accepted | Repeat the same request; verify the manifest because a lost response alone does not establish failure |
| Manifest commit succeeds but response is lost | The whole new source selection is accepted | Same operation ID and request identify the already accepted revision; do not accept it a second time |
| Manifest commits but SQLite refresh or delivery fails | Accepted source remains in R2; delivery may be incomplete | Refresh derived state, then restart affected delivery work from the beginning |
| Another update has since been accepted | Old base revision no longer matches | Reject the stale request and pull current state; never replay the older intent over it |

The CLI must reuse the saved operation ID when retrying an uncertain request. A new process can read that local receipt; do not rely on an in-memory random ID. The current manifest's operation ID is enough to recognize an immediate duplicate. If a newer revision already exists, return a conflict/superseded result rather than add an indefinite operation-history ledger merely to report the older request as successful.

Before deciding to commit, recognize a duplicate already selected by the manifest. On a duplicate, rebuild from the current accepted revision only if publication is incomplete or needs repair. A successful duplicate need not recreate already correct media. On a genuine repair, delete affected delivery objects and rebuild from the beginning; never track completed stages or resume partway through a copy/feed procedure.

External awaits can interleave. The manifest condition protects source acceptance, and publication must re-read/check the current accepted revision when handling overlap. Temporary stale delivery remains acceptable; retry uses latest accepted state, not the saved old command. Exact per-show busy handling can remain small and need not become a durable FIFO.

## Scheduling and cleanup

Cron is not the mechanism for accepting CLI changes or rescuing unnotified uploads. Future release still needs a timed trigger after the CLI exits; whether that is the previously discussed Cron candidate or a DO alarm is a separate decision. This proposal does not remove scheduled publication.

A DO alarm could later provide bounded automatic retries of already accepted but incomplete delivery. It is not needed to discover abandoned staging uploads. Do not introduce both Cron and alarms without a concrete need, and do not promise an unaccepted upload will eventually apply itself.

For cleanup, retain every object referenced by the current manifest and any retained last-valid-show material. Remove only sufficiently old unreferenced operation objects, outside the retry/in-flight grace period. Old accepted revisions become eligible only when nothing retained references them. Never apply a blanket expiry to all revision objects. Cleanup can initially be an explicit maintenance action; its exact timing and retained-history policy remain open. Multipart-upload leftovers need their own abort/expiry handling.

## Technical basis

R2 conditional writes evaluate the condition atomically when the single object commits. This supports the proposed manifest acceptance point; it does not create a multi-object transaction. See [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) and [R2 conditional binding writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations).

This design keeps R2 authoritative and SQLite reconstructible from the selected R2 source. A process dying between the manifest write and SQLite refresh does not lose the accepted input. Checking one manifest on an update/retry is sufficient to discover that mismatch; scanning all staging objects every minute is unnecessary.
