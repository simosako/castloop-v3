# Publication recovery without strict isolation

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Revised recommendation: option A with lightweight periodic checks. The user requires restarting failed publication from scratch, accepts temporary delivery inconsistency, and expects a small show count (often one, plausibly three to five, rarely more than ten) with growing episode archives. Recovery discovery remains a proposal. The earlier C recommendation below is historical and superseded by this section. XML execution placement and R2/DO SQLite/D1 state options are reopened in [the feed/state comparison](./feed_execution_and_state_options.md).

## Accepted restart policy and revised recommendation

Subsequent placement decision: the user selected a show DO for full feed generation and SQLite state management, without an explicit publish command. CLI updates notify the show publication path; timed release and periodic verification invoke that same path. Earlier recommendations to perform immediate application in the CLI mean CLI-triggered DO application now, not CLI XML generation. The verification/restart policy remains as below; generated indexes live in DO SQLite rather than a separate R2 JSON status store. See [the accepted feed/state decision](./feed_execution_and_state_options.md#accepted-decision).

Do not record publication stages, infer which steps completed, or resume halfway through an attempt. A failed or conflicted episode publication restarts the complete operation using latest accepted source: delete that episode's delivery files, then copy eligible current source audio again. Delete and regenerate the show's feed rather than patching it or resuming an interrupted feed write. Refresh/invalidate the relevant caches as part of the operation. The management source remains intact.

Scope the reset to the affected episode and the shared feed. Retrying one episode does not delete/re-copy every other published episode's MP3. If current intent is unpublished, deleted, or episode-invalid, leave its delivery media absent and rebuild the feed without it. The existing invalid-show rule remains an explicit exception: validate the show and required rebuild inputs before destructive work; if the show is invalid, retain its last valid feed/resources and reject episode updates. Do not start by deleting a working feed and only then discover that current show metadata cannot produce a replacement.

A temporary feed/media outage caused by deletion and rebuilding is part of this proposed application of the user's restart policy. Report failed rebuilding and retry; do not claim an atomic replacement or uninterrupted delivery. The worker may have already constructed a replacement in memory/prepared input before deleting the delivery feed, but the installation still follows the requested delete/recreate policy.

### Recommend A: one periodic verification path

One show is common, three or five are plausible, and more than ten is rare, not forbidden. Episode count per active show can grow by about 100 per year. Prefer minute checks that revisit the small set of shows using lightweight desired-versus-delivery metadata comparisons, plus immediate CLI-triggered application. Which component generates XML is not settled by this recommendation. Do not add a separate pending-work queue and a slow rotating-show scheduler as the initial architecture.

1. CLI accepts source changes under the existing validation/confirmation/conditional-write rules and attempts the complete affected publication operation immediately.
2. Every minute, Cron checks current release eligibility and lightweight source/delivery identities for the show's episodes and feed. A missing object, unexpected object, obsolete source identity, wrong feed revision, or due unpublished episode makes the affected operation eligible for a complete restart.
3. If no discrepancy or due work is found, perform no deletion, copying, feed rebuilding, or routine purge.
4. When work is needed, use latest accepted intent, restart affected episode operations from the beginning, and delete/recreate the full feed once for that attempt's batch. Recheck source changes afterward. If another update intervened, retry from current intent within a small budget or leave the discrepancy for a later tick.
5. Verification runs even after an attempt was reported successful. A late older copy or feed write can therefore be found on a later tick, without a pending flag needing to survive every race.

### Keep archive-size costs visible

Lightweight verification does not mean downloading every TOML and MP3 or issuing one HEAD per audio every minute. R2 object listing returns object summaries and can include custom metadata, allowing grouped comparisons. It returns at most 1,000 objects per page and can return fewer when metadata is included; implement pagination. More objects and larger metadata still increase work. [R2 list options](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions)

Candidates for generated comparison data are source audio identity on its delivery copy, current metadata/preparation identity on the feed, and a compact machine-generated episode publication summary. Such a summary is derived from authoritative TOML, not a new user-edited source or a journal of completed stages. Do not assume the source and copied object's ETags must match; use an explicit inspected source identity. Precisely how eligibility/validation/release times are represented and refreshed remains part of the existing media/feed preparation design.

For around 100 episodes, source/delivery listings contain hundreds of objects, rather than hundreds of audio downloads. This is a plausible starting workload, not a verified CPU/free-tier claim. At 500 or 1,000 episodes, measure pagination, returned bytes, comparison CPU, and occasional full-feed rebuild cost. Only then introduce extra indexing or a slower archive pass if needed. A single show can still have many pages of episode objects.

Detecting a mismatch decides **whether to start a complete operation**, not **which internal stage to resume**. The checker need not compute or preserve a last-completed-step field. Rebuilding one feed may require metadata for all its public episodes; copying audio remains limited to affected episodes.

### Boundaries to settle in the draft

* Feed generation and validation must still fit the chosen CLI/Worker split. This proposal does not establish that parsing all TOML or assembling an arbitrarily large RSS document fits the Worker CPU budget. The current CLI-prepared-input alternative remains to be specified.
* Compare delivery prefixes with surviving authority so deleted episodes and shows with late writes remain discoverable; do not exclude nonpublished entities from checks. A delete marker is optional if the enumeration rule already identifies unexpected delivery objects.
* Object/revision comparisons alone do not establish worldwide cache contents. Include the existing cache invalidation work in delete/rebuild attempts and define how its failures remain eligible for another full attempt. A small attempt outcome/error marker is permissible if needed; a stage journal and resume logic are not.
* Repeatedly rebuilding the same due/invalid object every minute is unnecessary. Verification must distinguish a correctly absent unpublished/invalid episode from one that actually needs reset.
* No new recovery interval, summary schema, cache policy, lock, queue, or DO has been adopted. The accepted change is the restart-from-scratch rule; A is the revised recommendation.

## Earlier alternatives and superseded recommendation

The remaining sections preserve the earlier comparison. Their C recommendation and “apply only necessary changes” wording do not override the restart policy or revised A recommendation above. Unchanged episodes may be skipped by discovery; once an episode's publication is selected for retry, run its entire delete/recreate operation.

## Common behavior

CLI and Cron reconcile delivery toward current accepted administrator intent. Do not replay an old command or old prepared feed merely because it previously failed. Re-read source, publication flags, release times, media identities and applicable validation outcomes. Invalid show metadata preserves the last valid working feed under the accepted policy; latest source does not automatically mean latest source is publishable.

A normal CLI update attempts immediate publication. A recovery mechanism continues after the CLI exits. In one invocation, use a small retry budget; if work remains, report publication incomplete and leave it discoverable. A later successful tick can repair it. A timer alone does not identify unfinished work: application logic must enumerate targets and re-evaluate them. [Scheduled handler lifecycle](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)

Repeatable reconciliation means checking the desired and observed state, then applying only necessary changes. Do not copy every MP3 or purge every cache on every tick. Audio bodies stay out of the Worker; use inspected media facts, object metadata and R2-side copy requests. Include feed and cache repair, not just origin object existence. A matching publication-status record is useful evidence, but not proof that no old in-flight writer subsequently changed delivery.

## Three discovery options

| Option | How the next attempt finds work | Advantage | Cost/limitation |
| --- | --- | --- | --- |
| A. Periodic verification of all shows | Cron revisits shows and compares current desired delivery with feed/media state, regardless of past success records | Fewest recovery bookkeeping rules; naturally revisits lost notifications and late writes | Work grows with archive size if every episode is examined each minute; spread verification across ticks and keep due-release discovery prompt |
| B. Pending shows only | Store a small private per-show publication-state record; source edits and due reservations make the show pending; Cron retries pending work | Avoids rechecking quiet archives; gives useful CLI status | Updating source and the pending record is not atomic. Completion can race new work. Once cleared, a late stale write can be missed unless another event revisits the show |
| C. Pending shows plus occasional verification | B handles ordinary updates and failures promptly; a slow rotating pass from A revisits all known shows and delivery prefixes | Covers quiet shows after lost pending updates, crashes, and late writes while keeping minute work small | Adds a last-verification time/cursor and a periodic check path; reuse the same reconciliation function rather than implementing another repair engine |

These are R2 bookkeeping options, not FIFO queues or ordered event logs. Multiple updates can collapse into one request to reconcile the latest state. They do not require Cloudflare Queues, DOs, or a SQL database.

## Proposed starting point

Recommend C if we want both low idle work and recovery of otherwise forgotten mismatches. Use one small generated private publication-state file per show, plus the already needed reservation discovery. Candidate path: `_castloop/publication/<show-id>.json`. Illustrative fields are pending status, the source/preparation revision last applied, next due instant, last verification time, and last error. Exact fields and discovery layout belong in the draft; do not treat a custom ordered command history as necessary.

1. CLI parses input and obtains any required show-stop approval. Protect authoritative writes with the accepted local-baseline and conditional-push rules.
2. Mark the show for reconciliation around accepted source changes, then attempt the immediate update. Leave a pending result on a known failure or detected concurrent change.
3. Each minute, Cron prioritizes pending shows and due reservations. Work from current accepted source. A bounded attempt that fails remains eligible for a later tick; one failing show must not prevent progress on others.
4. After applying a snapshot, recheck relevant source/preparation revisions. If they changed, retry from current state. Never label a newer source revision as successfully applied merely because a later status read sees it.
5. Update the small publication-state object conditionally, using its observed ETag so an old completion cannot blindly clear a newer pending update. That condition protects this record only. It does not make source, media, feed and status a transaction. [R2 conditional writes](https://developers.cloudflare.com/r2/reference/consistency/#conditional-writes)
6. Independently of pending/success status, periodically verify known shows in a rotating pass. An illustrative full-cycle interval is one hour, adjustable after cost/workload checks. This is a proposed abnormal-recovery interval, not the accepted normal scheduled-release target of one or two minutes. Do not claim every mismatch is found within the interval if the pass cannot keep up or services are unavailable.

The source/pending dual-write gap still exists: for example, a pending record may be cleared before a concurrent source save finishes and its final status update may fail. The slow pass intentionally repairs such gaps; adding more status flags does not create atomicity. The design accepts temporary incorrect delivery rather than implementing a transaction protocol.

An initial implementation with very few shows could use A alone if measurements show its verification workload is small. The verification routine is the same routine needed for C. The draft should compare that cost before adding bookkeeping solely as an optimization. Avoid claiming C is always fewer lines of code than A.

## Example: unpublish overlaps a scheduled copy

1. Cron begins copying episode audio based on an older accepted snapshot.
2. CLI accepts `publish = false` and attempts withdrawal.
3. The old copy finishes later and temporarily restores audio.
4. A revision check or pending retry detects the new intended state and removes the media again, refreshes the feed and invalidates affected caches.
5. If either process exits before detecting the mismatch, the independent verification pass eventually finds the unexpected delivery object and performs the same repair.

No lock must be recovered before this can happen. Once old operations have settled, source edits stop and required services succeed, repeated reconciliation converges to intended delivery. This is the accepted behavior; temporary intermediate publication is possible.

## Deletion and retained discovery

Do not forget a deleted show/episode immediately. A later old copy can create a delivery object after initial deletion. Retain a small deletion marker or equivalent inventory of withdrawn delivery paths so verification knows to remove those objects. Alternatively enumerate delivery prefixes and compare with surviving authority, with a defined rule for orphaned prefixes.

A nonpublished show must also remain in periodic verification. Checking only currently public or future-scheduled episodes misses the exact recovery cases we want to cover. The retention/cleanup policy for deletion markers and abandoned media is a drafting decision. Do not automatically recreate a remotely deleted entity from a local file.

## Keep existing CPU and feed-preparation constraints

Selecting recovery discovery does not settle how the timed Worker obtains an up-to-date RSS feed under the CLI-heavy processing direction. Recovery needs a reproducible current publication plan. An obsolete complete feed cannot be reapplied after a cancellation just because its original reservation is due. The draft must choose small generated inputs and bounded assembly, or a preparation scheme that covers those changes. If required prepared data is missing or obsolete, report incomplete work rather than inventing a valid feed or silently releasing an obsolete one.

Checks can use stored generated media facts and object revisions; no archive download is needed. Bound each invocation's reads, CPU and mutations. A full repair pass may take several ticks for larger installations. Use current operation estimates and measurements before promising free-tier fit.

## Decisions to carry into drafting

* Pick A for the fewest bookkeeping rules if its cost is acceptable, or C for prompt pending retries plus a slower safety pass. B alone has an explicitly weaker guarantee for forgotten late writes and is not the preferred eventual-convergence design.
* Decide whether an hour-scale independent repair interval is acceptable after an unusual crash/late write. Normal CLI updates and registered timed releases still attempt promptly.
* Reuse one reconciliation path for CLI application and Cron recovery where runtime constraints permit. Keep source validation and last-valid-show preservation consistent.
* Specify pending-state races, deletion discovery, feed preparation, verification scope and reporting in the technical draft. No lock, queue, DO or recovery interval is adopted by this proposal.
