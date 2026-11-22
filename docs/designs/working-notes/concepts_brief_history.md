# Castloop MVP

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Working brainstorm; seven-lens Goldfish BRAINSTORM review completed on 2026-11-07. No Blocker established. Accepted requirements remain distinct from recommendations and unresolved choices; this is not an approved technical design.

## Overview

Castloop lets one administrator host public podcasts in their own Cloudflare account. The administrator deploys Castloop and manages shows, episodes, MP3 files, and RSS through a TypeScript CLI compiled with Bun into standalone executables.

Prioritize a simple implementation, Cloudflare free allowances, and low costs as the audience grows. This is a podcast publishing tool for one administrator, not an enterprise workflow platform. MP3 files are initially expected to be 30–50 MB, with roughly one or two releases per week. One show is common, three or five are plausible, and more than ten is rare but supported rather than forbidden. Episode archives can grow by roughly 100 episodes per year per active show; audience size is not fixed. Upload design must not depend on a particular MP3 size fitting a Worker CPU budget.

## Analysis

### Governing design principle: simplicity and eventual convergence

Castloop is a podcast publishing tool for one administrator. Prefer a small implementation that detects conflicts and failures and eventually brings delivery into line with the latest accepted administrator intent. Temporary incorrect public state is acceptable during overlapping operations or recovery, including an MP3 briefly reappearing after withdrawal. Reapply the current intended state rather than requiring every intermediate operation to be isolated or atomic.

This tolerance concerns derived publication state, not loss of authoritative TOML or local edits. Preserve the accepted conditional-push, backup-on-pull, validation, and show-stop confirmation rules. Never retry a stale command by restoring its old source metadata; reload current accepted source and reconcile feed, audio and caches toward that state. Invalid show metadata still preserves the last valid feed as already agreed. Initial publication should still normally make media available before exposing its feed entry.

Retry publication from the beginning, not from an inferred completed stage. Delete the affected episode's delivery files and recreate them from current eligible source; delete and regenerate the show feed. Do not keep a per-stage progress journal or implement resume logic. Retain management source. This resets the affected episode and shared feed, not all other episodes' audio. Validate current show/rebuild prerequisites first so an invalid show still preserves its last working feed as previously required. A correctly unpublished episode remains absent. Temporary availability gaps during a valid delete/rebuild attempt are consistent with the accepted convergence policy.

Do not add permanent locks, ordered queues, Durable Objects, or strict stale-writer exclusion solely to prevent temporary inconsistency. Choose them only if a concrete convergence requirement makes the implementation simpler overall. A retry-based design must explain how unfinished work is found again after a crash, how a later stale write triggers another repair, and how bounded retries report unresolved failure. Eventual convergence assumes storage becomes available and competing changes stop; it is not a promise of a hard recovery deadline.

### Accepted product requirements

* The administrator, Cloudflare account owner, deployer, and publisher are the same person. Listening is public.
* Shows and episodes have stable IDs. An episode belongs to a show.
* Show and episode metadata are edited through TOML. Individual metadata fields are not changed through CLI flags.
* Descriptions may contain common, limited HTML formatting written in TOML. The proposed allowlist and RSS/website handling are recorded in [the TOML specification](toml_spec.md#description-formatting). Exact rendering may differ between podcast apps.
* Base TOML metadata and RSS output on Apple's required and recommended podcast tags, while retaining RSS 2.0 requirements. See [the proposed TOML mapping](toml_spec.md); exact field spellings and advanced optional scope remain open.
* The administrator supplies an existing homepage or other suitable website URL for the show in the MVP. Automatic static podcast websites are planned after the MVP, as described below.
* R2 holds authoritative TOML. Use metadata-only pull/push with a local show/episode tree; Git/GitHub is not a prerequisite. MP3 transfers remain separate. The MVP has no automatic merge or built-in diff display. See [the selected metadata workflow](metadata_workflow_options.md#accepted-mvp-back-up-local-conflicts-then-pull).
* Track the downloaded ETag and baseline content digest per TOML in local hidden state. On pull, if local and R2 contents both changed differently, preserve local edits in a sibling backup such as `episode.toml.bak`, then place the fetched R2 TOML at `episode.toml`. Never overwrite an existing backup; use a unique suffix if necessary. Report every backup path. If backup creation fails, leave the local TOML unchanged.
* Advance the baseline to the downloaded content and its ETag only after the local replacement succeeds. The administrator compares the files with their preferred tools, edits the current TOML, and pushes it normally. Push must detect intervening remote changes through a conditional write; it must not silently overwrite them. Pull only changes local metadata and never publishes or stops a show.
* Local-only edits survive pull unchanged. Missing local files never imply remote deletion, and backups are excluded from metadata uploads. A new computer does not automatically download all MP3 files.
* MP3 upload and replacement are separate operations and explicitly identify the episode.
* Show and episode TOML each have `publish`, defaulting to `false`.
* Stopping an already published show through `publish = false` requires an explicit administrator confirmation. After approval, remove its delivery MP3s and feed and invalidate their caches, retaining management data. A typo must not silently stop the show; schedulers must respect the approved unpublished state.
* Episode `publish = false` withdraws its RSS entry and delivery MP3 and invalidates affected caches so the audio is no longer publicly served. Retain management TOML and source MP3. Earlier reservations must not republish an episode while this flag remains false.
* The administrator specifies episode publication datetimes and may choose future times. Show timezone is a default: when first saving an episode without a timezone, the CLI copies the show default into episode TOML. Thereafter resolve its local publication datetime using that stored episode timezone. Show timezone edits do not change existing episode TOML or release times, including reservations. The future website converts episode instants into the current show timezone for consistent display and is regenerated after show timezone changes.
* Future publication times require automatic scheduled release even after the CLI exits. Before the due time, exclude the episode from public RSS and keep its MP3 out of delivery storage. After the time passes, make its MP3 available and update the feed. The user accepts a delay of one or two minutes and does not require second-precise execution.
* A publication candidate needs the appropriate publish flags, required metadata, and an available valid MP3. `publish = true` alone does not guarantee publication.
* Before any update side effects, the CLI must parse the input TOML locally. A syntax error stops the operation before upload, reports the location/reason, and leaves authoritative R2 data and public delivery unchanged.
* Save TOML even if publication validation fails, for example because audio or a required title is missing. Return actionable validation errors and distinguish saved metadata from published content.
* If episode publication validation fails during an update/publication operation, withdraw that episode even if it was previously published: omit it from RSS, remove its delivery MP3, and invalidate its public media/feed caches. Retain its management TOML and source MP3 and report the errors. This applies to invalid episode metadata as well as invalid MP3s. Stale prepared work must not republish the invalid episode.
* Show validation failure has a different outcome: report the error but preserve the last valid public feed and the resources required to keep it working, including existing delivery MP3s and artwork. A mistake in show TOML must not stop an already working feed. Do not overwrite it with invalid show data or delete its working cover as a side effect. If no valid public feed exists yet, the invalid show remains unpublished.
* Before adding or updating an episode, validate its current authoritative show TOML. If the show TOML is invalid, reject the episode operation with an error and preserve existing public delivery. Do not silently use older show metadata to accept an episode addition/update. A previously registered episode must also not be released while current show TOML is invalid, even when its scheduled time has passed.
* Provide `castloop check` to validate all authoritative show and episode TOML and return the results.
* Metadata changes and audio operations that change publication readiness trigger feed rebuilding. Make referenced audio downloadable before advertising it in RSS.
* Support show title/description changes, episode title changes, MP3 replacement, episode deletion, and show deletion.
* Store show cover artwork under `<show-id>/` in management R2 and track its filename in show TOML. Provide a CLI command to update the cover. The generated RSS points to an approved copy in delivery R2; public artwork replacement names and URLs should change per Apple's guidance.
* Show deletion stops serving its feed and media and returns an HTTP error at the old URLs. Invalidate delivery caches. Automatic removal from every podcast app is not guaranteed.
* MP3 replacement affects subsequent network fetches. Updating listener copies already downloaded is out of scope.
* Castloop access analytics are out of the MVP. Administrators may register RSS with Apple Podcasts and Spotify and use each platform's reports, which do not cover every podcast client.

### Accepted storage and delivery directions

Use two R2 buckets:

| Bucket | Contents | Exposure |
| --- | --- | --- |
| Management | Authoritative TOML, source MP3 files, and show cover images | Private |
| Delivery | Generated feed XML and approved MP3/artwork copies | Worker binding or an R2 custom domain |

The user accepts duplicate MP3 storage. The two copies, and any temporary replacements, consume storage; creating another bucket does not multiply the R2 free allowance.

Preparing new source audio in management storage must not disturb the working delivery copy. If episode publication validation fails, including invalid metadata or an invalid MP3, remove the delivery copy and feed entry and invalidate affected caches, while retaining the management TOML and source MP3. This withdraws a previously published episode as well as blocking a new one. An interrupted upload is not itself proof that the working public revision is invalid. Exact withdrawal ordering and partial-failure handling remain to be specified.

Without a custom domain, serve delivery objects through a Worker on `workers.dev` using a private R2 binding and Workers Cache. Cache hits still count toward Worker request usage.

With a custom domain, serve delivery objects through Cloudflare CDN and an R2 custom domain, without a Worker on listener requests. Disable `r2.dev` and any unwanted public domains. This is public custom-domain access in Cloudflare terminology; it does not make the S3 API anonymously readable. Public listeners must not receive an alternate URL that bypasses the configured CDN path. Authenticated administrator API operations are separate.

A custom-domain cache miss may still read R2; requiring the CDN path does not guarantee a cache hit. Management TOML and draft media never belong in the publicly served delivery bucket.

Allow migration from `workers.dev` delivery to a custom domain. Preserve existing feed subscriptions, old media URLs, and episode identities; the exact migration procedure is still open.

### Explicit correction: upload MP3 directly to R2

The user rejects proxying MP3 uploads through any Worker. CLI uploads source MP3s directly to the management bucket using the S3-compatible API and R2 credentials. S3 compatibility is used for direct object access, not for portability to other cloud providers.

Do not propose Worker upload proxying merely because a 50 MB test might fit the free CPU limit. A larger file must not change whether the application is viable within that CPU budget.

For promotion into delivery storage, the show DO requests an R2-side S3 `CopyObject`. R2 copies the object between buckets without sending the MP3 body through the management Worker, DO, or CLI. Native bindings can serve supported reads/writes; the exact copy client and credentials remain technical details. Verify source/destination access and object metadata in the implementation.

The user considers a management Worker reasonable. This does not authorize inventing extra management responsibilities. Keep any required management endpoints small, and keep MP3 upload and promotion bodies out of Workers. Native R2 bindings remain suitable inside Workers. Avoid adding a management endpoint that only duplicates an object operation the CLI already performs directly.

### Accepted responsibility split: show DO and SQLite

| Responsibility | Location |
| --- | --- |
| TOML syntax preflight, initial normalization and local validation feedback | CLI before upload |
| Local MP3 inspection | CLI; persist generated facts tied to uploaded source identity |
| Current publication validation and full feed XML generation | One DO per show, using current authoritative R2 input and a rebuildable SQLite index |
| MP3 upload | CLI directly to management R2 through S3 API |
| Promotion of an approved MP3 | Show DO requests an R2-side copy into delivery R2 |
| TOML and media contents | Management R2 immutable objects; CLI pull/push with the accepted baseline protection |
| Accepted source selection and operation identity | Show DO SQLite; authoritative references committed in one transaction after R2 preparation |
| Scheduling index, source/media identities, publication outcome | Show DO SQLite; accepted selection is persistent management data; no stage journal |
| Update routing and timed invocation | Small management Worker and minute-Cron candidate calling show DOs; exact API/authentication remains open |
| Public delivery without a custom domain | Delivery Worker and Workers Cache |
| Public delivery with a custom domain | CDN and R2 custom domain |
| Delivery changes and cache invalidation | Show publication operation through the applicable delivery/cache owner |

The user selected Cloudflare-side full feed generation and DO SQLite state management. The ordinary management Worker/Cron should route work rather than render the whole XML under its 10 ms free CPU budget. Evaluate generation under DO-specific CPU and compute allowances and measure representative archives. Local MP3 parsing and direct uploads remain in the CLI. No explicit publish command or manual feed-generation step is required; accepted updates, due reservations and repair trigger the same show publication operation.

A management Worker can remain after a custom domain removes the delivery Worker from listener traffic. Its operations should follow administrator changes, not audience size.

### Proposed publication sequence

**Follow-up policies accepted:** Migration redirects old workers.dev feed/media URLs to the new domain. Management R2 retains source versions; per-show SQLite accounts for asset ownership, identities and times, with explicit cleanup rather than prompt automatic deletion. Future rollback is enabled by retained material but is not an MVP feature. Minimal administrator recovery and manual management export/restore are accepted. See the [asset ledger proposal](management_asset_ledger.md) for a small registration flow that also accounts for abandoned uploads. Exact fields, physical layout, delete/cleanup commands and export consistency belong in drafting.

**Topic 4 accepted:** Stable feed/audio URLs, revision-specific artwork URLs, 30-day shared-cache TTL for both feed and media, client revalidation, and explicit purge after updates/withdrawal. Record/report purge failures and email when configured, without automatic retry. Use documented Cloudflare purge behavior and check normal errors/targeting; no extra global-cache audit or short-TTL safety system. See [accepted delivery policy](delivery_cache_policy.md). All four execution/state/cache topics are now agreed at the brainstorming level; remaining details are listed in the [design checkpoint](remaining_design_decisions.md).

**SQLite fields agreed:** The user accepted storing entity/source references, revision and operation identity, scheduled release times, and publication outcome/retry-needed information. Detailed columns are not a separate brainstorming blocker. The next topic is the [publication and full-restart recovery flow](publication_execution_flow.md), followed by cache behavior. The flow is a proposal; timed invocation still needs a decision.

**Confirmed acceptance:** The user accepted the SQLite management-table protocol. Prepare immutable source objects in R2, then atomically commit accepted references/revision/operation identity in the show DO's SQLite transaction. SQLite is authoritative for accepted version selection and must be preserved; it is no longer entirely reconstructible from an R2 listing. The R2-manifest alternative and earlier save-then-notify sequence are superseded. See the [accepted protocol](staged_update_protocol.md#accepted-decision-sqlite-is-the-acceptance-point). Detailed SQL fields, backup policy and publication overlap behavior remain to specify.

**Latest refinement:** The user requires staging changed files before notifying the DO, with an idempotent retry path. An unnotified upload must remain unaccepted; Cron must not discover it and make it live. The user then suggested selecting accepted objects in a SQLite management table instead of an R2 manifest. The [latest staged update proposal](staged_update_protocol.md#accepted-decision-sqlite-is-the-acceptance-point) prepares immutable R2 objects first, then commits accepted references, revision, operation identity and publication-needed status in one SQLite transaction. This would make SQLite authoritative for accepted version selection; the earlier statements that all SQL state is disposable derived data would no longer hold. R2 continues to hold TOML/media contents. Source acceptance and multi-object public delivery have separate completion outcomes. Future-release scheduling remains a separate requirement. Physical layout, schema and backup details remain for agreement/drafting.

1. Read the changed TOML and the relevant current metadata from management R2. Fetch metadata as needed, not every MP3 body.
2. Parse the input TOML in the CLI before uploading or changing R2. On a syntax error, report it and stop without replacing stored data or withdrawing existing publication. Then save identifiable, supported TOML and report publication-readiness errors. Identity/path and unsupported-format policies still need definition.
3. For audio changes, finish the direct upload before changing the working delivery copy.
4. Notify the show DO of the accepted update. Re-read current authoritative input, refresh derived SQLite state and validate the publication candidate. Preserve source files and apply the agreed invalid-show/invalid-episode rules. A missed source/index notification must remain detectable by periodic comparison.
5. For an eligible episode publication/retry, delete the affected delivery files and copy current approved source through R2-side requests. Check the applicable media/cache state before advertising it in RSS. Unpublished/invalid episodes remain absent; do not re-copy unrelated episodes' audio.
6. Generate the whole feed in the show DO, delete/recreate the delivery feed and invalidate relevant caches. Preserve the last valid feed instead if current show/rebuild prerequisites are invalid. Report incomplete operations and restart failed publication from the beginning on a later attempt; do not persist or resume completed stages.

Use straightforward ordered operations and clear errors. Re-running an operation should be safe where practical. Do not claim a transaction across multiple R2 objects. A feed write that fails after saving TOML or copying media must be reported as an incomplete publication, not success.

Prefer one management operation at a time per show in the MVP. The exact stale-write check and retry behavior remain open. Conditional object writes can prevent simple overwrites; they do not create a cross-object transaction. A persistent workflow engine, operation journal, distributed lock service, and automatic recovery system are not baseline MVP requirements.

The user requested comparing lock-based exclusion, ordered queued processing, and optimistic retries, then clarified that temporary incorrect delivery is acceptable if ultimately repaired to latest accepted intent. The earlier non-expiring-lock recommendation is superseded. The user has now selected a show DO for publication and SQLite state, not strict isolation: no distributed lock service, custom FIFO or stage journal is required. DO external awaits can still interleave; apply the accepted retry/rebuild policy and specify a small busy guard only if useful.

[Recovery discovery proposals](publication_recovery_options.md) compare periodic verification of all shows, pending-show records, and a combination. With a small show count (often one, plausibly three to five, rarely more than ten) and growing episode archives, the revised recommendation is A: minute checks using lightweight source/delivery metadata, immediate CLI attempts, and complete delete/recreate retries for affected episodes and the shared feed. Do not copy the whole audio archive, read every MP3, or implement stage resume. Paginated inventory comparisons and generated publication inputs still need a concrete bounded design; this is not yet a free-tier feasibility claim or a selected implementation.

The user selected the [show DO feed executor with SQLite](feed_execution_and_state_options.md#accepted-decision) after comparing CLI-only generation and state stores. There is no explicit publish command: it was suggested only to enable CLI XML generation, which is no longer the direction. Preserve automatic update-triggered feed generation, unattended scheduled release and full regeneration during repair. D1 and pre-generated future full feeds are not part of the selected MVP direction. R2 remains authoritative and SQLite is rebuildable derived state.

### Scheduled publication

**Failure policy confirmed:** No automatic application retries in the MVP. Record/report publication failures, email the administrator when optional mail setup is configured, and leave delivery incomplete until administrator-initiated recovery or an explicit accepted change addressing the failure. Recovery starts from latest accepted state and rebuilds affected delivery from the beginning. Catch expected alarm failures rather than using uncaught exceptions to request platform retries; do not automatically reschedule a failed past-due reservation. Platform hard failures may still produce at-least-once delivery, so do not promise exactly one physical attempt. Publication flow step 3 is agreed at this level; step 4, cache update/withdrawal behavior for both delivery paths, is next.

**Administrator notification:** The user selected error email and administrator name/address in show TOML. Proposed `[admin]` fields are private management data and are not automatically published in RSS. Apple does not require owner email. Accepted: Cloudflare mail setup is optional; configured installations send error email to a verified administrator destination, while installations without mail setup still support podcast hosting without a custom domain. Retain error records, platform logs and CLI inspection when notification is unconfigured. Automatic application retries are excluded from the MVP by separate agreement. See [notification design](publication_errors_and_notifications.md#email-selected-by-the-user).

**Latest accepted scheduler:** The user selected the show DO's alarm for scheduled release, replacing the minute-Cron candidate below. Failure handling must be bounded, with recording and administrator notification prioritized over retries. No automatic retry count or notification destination has yet been selected. The [failure and notification proposal](publication_errors_and_notifications.md) recommends no application retries initially, durable error outcomes plus platform logs, and evaluating Workers Issues notification integration after confirming the destination.

Automatic timed publication is accepted for the MVP. Saved `publish = true` metadata with a future date can be valid and scheduled, rather than a validation error. A scheduled episode still requires the normal show/episode flags and publication validation to succeed.

A minimal candidate uses one Cron Trigger running every minute on the management Worker to find due publication work. Cron runs in UTC; show-local times must first be resolved to instants. The user's accepted delay is one or two minutes. Treat successful media availability, feed replacement, and delivery-cache invalidation within that window as the normal-operation target, not a hard execution guarantee. Podcast apps poll RSS independently, so this target concerns Castloop's publicly available resources, not appearance in every app.

The timed management Worker calls the relevant show DO. The DO uses current source and its refreshed scheduling index, performs publication validation and generates full current RSS when eligible releases or repairs require it. Do not pre-generate a sequence of future full feeds in the CLI. The CLI supplies inspected media facts and normalized TOML, not a separate manual publication gate. No MP3 bodies traverse the Worker or DO.

The timed path must retain the existing restrictions on Worker CPU and subrequests. Do not claim it fits the free tier without measurement. The requirement establishes a need for a timed operation, not a workflow engine or database by default.

### Validation and check reporting

`publish = true` expresses intent; current saved TOML may differ from what is successfully delivered. Report that distinction clearly.

Propose a read-only `castloop check`: enumerate show and episode metadata with pagination, validate it, and check audio metadata without downloading all MP3 bodies. Return issue locations, IDs, field names, and readable reasons. It should not publish or delete content as a side effect. Draft readiness notices, errors, and command exit codes still need definition.

Show validation errors preserve the last valid public feed and its required delivery resources and return actionable errors. Explicit unpublishing and deletion are separate intentional operations. Episode `publish = false` removes its RSS entry and public MP3/cache copies while preserving management data. For an already published show, `publish = false` requires explicit confirmation before removing its delivery MP3s/feed and invalidating caches; retain management data. Do not equate a show validation error with an explicit request to stop the show.

When the newest saved show TOML is invalid, reject episode additions and updates with an actionable show validation error. This prerequisite runs before accepting the episode operation, so it does not trigger withdrawal based on an unprocessed episode input. Preserve the existing valid feed and delivery objects. A previously registered reservation that becomes due is blocked: do not expose its media or RSS entry. After an accepted show correction passes validation, immediately start publication processing for blocked episodes whose scheduled times have passed, provided both publication flags and episode/media validation still permit release. Do not require another episode edit or a new future time. Blocking does not cancel the reservation or clear `publish`; future reservations remain pending. Immediate processing is not a claim of instantaneous CDN propagation.

The episode-level validation failure outcome is now decided: retain management data, report errors, remove the episode from RSS, and revoke its delivery media including cached copies. The existing proposed read-only `check` reports validation/delivery problems without mutating storage; this rule concerns update/publication operations and does not silently turn `check` into a publishing command. Syntax failures are rejected locally before any R2 changes. Identity/path and unsupported-format failures remain separate input-acceptance details.

### Logical object layout and IDs

The accepted hierarchy uses show IDs as top-level prefixes and episode IDs beneath their show. Proposed filenames and ID spelling:

```text
management/
  s-<uuid>/
    show.toml
    cover.jpg
    e-<uuid>/
      episode.toml
      audio.mp3

delivery/
  s-<uuid>/
    feed.xml
    cover-<revision>.jpg
    e-<uuid>/
      audio.mp3
```

R2 folders are object-key prefixes, not filesystem directories. Creating a same-name folder does not provide an exclusive ID reservation.

Recommend CLI-generated full UUIDv4 values with `s-` and `e-` prefixes, lowercase spelling, and immutable IDs. Do not derive entity identity from mutable titles or audio contents. Use conditional creation of the authoritative TOML to avoid overwriting an existing entity at the same path. This enforces uniqueness at that path; UUID generation makes episode collisions across different shows extremely unlikely but is not an absolute global uniqueness check.

A dedicated global ID registry and sequential counter are not baseline MVP requirements. If strict installation-wide episode-ID reservation is necessary, establish that requirement before adding a registry. ID format and uniqueness scope remain proposals for confirmation. Replacement-key naming must preserve working delivery during uploads and invalidate old cache content afterward.

## Goals vs. Non-Goals

### In-Scope Goals

* One-administrator podcast management using TOML and explicit CLI operations.
* Direct MP3 upload, publication validation, RSS generation, metadata edits, audio replacement, and deletion.
* Two buckets separating source data from public delivery copies.
* Optional custom domains and a migration path to delivery without a Worker.
* A simple TypeScript implementation with useful errors and low operating costs.

### Out-of-Scope Non-Goals

* Multi-user permissions and private listener subscriptions.
* Castloop listener analytics.
* Full media synchronization. Metadata-only workspace synchronization is being reconsidered and is not yet selected.
* Editing metadata fields through CLI flags.
* Updating already downloaded listener audio.
* Enterprise workflow infrastructure for hypothetical future requirements.

## Planned after the MVP: static podcast websites

The user requests an optional generated podcast website after the MVP. When an episode is added or changed, Castloop should update a static show website where listeners can browse episodes and play their MP3s in the browser.

Generate HTML/CSS from the same publication-valid metadata used for RSS and store the results in delivery R2. Use standard browser audio playback. A proposed implementation generates the pages in the CLI during publishing; it needs no server-side page rendering or separate website service. Additional episode detail pages and a site-wide show index are not required by the current request.

Resolve each release instant from its episode datetime and stored episode timezone, then display it in the current show timezone. Regenerate static pages when show timezone changes without rewriting episode TOML or rescheduling releases.

Show/episode edits, artwork changes, unpublishing, and deletion should also reconcile the generated site so it does not advertise withdrawn content. Only published metadata and public media references belong in the HTML. Escape metadata for HTML output; do not insert arbitrary TOML strings as trusted markup.

With a custom domain, static objects can use the same CDN/R2 delivery path as audio. Without a custom domain, serving generated objects through the existing delivery Worker is technically a candidate, but page requests also use Worker request allowances. Whether the product should require a custom domain for this feature is explicitly undecided and can be settled when designing the extension.

Specify actual HTML object URLs first; directory-index behavior, redirects, HTML caching, and cache invalidation need deliberate configuration rather than assuming that R2 provides a full static-website router. These are later implementation details, not reasons to add infrastructure to the MVP.

The MVP's administrator-supplied `website` URL remains unchanged. A future opt-in website feature can offer a generated URL; do not silently replace an existing RSS website link.

## Alternatives Weighed

* **Full media synchronization:** Rejected because downloading all MP3s is expensive and missing local files make deletion ambiguous. The user selected metadata-only pull/push, with explicit media transfers and explicit remote deletion.
* **Git/GitHub source management:** Considered and rejected as an MVP prerequisite. R2 remains authoritative.
* **Automatic metadata merging and built-in diff:** Excluded from the MVP. Preserve conflicting local TOML in a backup and pull R2's version; the administrator compares and edits using their own tools.
* **CLI metadata flags:** Rejected by the user in favor of TOML editing.
* **Castloop analytics:** Deferred by the user in favor of platform dashboards for initial popularity insights.
* **MP3 uploads through a Worker:** Rejected by the user. Direct R2 upload avoids depending on Worker CPU and inbound request limits.
* **Native APIs everywhere:** Considered, but the user now accepts S3 credentials for direct MP3 access. Keep native bindings where useful; API uniformity is less important than simplicity.
* **Full feed generation in the ordinary Worker/Cron:** Rejected in favor of a show DO with its own documented execution budget. CLI still performs syntax preflight and media inspection.
* **CLI-only XML generation and an explicit publish command:** Considered to avoid ordinary Worker CPU limits. The user instead selected automatic Cloudflare-side DO generation, preserving unattended release and repair; no separate publish command.
* **D1 or R2 JSON as the main publication-state store:** Considered. The user selected DO SQLite colocated with the show feed executor; authoritative TOML and media remain in R2.
* **Dedicated global ID registry, operation journal, and distributed recovery:** Removed from the baseline recommendation. Add such machinery only for an established need.

## Key Decisions & Staging for Next Steps

The current architecture direction is a CLI, two R2 buckets, CDN delivery, a small management Worker, and one show DO with SQLite per show. The CLI handles local media inspection, TOML editing/preflight and direct source uploads; the show DO manages derived publication state, current validation, R2-side promotion and full feed regeneration. Updates automatically trigger publication processing, with unattended timed release and full-restart repair; there is no explicit publish command.

The accepted scheduled-release delay is one or two minutes. Open implementation details include the minimal scheduling mechanism and its cache handling, management endpoint responsibilities/authentication, validation and withdrawal timing, publish/unpublish behavior, ID format and uniqueness scope, command/schema details, partial-failure reporting, and migration URL continuity. Resolve the product behavior first and prefer the smallest implementation that supports it.

The [TOML/RSS mapping proposal](toml_spec.md) records Apple-required, recommended, situational, and automatically generated values, plus the RSS website-link requirement. The user has decided to manage show cover images in management R2 using a filename in TOML and a CLI update command. Field spellings and remaining details are proposals, not a completed technical design.

Do not run Goldfish reviewers until the user has reviewed an anchored hypothesis and explicitly confirmed readiness. This file is a working brainstorm, not a reviewed design or an implementation.

## Accepted metadata baseline and conflict handling

Use a local hidden manifest (proposed path `.castloop/state.json`) with each TOML's downloaded ETag and baseline content digest. Local modification times do not identify which remote revision an edit started from. ETags are opaque revision tokens; compare local contents with the digest and remote revisions with the saved ETag. The user selected backup-and-pull for divergent edits: retain the local file in a unique `.bak` file, install the fetched remote TOML, then record that exact fetched revision as the new baseline. No separate conflict-resolution command or merge dependency is needed. Push remains conditional against the recorded revision, so another remote update requires a fresh pull. This protects individual TOML writes, not publication across multiple objects. Missing baseline, remote deletion, and recovery from interrupted local updates still need bounded rules in the technical draft; they must not silently discard local work or recreate deleted entities.

## Sources

* [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — CPU, memory, and request limits.
* [R2 S3 operations](https://developers.cloudflare.com/r2/api/s3/api/) — upload, copy, and other object operations.
* [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) — conditional writes and cached content after update/deletion.
* [R2 credentials](https://developers.cloudflare.com/r2/api/tokens/) — credentials for authenticated administrator object access.
* [Workers Cache](https://developers.cloudflare.com/workers/cache/) and [pricing](https://developers.cloudflare.com/workers/platform/pricing/) — public response caching and request accounting.
* [R2 public access](https://developers.cloudflare.com/r2/buckets/public-buckets/) — independent custom-domain and r2.dev access controls.
* [R2 API surfaces](https://developers.cloudflare.com/r2/api/) — REST, S3-compatible API, and Worker bindings are distinct interfaces.
* [UUID specification](https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-4) — random UUIDv4 generation.
* [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) — minute-based periodic Worker execution in UTC.

## Goldfish brainstorm synthesis — 2026-11-07

The user authorized the anchored-hypothesis review, satisfying the review-readiness gate above. All seven lenses completed; none failed or required retry. The [consolidated report](../reviews/goldfish_review_report.md) records 10 deduplicated Major decisions/risks and 4 Nits, with precise reviewed references and primary-source links. An open choice is not itself a Blocker or proof that the architecture is infeasible.

| Lens | Review result | Evidence |
| --- | --- | --- |
| Architecture and cost (`egm-design`) | completed | [Report](reviews/design_brainstorm.md) |
| Operations (`egm-codebase-details`) | completed | [Report](reviews/operations_brainstorm.md) |
| Simplicity (`egm-zoom-out`) | completed | [Report](reviews/simplicity_brainstorm.md) |
| Ergonomics (`egm-comprehension`) | completed | [Report](reviews/ergonomics_brainstorm.md) |
| Compatibility (`egm-implementation-readiness`) | completed | [Report](reviews/compatibility_brainstorm.md) |
| Maintainability (`egm-structural`) | completed | [Report](reviews/maintainability_brainstorm.md) |
| Inventive Catalyst (`egm-inventive-catalyst`) | completed; no false compromise detected | [Report](reviews/inventive_brainstorm.md) |

Reviewers used fresh conversation turns with `fork_turns: "none"`, no supplied parent transcript or other reviewer findings, and at most two concurrent reviewers. This does not establish exclusion of host instruction files; that exclusion remains unverified. Each report records the actual reading basis. The synthesizer preserved returned reports verbatim.

### Accepted direction retained

The review supports keeping the small CLI and two-bucket direction. All accepted decisions above remain in force: one administrator; authoritative private TOML and explicit local edit inputs; TypeScript CLI compiled with Bun; direct S3 MP3 uploads and R2-side promotion; CLI validation/RSS processing; workers.dev or custom-domain delivery; both publish flags false by default; automatic scheduled release after show-local time with the accepted normal-operation delay; media before RSS; duplicate storage; stable identities; saved incomplete metadata with useful errors; and the existing artwork, description, editing and deletion requirements. Analytics remain excluded and generated static websites remain after the MVP. No new service or architecture policy is accepted by this synthesis. The TOML specification is unchanged.

### Product choices still unresolved

These recommendations identify the next decisions; they do not select the answers.

| Decision | Minimal review recommendation |
| --- | --- |
| What remains public after invalid edits or explicit unpublish? | Episode validation failure withdraws that episode's RSS entry and public MP3. Show validation failure returns errors and preserves the last valid feed and required public resources. Episode unpublish is now defined as withdrawing its RSS entry and public MP3/cache copies while retaining management data. Show unpublish is now confirmation-gated and removes public MP3s/feed while retaining management data. Combined show/episode changes, identity/path validation and interrupted-operation handling still need definition; syntax errors already abort locally before R2 changes. |
| What happens when a scheduled reservation is edited, cancelled, replaced or deleted? | State the effective reservation and the outcome of overlap with its due time. Superseded work must not silently restore withdrawn content; choose publication ownership/coordination after agreeing on behavior. One administrator still leaves CLI and Cron as separate writers. |
| What happens to existing episode times when show timezone changes? | Resolved after review: persist an episode timezone, initially filled from the show default. Show edits leave existing episode TOML and reservations unchanged; the future website displays all instants in the current show timezone and is rebuilt after a timezone edit. |
| Which metadata updates are accepted? | Distinguish saved incomplete publication metadata from parse/identity failures, and define how a stale local baseline is detected or deliberately replaced. Syntax errors now abort locally before R2 changes; identity/path mismatch handling and stale-baseline checks still need definition. |
| How does the administrator know whether publication worked? | Distinguish saved draft, blocked, scheduled, published and incomplete outcomes; let read-only diagnostics separate authoritative validity from observed public delivery and overdue reservations. Consider native logs for unattended failures before adding any new monitoring artifact. |
| What survives a delivery-domain migration? | Select old-feed/media endpoint retention and rollback behavior while preserving the accepted subscription, URL and GUID continuity requirement. Stable IDs alone do not preserve URLs. |

### Drafting and feasibility recommendations

* **Correct the proposed ordering before adopting it:** Steps 5–6 currently confirm the R2 copy, write RSS and then invalidate caches. A cached missing-media response can survive that copy. Recommend clearing or preventing stale/negative public media responses **before exposing the corresponding feed entry**, then updating/refreshing RSS. This makes the accepted media-before-RSS rule apply to the configured listener path, not merely an authenticated origin check. This is a review recommendation against the current candidate sequence, not a silently applied implementation decision. See [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).
* **Name the cache and its owner:** The lower-level Cache API and current Workers Caching have different purge behavior. Current Workers Caching supports global purge on workers.dev, scoped to its owning Worker and calling entrypoint. Define its authenticated invalidation path separately from custom-domain CDN purge; do not assume a separate management Worker can directly purge the delivery Worker's cache. See [Workers Cache purge](https://developers.cloudflare.com/workers/cache/purge/).
* **Bind generated facts to inspected media revisions:** Decide where private generated duration/size/MIME/approval information persists so a new computer or scheduler can use the inspected revision without downloading the archive. This does not add hand-maintained enclosure fields to TOML.
* **Keep one publication contract:** Prepared complete feeds remain a candidate. Explain invalidation, regeneration, CLI/Cron overlap and stale-work rejection before selecting that implementation. A revision precheck alone is not a multi-object transaction. No journal, workflow engine, database or global lock service is required by the review.
* **Measure the small scheduler:** Compare simple pending-work enumeration with a small derived manifest using a representative installation. Full archive scanning each minute is not a selected design. Estimate operations and CPU before claiming free-tier fit; preserve the 1–2 minute normal-operation target. Initial Cron configuration propagation is a separate setup caveat.
* **Keep compatibility and usability small:** Define detectable CLI/Worker/artifact format mismatches and safe upgrade/rollback order during drafting. Provide lightweight show/episode discovery with stable IDs. Decide temporary-copy cleanup; the stated cadence and two audio copies add roughly 3.12–10.4 GB per show per year before artwork and temporary revisions.

The next anchored hypothesis should settle the withdrawal table and reservation behavior, then show how the same publication rules handle an ordinary release, a changed reservation and a partial failure. Exact command spellings, implementation dependencies and optional extended-tag scope remain drafting decisions.

### Post-review decision: failed episode validation

The user has resolved the episode-invalidity portion of M2. Invalid episodes must not remain public; retaining the previous public episode after an invalid metadata update is not the selected policy. Preserve private source data and make publication errors clear. The raw reviewer reports and original findings describe the review-time state; this decision is subsequent to that review.

### Post-review decision: failed show validation

The user has resolved show-invalidity behavior: report validation errors and preserve a previously valid public feed and the delivery media/artwork it needs. Invalid show TOML must not silently disable an established podcast. Keep the newest saved source separate from the last successfully published show state. Episode additions and updates return an error while authoritative show TOML is invalid; previously registered timed releases are also blocked, without publishing their media or RSS entries. Do not fall back to an older show revision to release them. After a valid show correction, overdue eligible reservations automatically enter publication processing immediately. Show unpublishing now requires confirmation and removes public media/feed after approval. Syntax errors now stop locally before R2 changes; identity/path mismatch handling remains a drafting detail. These are targeted remaining cases, not a requirement for an enterprise recovery system.

### Post-review decision: release after show repair

Once an accepted show update repairs validation, start publication processing immediately for overdue, still-eligible episodes. Recheck show/episode publication flags and episode/media validity. Keep later reservations pending. Release local datetimes and their interpretation timezones remain in episode TOML; show TOML supplies only the default for newly normalized episodes and the website display timezone. The timed publisher must also recognize valid overdue work rather than requiring that the exact scheduled minute was observed. The precise CLI/Worker dispatch arrangement is a drafting detail.

### Post-review decision: episode unpublish

Setting episode `publish` to `false` withdraws its RSS entry, deletes its delivery MP3, and invalidates media/feed caches while retaining the management TOML and source MP3. Do not allow an earlier reservation to republish it while false. A failed withdrawal step must be reported as incomplete rather than claiming the public URL is already inaccessible. Show-level unpublish now requires confirmation before removing its delivery MP3s and feed.

### Post-review decision: confirm show unpublish

When an update would stop a currently published show through `publish = false`, show the target and public impact and ask the administrator to confirm. Approval withdraws its public MP3s and feed, including cache invalidation, while retaining management TOML/source assets. Preserve episode publication flags rather than treating show unpublish as deletion of every episode. Scheduled work must not restore delivery while the show is unpublished. Proposed safe cancellation behavior: cancel the update before changing R2, so declining the confirmation does not save an unpublished intent that Cron could later apply. Noninteractive invocation must not count silence as approval; any explicit automation override needs definition during CLI drafting. Creating a new draft with default `publish = false` does not stop a published show and is outside this confirmation trigger.

### Post-review decision: persist episode timezone

Resolve M8 by storing the episode timezone in its authoritative TOML. The administrator may enter only a local publication datetime; the CLI fills a missing episode timezone from the show default on initial save. Changing show timezone does not rewrite existing episode TOML, published instants, or scheduled release instants. Accepted normalization rule: when updating an existing episode from a file that omits timezone, preserve the already saved episode timezone rather than silently applying a changed show default. Persist explicit timezone in the normalized R2 TOML and expose it on download. The planned website displays all release dates in the current show timezone and regenerates after that setting changes.

### Post-review decision: reject TOML syntax errors locally

The CLI must check TOML format before uploading. Syntax errors are reported to the administrator and abort the operation without changing R2 source objects, public feed/media, or reservations. Do not apply episode-withdrawal rules to an input that was never accepted. Parseable TOML with missing publication metadata or media follows the separately accepted save-and-validate rules. This resolves the syntax portion of M7; ID/path consistency and supported-format policies remain technical drafting details.
