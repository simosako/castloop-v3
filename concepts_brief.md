# Castloop MVP — Consolidated Concepts Brief

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Brainstorm decisions consolidated; authorized to begin section-by-section design drafting. This is the predecessor for the design, not an approved implementation specification.

## Overview

Castloop lets one administrator publish public podcasts from their own Cloudflare account. The administrator is the deployer, account owner and podcast publisher. They edit show and episode TOML locally and use a TypeScript CLI, built with Bun into standalone executables, to transfer metadata and media. Cloudflare produces and serves RSS and approved media.

Prefer a small implementation and low running costs. One show is common, three to five are plausible, and more than ten is rare rather than forbidden. Episode archives can grow by roughly 100 episodes per year per active show. Initial MP3 sizes are about 30–50 MB; larger files must not depend on fitting a Worker upload CPU budget. Listener volume is unknown. Free-tier capacity has not been established by measurement.

## Governing Design Principle

Keep authoritative input safe and let derived public state converge to the latest accepted administrator intent. Temporary missing or incorrect public resources during overlap or recovery are acceptable. Do not introduce enterprise transaction machinery to eliminate those windows.

Atomic source acceptance means selecting all prepared input references in one SQLite transaction. It does not mean a transaction across SQLite, R2 objects and caches. Preserve local edits, detect stale pushes, and distinguish accepted input from successful publication.

On administrator recovery, read current accepted input and restart affected publication from the beginning. Delete and recreate affected public files and regenerate the entire feed. Do not infer completed stages or resume partway through an interrupted operation. Check show validity before destructive rebuilding so invalid show edits preserve established delivery.

## Goals and Accepted Product Requirements

### Content management

* Support multiple shows with stable show and episode IDs. Accepted during draft review: `s-` / `e-` followed by eight lowercase Base32 characters generated with cryptographically secure randomness, with authoritative creation collision checks. Episode uniqueness is within its show. IDs are ten characters including the prefix. R2 has prefixes rather than real directories.
* Manage show and episode metadata through TOML, including title and description edits. Do not introduce field-by-field title update flags as the primary workflow.
* Provide metadata-only pull/push with a local show/episode directory tree. MP3 transfers are separate; pulling on a new computer does not download the audio archive.
* Default both show and episode `publish` to `false`.
* Support episode removal, audio replacement, title changes, show metadata changes, and show removal/withdrawal. After show removal, its feed must return an HTTP error rather than a successful empty feed.
* A replacement MP3 serves later requests to the existing episode audio URL. Do not recall files already downloaded by listeners.
* Base TOML and RSS fields on Apple Podcasts requirements and recommendations plus RSS 2.0. The administrator supplies an existing website URL in the MVP.
* Store show cover sources under the show's management prefix; show TOML names the cover file. Provide a cover upload/update command. Public cover URLs change with the cover version.
* Allow a limited range of common HTML in descriptions. Exact fields, allowed tags and optional advanced RSS extensions remain draft details; [toml_spec.md](./toml_spec.md) is a mapping proposal, not a fully accepted schema.

### Metadata conflicts

Record the retrieved remote identity and a baseline content digest in local hidden state. With SQLite selection, the accepted source revision must also participate in stale-push checks. Local filesystem timestamps alone are insufficient.

On pull, preserve local-only edits. If both sides changed differently, save local TOML in a unique sibling `.toml.bak` file, install the fetched remote TOML, and report the backup. Never overwrite a backup. If preservation fails, leave the original intact. Advance the baseline only after successful local installation. The administrator compares and edits files using their own tools; MVP has no automatic merge or built-in diff.

Push rejects intervening remote changes rather than silently overwriting them. Missing local files do not delete remote entities. Pull is read-only with respect to remote and public state. No Git or GitHub dependency.

### Validation and public outcomes

| Input or operation | Accepted behavior |
| --- | --- |
| TOML syntax error | CLI reports the location and aborts before remote mutation |
| Parseable but publication-incomplete metadata | May be accepted and retained; report actionable validation errors |
| Invalid episode | Omit its RSS entry and remove its public audio, including cached copies; retain private source |
| Invalid show | Report errors and preserve the last valid public feed and required media/artwork |
| Episode add/update while current show TOML is invalid | Reject before accepting the episode change; do not substitute an older show revision |
| Scheduled release while show is invalid | Keep new media private and block the release |
| Valid show repair | Immediately process overdue episodes that remain eligible; keep later reservations pending |
| Episode `publish = false` | Remove its RSS entry and public audio; retain private source |
| Stopping an already published show | Require explicit confirmation before accepting the stop; withdraw feed/media and purge caches after approval |
| Cancelled show-stop confirmation | Abort the update; do not leave a saved stop intent |

Provide read-only `castloop check` for all show/episode validation results and unresolved publication errors. Report IDs, fields and useful reasons. Separate source acceptance, validation, scheduling and observed public delivery outcomes.

### Release times

The administrator chooses episode publication datetimes, including future times. Show TOML contains an IANA default timezone. On initial episode normalization, the CLI fills an omitted episode timezone from that default and persists it in episode TOML. Later edits that omit timezone preserve the existing episode timezone.

Changing the show timezone does not change existing episode publication instants or reservations. The future website displays dates in the current show timezone. A due episode becomes publicly accessible and enters RSS automatically; a normal-operation delay of one or two minutes is acceptable. External podcast application polling is outside this target.

## Accepted Architecture

### Responsibility and authority

| Component | Responsibility |
| --- | --- |
| TypeScript/Bun CLI | Local TOML syntax checks, normalization, media inspection, metadata pull/push and direct source upload |
| Small management Worker | Authenticate and route management requests |
| One Durable Object per show | Validate accepted input, manage SQLite state, execute publication and generate the whole feed |
| Show DO SQLite | Authoritative accepted object references, revisions/operation identities, release instants, outcome/error state and source asset ledger |
| Management R2 | Private immutable TOML, MP3 and cover contents, including retained older versions |
| Delivery R2 | Approved public feed/media copies; never management TOML or draft audio |
| Show DO alarm | Scheduled release after the CLI exits |

SQLite is persistent management data. Listing R2 cannot determine which prepared versions were accepted. Do not retain a second live authoritative R2 manifest. Historical statements that SQLite is wholly disposable are superseded.

### Upload and acceptance

CLI saves an operation ID and expected accepted revision, prepares immutable source objects in management R2, and sends the final acceptance request after upload completion. MP3 bodies upload directly through the R2 S3-compatible API; neither Worker nor DO proxies them.

The DO checks object identities and request eligibility, then rechecks current revision/state and commits selected references and operation identity atomically in SQLite. External object reads occur outside the synchronous SQL transaction. A parseable incomplete draft can be accepted under the validation policies above.

An upload abandoned before final acceptance remains unused private material. It must not be accepted by a Cron scan. A lost response is handled by retrying the saved operation identity; reuse with different input is an error. A newer accepted revision prevents replaying stale intent. Publication failure after acceptance does not roll back accepted metadata.

Exact ledger preparation calls, physical key layout and protocol fields remain draft details. The [asset ledger proposal](./management_asset_ledger.md) proposes pre-upload registration so abandoned uploads are attributable without accepting their contents.

### Publication

Accepted updates and due alarms invoke the same show publication behavior. There is no separate normal publish command and no CLI-generated final feed.

The DO validates current show/episode metadata, uses persisted media facts bound to source object identity, and generates complete RSS. It requests R2-side S3 `CopyObject` to promote approved media without transporting MP3 bodies through a Worker, DO or CLI. Use native bindings for other operations where suitable.

For affected episodes, remove/recreate public files or withdraw them as required. Do not recopy unrelated unchanged audio merely because RSS is regenerated. Make newly advertised media available and clear stale/negative media caches before exposing its feed entry. Delete/recreate the complete feed; XML patching is outside the MVP.

Concurrent updates may coalesce toward current accepted intent. A stale run must not mark a newer accepted state complete. Temporary stale delivery is acceptable. Exact per-show busy handling and durable pending information belong in the draft; no distributed lock, durable FIFO or processing-stage journal is required.

### Scheduling and errors

Use the show DO's alarm for reservations, replacing Cron. Never use timers to accept abandoned uploads.

MVP has no automatic application retries. Record/report errors and wait for administrator recovery or an explicit accepted change addressing the problem. Do not repeatedly rearm a failed past-due release or retry it silently alongside another reservation. Future unrelated reservations still operate.

Provide a minimal administrator retry action that reads latest accepted state and rebuilds affected delivery from the beginning. This is distinct from retrying uncertain source acceptance with its original operation ID.

Accepted during draft review: use Cloudflare Workers Logs for detailed diagnostic events, exception stacks and dashboard investigation. SQLite retains only current unresolved failure state within publication outcomes: target, revision/operation, failure time and compact actionable code/message. Do not implement an SQL error-history table or log viewer. This minimal operational state survives log expiry and supports check/recovery and failed-reservation handling. Platform logs also cover failures that prevent recording. Exact state columns and alarm arming/crash behavior remain drafting work. Platform alarm redelivery is distinct from an application retry policy; do not promise exactly-once execution.

### Administrator email

Store private administrator name and email in show TOML. Do not automatically expose them in RSS. Apple owner/contact email is not a mandatory feed requirement.

Send error email when optional Cloudflare mail setup is configured. Verified recipients and a configured sending domain are required under the selected free sending approach. An installation without mail setup still hosts podcasts, including without a custom domain. Expose notification status through diagnostics; do not treat unconfigured mail as invalid podcast metadata.

Record the publication failure before sending mail. Mail failure is a separate diagnostic, not a reason to repeat publication or recursively send more error emails.

## Delivery and Cache Policy

Without a custom domain, a delivery Worker serves private delivery R2 through `workers.dev` and Workers Cache. Cache hits still invoke the Worker.

With a custom domain, Cloudflare CDN serves the delivery bucket through an R2 custom domain without a delivery Worker. Disable `r2.dev` and unwanted public domains. In Cloudflare terminology, the custom domain is public bucket access; the S3 API remains authenticated. The requirement is that anonymous listeners use the configured CDN path, not that the public custom-domain bucket has no public access mechanism.

Use stable feed and episode audio paths, and version-specific cover paths:

* `/<show-id>/feed.xml`
* `/<show-id>/<episode-id>/audio.mp3`
* `/<show-id>/covers/<revision>.jpg` or `.png`

Preserve episode GUIDs across edits, audio replacement and domain migration. When moving to a custom domain, keep the old workers.dev endpoints redirecting to the new endpoints. Exact redirect codes and RSS migration signaling belong in drafting; no endpoint retirement date has been agreed.

Use 30-day shared-cache freshness with client revalidation, and explicitly purge after updates or withdrawal. The agreed header policy is `Cache-Control: public, max-age=0, s-maxage=2592000, must-revalidate`.

Workers Cache purge must run through its owning delivery entrypoint; custom-domain delivery uses zone CDN purge. Use explicit purge rather than soft invalidation. Report purge failures as incomplete delivery and email when configured, with no automatic retry. Trust the documented purge contract; do not add short cache lifetimes or a cache-auditing subsystem as insurance. Cache TTL does not guarantee retention, and already downloaded audio cannot be recalled.

## Source Retention, Inventory and Backup

Retain immutable management source versions instead of deleting previous MP3s immediately. Duplicate management/delivery copies are accepted. Both buckets and retained history share the account storage allowance.

Track source ownership, type, object identity, operation and update/storage times in each show's SQLite asset ledger. Derive current usage from accepted references and protect the last valid show's required assets. A list of objects is not a complete historical snapshot.

MVP cleanup is explicit, with inspection and confirmation, rather than a periodic deletion service. Never expire accepted assets merely because their keys began as staging keys. Keep abandoned preparations attributable. Exact cleanup eligibility, normal-delete retention semantics and permanent removal behavior remain draft decisions.

Provide minimal manual management export/restore, including authoritative selected references and asset ledger. A metadata export alone is not a backup copy of all MP3 bodies. Define consistency and restoration checks during drafting; no continuous backup pipeline.

## Alternatives Weighed

* **Worker-proxied MP3 upload:** Rejected by author: larger files must not depend on Worker CPU or request-size allowances. Upload directly to R2.
* **Native R2 APIs for everything:** Rejected by author as a constraint: S3 credentials are acceptable for direct uploads and server-side copying; use bindings where practical.
* **CLI-only RSS generation and explicit publish command:** Rejected by author: automatic Cloudflare-side generation supports unattended scheduled releases.
* **Ordinary Worker RSS generation:** Rejected by author: place generation in the selected show DO rather than rely on the ordinary Free Worker CPU allowance.
* **Cron-based release and repair scans:** Superseded by author: use show DO alarms, explicit source acceptance and administrator recovery.
* **R2 current manifest or D1 as the selected-reference store:** Rejected by author in favor of per-show DO SQLite; avoid two authoritative selection stores.
* **Git/GitHub dependency, full MP3 synchronization, automatic merge and built-in diff:** Rejected by author for MVP scope and implementation simplicity. Use metadata-only pull/push and local conflict backups.
* **Strict distributed locking, custom ordered queues and stage-resume recovery:** Rejected by author: temporary inconsistency is acceptable; restart affected publication from current state.
* **Automatic publication retry:** Rejected by author for MVP; record, notify and support explicit recovery.
* **Short TTL as purge-failure insurance:** Rejected by author: use long cache freshness and the documented purge contract.
* **Castloop listener analytics:** Rejected by author for MVP; external podcast platforms may supply useful analytics.

## Planned After the MVP: Static Podcast Websites

Generate static show/episode HTML and CSS into delivery R2 with browser MP3 playback. Rebuild after content changes and show display-timezone changes. Whether this requires a custom domain remains open. Do not replace the administrator's website URL automatically.

Other future possibilities include restoring earlier retained source versions and richer optional podcast metadata. Retention in the MVP does not imply an implemented rollback feature.

## Technical Details Still to Specify

The draft must define authentication and credentials, exact command/API/schema formats, identity/path checks, ID creation collisions, accepted revision versus local ETag handling, supported HTML/RSS fields, media libraries, scheduling crash boundaries, concurrency completion checks, asset registration/cleanup and consistent export/restore. These are unresolved implementation decisions, not authority to add another platform service.

Measure representative feed generation, alarm behavior, direct uploads, R2-side copy, byte-range delivery and cache purge on both delivery routes. Do not claim a measured maximum episode count or free-tier capacity before those checks.

## Provenance and Supporting Material

The seven-lens brainstorm Goldfish review completed on 2026-11-07. Its original findings describe the review-time proposal; later user decisions resolve or supersede them. No new design review has been run.

* [Original brainstorm and subsequent decision history](./concepts_brief_history.md)
* [Goldfish report](./goldfish_review_report.md) and original reports in `reviews/`
* [TOML/RSS mapping proposal](./toml_spec.md)
* [Accepted SQLite protocol and historical manifest alternative](./staged_update_protocol.md)
* [Publication behavior](./publication_execution_flow.md)
* [Error reporting and optional mail](./publication_errors_and_notifications.md)
* [Accepted delivery/cache policy](./delivery_cache_policy.md)
* [Asset ledger proposal](./management_asset_ledger.md)

This consolidated brief controls the transition to drafting. Earlier working notes remain historical where they mention Cron, fully reconstructible SQLite, automatic recovery or the R2 acceptance manifest.
