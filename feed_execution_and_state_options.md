# Feed execution and small publication state

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Choice 3 accepted: one show DO generates full feeds and uses SQLite for derived state. No explicit publish command. R2 remains authoritative. Comparisons below preserve the alternatives; the accepted section takes precedence over earlier conditional wording.

## Accepted decision

**Confirmed source acceptance:** The user accepted [SQLite as the acceptance point](./staged_update_protocol.md#accepted-decision-sqlite-is-the-acceptance-point). R2 holds prepared immutable contents, while one SQL transaction selects accepted references and records revision/operation identity. The R2-manifest alternative is rejected. SQLite now includes authoritative management state and cannot be treated as wholly disposable derived data; descriptions below that say otherwise are superseded.

**Update acceptance refinement:** The user rejected periodic discovery as the way to complete an interrupted CLI update. Stage files first and notify the DO to accept them; abandoned, unnotified uploads have no effect. The latest recommendation follows the user's suggestion to store accepted object references in SQLite and commit them in one transaction instead of writing an R2 manifest. See the [atomic source acceptance and retry proposal](./staged_update_protocol.md#accepted-decision-sqlite-is-the-acceptance-point). That refinement makes SQL authoritative for accepted version selection, superseding the fully-derived-SQL description below if adopted. R2 retains TOML/media contents. It also supersedes the missed-notification reconciliation recommendation for CLI source acceptance. Timed future release remains necessary; its trigger is separate from this protocol.

The user selected Cloudflare-side full feed generation in the show DO and DO SQLite state management. The suggested explicit command existed only as a way to generate XML in the CLI; it is not wanted with DO-side generation. Existing update-triggered rebuilding, unattended reservations, and repair remain automatic.

Use the same show publication operation for accepted metadata/audio/cover changes, due releases and retries. SQLite contains rebuildable scheduling/publication indexes, source/media identities and small outcome records; R2 TOML/media remain authoritative. CLI keeps mandatory syntax preflight, local media inspection and direct MP3 upload. The DO requests R2-side copies without proxying audio bodies. Feed generation is always complete. Failures restart affected delivery publication by deletion and recreation, without stage resume. Preserve the existing invalid-show/last-valid-feed rule and show-stop confirmation.

Do not add D1, a custom FIFO or a distributed lock service merely because DO is selected. Prefer the minute-Cron routing candidate already under discussion; exact scheduler wiring, derived schema/rebuild, cache invalidation, compatibility and operation outcomes belong in drafting. This decision does not establish measured free-tier fit or strict isolation across external I/O.

## Workload and fixed behavior

One administrator may manage multiple shows. One is common, three or five are plausible, and more than ten is rare, not forbidden. Design for this small show count and growing episode archives, around 100 episodes per year per active show. Do not hard-code a single show or an arbitrary maximum of ten.

RSS is always generated in full. There is no XML patching or stage-resume mechanism in the MVP. Retry deletes and recreates the affected delivery audio and full feed from current accepted input, preserving the previously agreed invalid-show/last-valid-feed exception. Large MP3 uploads remain CLI-to-management-R2 directly. Cloud-side audio promotion is an R2-side copy request, not a Worker/DO MP3 body transfer.

R2 TOML is authoritative. The currently accepted behavior includes unattended future release after the CLI exits and a normal one-to-two-minute release target. Existing accepted updates also trigger feed rebuilding when publication readiness changes. A proposed explicit publication command must distinguish initiating publication from manually authoring XML.

## What has not been selected yet

The earlier minute-Cron proposal did not settle where XML is generated. CLI-prepared future feeds versus bounded cloud-side generation remained open. We must now choose that placement rather than assume the short Cron handler can assemble any size feed.

## Three feed execution choices

| Choice | XML generator | Unattended future release and current-state recovery | Main cost |
| --- | --- | --- | --- |
| 1. Explicit CLI-only apply | CLI reads current source, builds full XML and publishes | Requires the administrator or an always-running external CLI to execute again; cannot autonomously rebuild after a later change/failure when all CLI processes are off | Fewest cloud components, but changes established behavior |
| 2. CLI prepares future full feeds | CLI generates current/future XML and uploads prepared results; Cron selects/copies a matching one | Possible only if the required full snapshots remain valid or are regenerated after edits, cancellations, invalidation and failures | More preparation/invalidation cases; storing only one future feed is not a general solution |
| 3. Shared DO publication executor | One show DO reads current normalized inputs and generates full XML when needed | Explicit CLI command and minute Cron invoke the same operation; it can regenerate without the CLI running | Adds DO, but can combine CPU budget, small indexed state, and one feed-generation path |

### Explicit command semantics

An illustrative `castloop publish <show-id>` can invoke either CLI generation (1/2) or cloud generation (3). The user typing a command does not require the CLI itself to render XML. Keep the command name tentative.

If push becomes save-only and publish becomes mandatory for all delivery changes, that changes the existing update-triggered feed behavior. It also needs a precise boundary for validation/withdrawal and reservations: an unsent local edit, an accepted invalid episode update, and a saved but unapplied publication plan cannot be treated interchangeably. Do not introduce a second manual activation flag by accident.

If command invocation at actual release time is mandatory, future automatic publication is no longer satisfied. If scheduled releases may still run while CLI is off, cloud generation or valid prepared full XML is necessary. Similarly, cloud recovery cannot regenerate an arbitrary latest feed if its only XML generator is an offline CLI.

## Verified platform constraints

* Workers Free HTTP and Cron invocations each have a 10 ms CPU limit; network/database waiting is excluded from CPU time. This does not prove a specific full XML build fails, but makes an unbounded metadata parse/render inside the ordinary Cron handler a poor default. [Worker CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
* DO documentation lists a default 30 seconds of active CPU per invocation. SQLite-backed DOs are available on Workers Free. DOs have their own request, active-duration, storage and SQL allowances; they are not unlimited compute or a way to ignore quotas. Use the DO-specific documented budget, not the ordinary Cron's 10 ms, when evaluating the XML executor. [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
* A D1 query can move filtering into SQL, but rendering returned rows into XML in an ordinary Worker still consumes that Worker's CPU. Adding D1 alone does not move feed generation to a different execution budget. [Worker CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
* DO handlers can interleave on external awaits. SQLite transactions do not include R2 media/feed/cache mutations. The accepted eventual-convergence policy still applies; choosing a DO is not a claim of exactly-once or atomic publication. [DO concurrency rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

## Small state storage comparison

| Storage | Fit for small status/scheduling information | Tradeoff |
| --- | --- | --- |
| Private R2 JSON | Few compact objects, same existing credentials/storage, no new database | Rewrite whole objects, conditional-update conflicts, no SQL lookup of due episodes; does not solve XML CPU placement |
| DO SQLite per show | Indexed episodes, release eligibility, source/audio identities, last attempt outcome; colocated with a DO feed executor | Adds DO deployment and storage schema; derived state must be reconciled with R2 source |
| D1 shared database | SQL over all shows, indexed due-episode queries, same simple rows | Adds a separate database; ordinary Worker still renders XML under its own budget. Useful if cross-show queries justify it, not needed alongside DO SQLite here |

Do not use all three as competing copies of publication state. If the feed executor is a DO, use its SQLite for the small index/status rather than adding D1 too. If XML stays in the CLI, R2 remains the smallest initial status store; choose D1 only for an established query need. KV is not preferred here because immediate revision-based updates are easier to reason about in the other candidates; no KV-specific implementation is proposed.

Both DO SQLite and D1 currently include 5 million rows read/day, 100,000 rows written/day, and 5 GB account storage on Workers Free. SQL storage allowance alone is not the whole DO compute budget. DO also includes 100,000 requests/day and 13,000 GB-s/day active duration. Free-limit exhaustion causes operations to fail, so do not promise automatic paid overflow on a Free plan. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

For scale: checking five show DOs once per minute is 7,200 DO calls/day before administration, retries and other work. Even ten shows is 14,400 calls/day, below the documented DO request allowance by itself. This is not a full feasibility result: active duration, SQL reads, R2 work and CPU remain to be measured. Do not read every episode SQL row every minute merely because request count is small. Use an indexed next-release lookup and read full current feed inputs only when a rebuild is needed; independent source/delivery verification still needs a bounded periodic scope to catch missed notifications and late writes.

## Revised recommendation if unattended release stays required

Choose 3: one DO executor per show, with SQLite holding a small derived index and status. A thin management Worker authenticates CLI requests and routes them; a minute Cron calls the appropriate show executors. An explicit CLI command can trigger a full regeneration through that same path. The Cron handler itself does not render XML.

Suggested division:

1. CLI parses TOML, inspects local media, normalizes initial IDs/timezones, checks the baseline, obtains show-stop approval and uploads media directly to R2. Heavy local media work stays here.
2. Accepted authoritative TOML and source media stay in management R2. Notify the show executor after accepted changes; a missed notification or interrupted source/index update must remain detectable by periodic comparison with R2.
3. The DO updates/rebuilds its derived metadata index from current source, confirms applicable publication validation, selects eligible episodes and generates the entire current feed when needed. Use a shared TypeScript RSS renderer/validation library within the project rather than diverging CLI/DO implementations.
4. Apply complete delete/recreate publication for affected episodes and feed. On failure or relevant concurrent source change, start again from latest accepted input; no saved completed-stage pointer. If show input is invalid, preserve last valid delivery as agreed rather than deleting it first.
5. Cron invokes the same current-state operation for due release and repair. No custom FIFO, distributed lock service or ordered command history is needed just to introduce this executor. Any busy/retry guard is a small implementation choice, not a requirement for strict isolation.

This revises the earlier CLI-heavy feed-generation preference for a concrete reason: one DO can now supply both the unattended generator and the small state store. It does not move MP3 uploads or MP3 parsing into Cloudflare. It introduces a DO for an actual CPU/scheduling need rather than to eliminate every transient conflict.

Persist only generated source identities, normalized feed inputs, release instants, media facts, last applied feed identity and a small outcome/error record as needed. These are not stage-resume records. R2 remains authoritative; the index must be rebuildable. Last-valid-show information required to preserve working delivery must be recoverable from retained authoritative/generated R2 material or the established public artifacts; do not silently make an unrebuildable DO row the new sole authority.

DO SQLite is not a public SQL database accessible directly by the CLI: the management API/DO methods access it. Keep management credentials and S3 audio access as already agreed. Updating source R2 plus SQLite is not a cross-service transaction; the periodic reconciliation policy intentionally covers that gap.

An alternative is one DO alarm per show instead of Cron. Do not introduce both schedulers initially. Alarms support at-least-once execution and automatic retries, which would execute the same full restart operation, but recurring checking/rearming still needs its own explicit design. Keep the established minute-Cron candidate for now. [DO alarms](https://developers.cloudflare.com/durable-objects/api/base/#alarm)

## Decision needed

If fully CLI-generated feeds and a mandatory manual command are the priority, explicitly relax unattended scheduled release and cloud-side full repair, or accept the prepared-snapshot complexity. If those existing requirements stay, recommend an explicit CLI trigger plus DO-generated full feeds and DO SQLite, without D1 or a custom queue. This is a recommendation for user choice, not an adopted change.
