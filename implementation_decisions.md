# Castloop MVP Implementation Decisions

The finalized design is in [Castloop MVP](./docs/designs/castloop-mvp.md). This note preserves the approved decisions and their alternatives. Only explicitly selected options are adopted; rejected alternatives remain as history.

## 1. Management API authentication

**Status:** A selected by the author for the MVP. B remains an unselected alternative.

The installation has one administrator. CLI requests need authentication before management state changes or publication requests are accepted. Authentication does not grant anonymous listeners management access. Direct R2 uploads continue to use separate S3-compatible credentials under either option.

### A. Installation bearer secret

* **Mechanism:** The administrator configures an installation secret in the management Worker and the local CLI credential configuration. CLI includes it in management requests. Every management route checks it before handling the request.
* **Trade-off:** Castloop owns a small authentication check and documents initial setup and rotation. No separate Access application is required.
* **Failure boundary:** Anyone possessing the secret can act as the administrator. Missing or invalid credentials reject the request. Rotation must update the Worker and CLI; mismatched credentials interrupt management until corrected. Credentials must stay out of synchronized TOML, exports and logs.

### B. Cloudflare Access service token

* **Mechanism:** The administrator configures Access protection for the management endpoint and gives the CLI a service token. The endpoint must enforce that protection on every management route, including any alternative hostname.
* **Trade-off:** Access owns the authentication policy, while deployment and recovery instructions must cover Access configuration, token lifecycle and endpoint protection. Public podcast delivery must remain accessible independently.
* **Failure boundary:** An unprotected alternative route would bypass the intended boundary. An expired or incorrectly configured token/policy blocks management. Castloop must verify the selected deployment integration before exposing the endpoint.

This choice does not change the public RSS/media paths, SQLite acceptance transaction, or direct media upload architecture.

**Accepted permission policy:** Grant only the permissions and resource scopes necessary to deploy, operate and deliver Castloop. The Castloop bearer secret, Cloudflare deployment/API credentials and R2 S3 credentials serve different purposes; do not treat the bearer secret as a Cloudflare account credential. Scope credentials and bindings to the actions and resources each use needs. The exact Cloudflare permission matrix and setup commands may be refined and verified once a working MVP exists. This deferral is not permission to rely on broad account access.

## 2. Asset registration

**Status:** B selected by the author for the MVP. A remains an unselected alternative.

Both options keep uploads direct from CLI to management R2. Registering an asset does not select it as current, advance the accepted revision, or publish it; the final acceptance transaction remains the boundary.

### A. Register planned assets before uploading

* **Mechanism:** CLI first sends the show DO a small request recording intended object keys, ownership and preparation operation. It then uploads directly to R2 and submits the completed update for acceptance.
* **Trade-off:** Adds one management request, but the SQLite ledger knows the intended owner even if CLI stops during upload. Repeating preparation with the same operation and input must not create duplicate rows.
* **Failure boundary:** A planned row does not prove an object exists. A completed upload may still have a planned row if CLI stops before acceptance. Manual inventory checks R2 to reconcile presence; neither case triggers publication.

### B. Upload first and register through acceptance or manual inventory

* **Mechanism:** CLI uploads using keys that identify show, episode, asset kind and preparation operation. Acceptance registers submitted assets. Explicit manual inventory discovers abandoned uploads and adds their ledger entries.
* **Trade-off:** Avoids the initial registration request, but SQLite does not immediately account for uploads abandoned before acceptance. Inventory must interpret the key format and inspect stored objects.
* **Failure boundary:** Before inventory, abandoned objects exist only in R2. Inventory must handle unaccepted show/episode IDs without treating their existence as creation or publication. Ownership cannot depend solely on user-supplied object metadata.

## 3. Reservation and alarm atomicity

**Status:** A selected by the author for the MVP. B remains an unselected alternative. SQL/alarm commit, rollback and interruption tests remain an implementation prerequisite.

Saving a future release must not leave an accepted reservation without a wakeup if execution stops. Either option uses the existing show DO and its one alarm. Neither introduces Cron, a queue service, or automatic retries of known failed publication. Object reads and copies stay outside the storage transaction.

### A. Commit reservation and alarm in one storage transaction

* **Mechanism:** After external checks, use the asynchronous storage transaction API to recheck the expected revision, commit accepted SQL state, and set or remove the alarm for the resulting earliest eligible reservation as one transaction. A failed transaction commits neither change.
* **Trade-off:** Expresses the intended boundary directly. Implementation must use the asynchronous transaction API, not await `setAlarm()` inside `transactionSync()`.
* **Failure boundary:** Confirm SQL/alarm rollback and interruption behavior in the target runtime before relying on this mechanism. If verification fails, return to the author rather than silently switching mechanisms.

### B. Arm a conservative wakeup before committing the reservation

* **Mechanism:** Preserve any earlier required wakeup and arm the alarm no later than the newly proposed release before the synchronous SQL acceptance transaction. Recheck accepted state after storage awaits. If acceptance fails, a harmless extra wakeup may remain. Every alarm reads only accepted SQL state and schedules the next required reservation.
* **Trade-off:** Separates alarm setup from the SQL transaction, but requires rules preventing overlapping changes from moving an existing wakeup later or removing one another operation needs. It can incur unnecessary alarm invocations.
* **Failure boundary:** Stopping before acceptance must leave old accepted reservations covered; stopping after acceptance must leave a suitable alarm. Cancellation and rearming must obey the same rules. This also requires interruption tests.

### Documentation basis and verification

Cloudflare documents that the asynchronous storage transaction includes SQL operations made through `ctx.storage` for SQLite-backed DOs. It also documents that `transactionSync()` supports only synchronous operations. Alarms are part of DO storage. These are the basis for option A; SQL/alarm crash-boundary verification remains required, rather than assuming that a synchronous SQL callback can await an alarm call. See [SQLite storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction) and [alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/).

## 4. Private sources after show/episode deletion

**Status:** A selected by the author for the MVP. B remains an unselected alternative. The author also requires a separate CLI cleanup feature, including an age-in-days filter.

Both options withdraw public resources and purge affected caches. Episode deletion removes its feed entry and public audio. Show deletion removes public feed/media and disables reservations. Public withdrawal does not require destroying the DO's database. This choice concerns management R2 source data, not whether listeners retain access.

### A. Keep private sources after normal deletion

* **Mechanism:** Normal deletion marks the entity deleted, prevents its automatic publication, and retains private TOML, audio, artwork and ownership records. A separate, explicitly confirmed cleanup operation may permanently remove eligible sources later.
* **Trade-off:** Keeps identifiable material for possible future recovery and avoids combining public withdrawal with irreversible source erasure. Retained objects continue to use R2 storage; rollback/undelete is not promised in the MVP.
* **Failure boundary:** Public withdrawal can fail independently and must remain visible as incomplete. Retention alone does not preserve the current live configuration as a complete restorable historical snapshot. Cleanup must protect references still needed by other entities or ongoing operations.

### B. Include permanent private-source removal in confirmed deletion

* **Mechanism:** Deletion explicitly confirms both public withdrawal and irreversible removal of the entity's private source versions. Withdraw public resources first, then erase the confirmed eligible private objects. Preserve enough management state to identify partial failure and prevent automatic republication.
* **Trade-off:** Frees source storage without a later cleanup command, but a normal deletion becomes destructive and cannot support recovery from the erased material. Show deletion must define all contained episodes and any shared artwork in its scope.
* **Failure boundary:** Public and private object deletion is not one transaction. Partial erasure must be reported and must not be called complete. Never remove objects another entity still references; replay uses the same deletion intent rather than recreating erased content.

Both options retain the previously agreed source-version retention policy for entities that have not been deleted. Under selected option A, cleanup is an explicit CLI operation with a candidate preview, confirmation and an administrator-specified age-in-days filter. Age alone never permits deleting live, last-valid-delivery or potentially active assets. Exact command syntax, age timestamp/cutoff and cleanup eligibility remain to be specified. Normal deletion retains enough state to prevent automatic republication and expose incomplete public withdrawal.

## 5. Show discovery

**Status:** A selected by the author for the MVP. B remains an unselected alternative. The author expects roughly one to three shows, with around ten at the high end of normal use; this is not a hard limit.

The CLI needs to list remotely created shows, including on a new computer. Each show's DO remains authoritative for whether the show was actually created and whether it is active or deleted. Unaccepted R2 uploads do not create a show. Both options paginate underlying listings and work independently of a local workspace's contents.

### A. Discover candidates from management R2 prefixes

* **Mechanism:** List management R2's show-ID prefixes and query the corresponding show DOs for their accepted existence and status. Exclude prefixes containing only abandoned preparations from the normal show list. Inventory may still report them as unused material.
* **Trade-off:** Adds no installation-wide live catalogue. Listing requires R2 enumeration and a DO request per candidate show; abandoned prefixes add candidates even if there are few accepted shows.
* **Failure boundary:** Unavailable DO state is an error or an explicitly incomplete listing, not evidence that the show was never created. Accepted creation must leave discoverable management content, and cleanup of a deleted show's last objects must not make that deleted record undiscoverable if the CLI promises to list it. Those creation/deleted-list semantics need specification.

### B. Keep a small installation-wide show catalogue

* **Mechanism:** Add one installation-level DO with SQLite to record show IDs. Show listing reads that catalogue and checks the show DOs for accepted existence/status. Per-show metadata, publication and asset selection remain in their existing show DOs.
* **Trade-off:** Avoids scanning object prefixes for ordinary show listing but introduces another DO and registration rules spanning the catalogue and show creation/deletion. There is no single transaction across those DOs.
* **Failure boundary:** Interrupted creation may leave a catalogue candidate without an accepted show, or an accepted show whose registration needs repair. Define repeatable registration and an explicit reconciliation path; do not treat catalogue presence as publication authority or silently hide an incomplete listing.

This decision selects discovery only. No installation-wide catalogue DO is added. Exact deleted-show listing and preservation of discoverability after cleanup remain to be specified.

## 6. RSS episode GUID representation

**Status:** A selected by the author for the MVP. B remains an unselected alternative. The author requires preserving existing source GUIDs in any future import feature, which remains outside the MVP.

The RSS GUID identifies an episode to podcast applications; it is separate from the short ID that an administrator types in CLI commands. Apple requires an episode GUID that is globally unique and never changes. Both options emit `isPermaLink="false"`, preserve identity across metadata/audio changes and domain migration, and include GUID identity in export/restore. Audio and feed URLs are not the GUID.

### A. Generate a separate UUID-based GUID

* **Mechanism:** Generate a UUIDv4 once at episode creation and persist it as the episode's immutable RSS GUID, represented as `urn:uuid:<UUID>`. Preserve the same value across creation retries, exports and restoration of the same episode.
* **Trade-off:** Stores another identifier, but separates external podcast identity from short CLI IDs and gives it a larger random identifier space. Administrators continue using the short episode ID in commands.
* **Failure boundary:** Regenerating the GUID during edits, feed rebuilds or restore can make applications treat an existing episode as new. Preserve the stored value; do not derive a replacement from the current URL. UUID uniqueness is probabilistic rather than enforced by a global service.

### B. Derive a stable value from show and episode IDs

* **Mechanism:** Use an opaque value such as `castloop:s-k7m3q9t2:e-v4n8wc6r`, with its exact format fixed before first publication. Both IDs must remain immutable. No separate random RSS identifier is required.
* **Trade-off:** Uses the existing IDs, but externally visible identity becomes coupled to their format and reuse policy. Creation collision checks are installation/show-local; they do not establish global uniqueness across independent deployments. The combined IDs have less random space than UUIDv4.
* **Failure boundary:** Reusing the same show/episode ID pair for different content across installations repeats the GUID. Preserve identity when moving the same episode, but do not reuse its pair to create an unrelated episode. Never describe this non-UUID value as `urn:uuid:`.

See [Apple podcast RSS requirements](https://podcasters.apple.com/support/823-podcast-requirements) and [RSS GUID semantics](https://www.rssboard.org/rss-specification#ltguidgtSubelementOfLtitemgt). Neither option changes the accepted eight-character suffixes of management IDs. Under A, the longer UUID is internal/RSS data and need not be typed for ordinary CLI operations.

### Future import compatibility

New MVP episodes use the selected UUIDv4-based format, but store the full GUID as immutable text, not a UUID-only column or a value reconstructed from the short episode ID. A future import must retain the original GUID exactly as an identity value, without regenerating it or adding/changing a prefix. Source GUIDs can be non-UUID strings; preserve source GUID semantics when defining import, including the permalink attribute where relevant. Carry the stored GUID through export/restore. This does not add an MVP import command or make the normal episode editor a GUID-changing interface.

## 7. Age basis for CLI source cleanup

**Status:** A selected by the author for the MVP. B remains an unselected alternative. The author emphasizes that never deleting files still in use is the primary requirement.

The CLI cleanup feature supports an administrator-specified age in days. Both options first restrict candidates to sources eligible for removal. Live, last-valid-delivery and potentially active assets remain protected regardless of age. Candidate preview and explicit confirmation remain required. Neither option adds scheduled cleanup.

### A. Count from the object's storage time

* **Mechanism:** Compare the immutable management object's server-side R2 storage time with the cutoff calculated at command execution. Use that time rather than a local file's modification time or the later inventory registration time.
* **Trade-off:** Reuses existing object facts and works for previously unregistered abandoned uploads without a new retention timestamp.
* **Failure boundary:** An old audio file that becomes unused today can already meet the age threshold and appear immediately in the cleanup preview. This option does not promise a grace period after replacement or entity deletion.

### B. Count from when the source became eligible for cleanup

* **Mechanism:** Record in SQLite when an asset ceases to be protected/used and becomes eligible. Measure age from that point. For abandoned uploads with no prior ledger history, begin the retention period when inventory first confirms cleanup eligibility.
* **Trade-off:** Gives newly unused sources a retention period even when their object bodies are old, but adds eligibility timestamps and rules for clearing/restarting them when references change. Abandoned objects may be retained longer after late discovery.
* **Failure boundary:** Missing or uncertain eligibility history must not be guessed from object age; start a new known period or leave the asset protected. Changes of eligibility and cleanup need consistent checks to avoid applying a stale timestamp to a newly referenced asset.

Use server-side R2 object storage time under selected option A. Protect live, last-valid-delivery and potentially active references regardless of age. Skip objects with uncertain ownership/usage or unavailable SQL. Immediately recheck references before deletion and define coordination with acceptance so a candidate cannot become selected while deletion is underway; a stale preview is not enough. Exact command syntax, cutoff boundary and coordination mechanism remain to be specified. No grace period starts automatically when an old source becomes unused.

## 8. HTTP response for a deleted show feed

**Status:** B selected by the author for the MVP. A remains an unselected alternative.

The author already requires deleted shows to stop serving a feed and return an error. This decision concerns the feed URL of a show explicitly deleted by the administrator, not an invalid show TOML (which preserves the last valid feed), a never-existing ID, or a temporarily stopped show. Both options remove public resources and purge affected caches. Neither promises how quickly each podcast application will react.

### A. Return HTTP 410 Gone

* **Mechanism:** Recognize a deleted show and return 410 from its former feed URL. For direct custom-domain R2 delivery, this needs an edge response rule or another verified supported mechanism because the object has been removed and no delivery Worker is intended on that path.
* **Trade-off:** Explicitly communicates intentional removal, but requires distinguishing deleted shows at the delivery edge and keeping that configuration consistent with deletion. Verify support and setup before finalizing implementation.
* **Failure boundary:** A missing R2 object alone is not a promise of a 410 response. If the selected direct-delivery configuration cannot produce it, revisit the choice rather than adding a Worker silently. Individual podcast applications may handle the response differently.

### B. Return HTTP 404 Not Found

* **Mechanism:** Delete the feed object and use a 404 missing-object response on both delivery paths. Verify the custom-domain R2 response and purge stale feed responses during withdrawal.
* **Trade-off:** Fits object removal without a separate per-show response configuration. It communicates absence without distinguishing deliberate permanent deletion from a never-existing feed.
* **Failure boundary:** Applications may keep checking the absent URL. Cache purge and consistent response handling still require verification; a 404 does not guarantee removal from a podcast directory.

Neither choice adds podcast-directory deletion APIs. Temporary show withdrawal response semantics and deleted-record discoverability remain separate details.

## 9. Supported HTML in descriptions

**Status:** B selected by the author for the MVP. A remains the narrower unselected alternative.

Limited HTML in show and episode descriptions is already agreed. This choice fixes the allowed tags. Both options accept plain text, preserve source TOML and produce field-specific publication validation errors for unsupported elements/attributes rather than silently removing them. Such errors follow the existing invalid-show/invalid-episode publication rules. Neither option promises identical appearance across podcast applications or adds the future website to the MVP.

### A. Paragraphs, emphasis, lists and links

* **Mechanism:** Allow `p`, `br`, `strong`, `em`, `b`, `i`, `ul`, `ol`, `li` and `a`. The only user-supplied attribute allowed is `href` on `a`, with an absolute HTTPS URL. Use a real HTML parser and validate the resulting structure, not regular expressions.
* **Trade-off:** Covers common descriptions and linked show notes with a small supported format. Headings, quotations and code blocks cannot be expressed with their own HTML elements.
* **Failure boundary:** Unsupported markup produces a validation error even when a browser would render it. A podcast application can ignore emphasis or other formatting; Castloop validates its input contract, not application rendering.

### B. Add headings, quotations and code formatting

* **Mechanism:** Allow all of A plus `h2`, `h3`, `blockquote`, `pre`, `code` and `hr`. Keep the same attribute and HTTPS-link restrictions and parser-based validation.
* **Trade-off:** Supports more structured show notes, especially technical podcast descriptions. Adds validation/rendering cases and more variation in appearance across clients.
* **Failure boundary:** Applications may simplify or ignore the additional formatting. The later static website must define styling for these elements if this option is selected.

Both options reject images/embedded media, scripts, event-handler attributes, inline styles and user-supplied classes. The exact parser dependency and XML/CDATA encoding are implementation-plan details; do not interpret either choice as allowing arbitrary HTML.

## 10. Ambiguous local publication times

**Status:** B selected by the author for the MVP. A remains an unselected alternative.

Episodes already retain an IANA timezone, initially filled from the show default. A local time may occur twice when a timezone's clock moves back, or may not exist when it moves forward. The agreed policy is never to choose silently. Both options reject nonexistent local times and require the administrator to enter an existing time. Ordinary unambiguous local datetimes remain supported without an explicit offset.

### A. Require an unambiguous local datetime in the MVP

* **Mechanism:** Report an error for a local time that occurs twice. Ask the administrator to select another local time that resolves to exactly one instant. Do not add an input for choosing between the repeated occurrences.
* **Trade-off:** Keeps datetime input and validation smaller, but administrators cannot schedule a release during the repeated local-time interval even when they know which occurrence they want.
* **Failure boundary:** An episode with an unresolved time remains unpublishable under existing validation rules. This limitation affects timezones with backward clock changes, not normal unambiguous timestamps.

### B. Always allow an explicit UTC offset, including to select a repeated occurrence

* **Mechanism:** Always accept an offset-bearing `published_at`, even when the local datetime is unambiguous. When a local datetime is ambiguous, the administrator supplies the offset corresponding to the intended occurrence. Validate that the local date/time and offset actually match the episode's stored IANA timezone, then persist the resolved instant. Never replace the stored IANA timezone with the offset alone.
* **Trade-off:** Allows publication during the repeated interval, but adds an input form and offset-versus-zone consistency checks. Errors should identify the valid choices rather than silently prefer one.
* **Failure boundary:** Reject an offset inconsistent with the IANA zone. An explicit offset does not make a nonexistent local time valid. Do not rewrite an already accepted instant when the show's default timezone changes.

Accepted TOML forms include local and offset-bearing datetimes. The author clarified that explicit offsets are always permitted, not only when a local datetime is ambiguous; offsets must still agree with the stored IANA timezone. For `timezone = "America/New_York"`, `published_at = 2026-11-01T01:30:00-04:00` selects the earlier repeated occurrence; `published_at = 2026-11-01T01:30:00-05:00` selects the later one. Without an offset that local time is an error, with valid choices reported. The nonexistent `2026-03-08T02:30:00` in that zone is rejected. This choice does not introduce an automatic move-forward policy for missing times or a default first/second occurrence for ambiguous times.

## 11. Discoverability of deleted shows after cleanup

**Status:** B selected by the author for the MVP. A remains an unselected alternative.

Show discovery already uses management R2 prefixes and confirms state with the show DO. Normal deletion retains private sources and the DO ledger. Cleanup may later remove all of a deleted show's source objects. The remaining choice is whether listing deleted shows must still work after that cleanup, without an installation-wide catalogue.

### A. Retain a small discovery marker per accepted show

* **Mechanism:** Keep a small object under each accepted show's management R2 prefix that cleanup does not remove. Ensure it exists before accepted creation. Treat it only as a discovery hint: each DO still decides accepted existence/status. Preparation can leave an unused marker; it does not create a show.
* **Trade-off:** Deleted shows remain discoverable after all source TOML/media are cleaned up. Adds one small object per show and creation/cleanup rules protecting it. Its exact key is an implementation detail.
* **Failure boundary:** Do not treat marker existence as proof of accepted creation or reconstruct SQL state from it. Unavailable DO state means incomplete discovery. Loss of a marker needs explicit repair; it is not grounds to recreate or publish the show.

### B. Allow fully cleaned deleted shows to disappear from discovery

* **Mechanism:** Add no marker. List candidate show prefixes while their source objects remain. After cleanup removes the last source object, the deleted show may disappear from R2-based listings; its DO still retains deletion and ownership/outcome records accessible by a known show ID.
* **Trade-off:** Avoids a permanent discovery object but does not provide a complete deleted-show list after cleanup. Before final cleanup, explain that the show will no longer be discoverable by ordinary listing.
* **Failure boundary:** Missing prefixes do not mean the ID can be reused. Creation checks must still consult the target DO. Administrators need a previously saved ID/export if they later want to inspect a fully cleaned deleted show.

Selected option B adds no permanent discovery marker. After cleanup removes the last source object of a deleted show, it may disappear from ordinary listings. Explain this before final cleanup and retain DO records accessible by a known show ID. Missing prefixes never authorize ID reuse. Both options keep DO state on normal deletion. This choice does not add undelete, automatic reconstruction or destructive DO database removal.

## Remaining decisions

Deleted-show discoverability is resolved. Remaining work covers the external interface details listed in Technical Plan section 13, including cleanup command syntax. Resolve each without treating an earlier section approval as an implicit selection.

## 12. Combined remaining specification proposal

**Status:** Approved by the author after combined review. The author explicitly requested a concrete proposal instead of further individual option gates, and then approved the resulting Detailed Implementation Plan.

The [Detailed Implementation Plan](./docs/designs/castloop-mvp.md#detailed-implementation-plan) specifies the remaining behavior and file inventory. Its main product additions are:

* Restrict MVP RSS extensions to the defined common fields; defer chapters, transcripts, episode artwork and external import.
* Use explicit audio/cover upload commands; cover upload replaces the logical filename already selected by TOML and does not secretly edit metadata.
* Use CLI preview/confirmation and per-object DO deletion claims; reject references to claimed keys and protect active, last-valid and pinned sources. Days are measured from R2 storage time.
* Restore only after strict required-object validation, refuse replacing live targets, retain a hold and require explicit resume before publication or scheduling. Missing required objects abort without changing accepted state.
* Use per-show 301 redirects and generated RSS migration tags, with tested cutover and confirmed rollback; do not promise client-state rollback or retire old endpoints automatically.
* Define concrete command/API/TOML/SQLite shapes, dependencies, a complete proposed file inventory and fault-injection/runtime verification gates.
* Propose application limits of 1 GiB per MP3, 20 MiB per cover, 256 KiB per TOML file and 16 MiB per restore snapshot; these are reviewable guardrails, not measured free-tier limits.

Individual decisions 1–11 and this bundle are accepted. No production implementation or deployed verification has occurred.

## 13. Finalization reconciliation

**Status:** Predecessor comparison complete. The author confirmed `docs/designs/castloop-mvp.md` as the final destination, and the approved design is saved there. This is document reconciliation, not a fresh Goldfish review.

Compared the consolidated concepts brief with the complete approved design. No unresolved contradiction in accepted requirements or architecture was found. The additions affecting interfaces/dependencies below were explicitly approved through individual decisions or the combined Detailed Implementation Plan; none remain implicit.

| Area | Predecessor direction | Approved design refinement |
| --- | --- | --- |
| Storage and publication | R2 content, per-show authoritative SQLite, direct uploads/copy and full RSS | Preserves boundaries; adds concrete keys, SQL tables, versioned operations, target signatures and in-flight source pins. |
| Source safety | Retain versions, explicit age-filtered CLI cleanup, never delete used files | Adds DO deletion claims and reference rechecks; acceptance refuses retired keys. Uncertain pins remain protected. |
| Administration | One administrator, TOML editing, bearer secret and least permissions | Defines command/API/credential contracts and exit codes; exact Cloudflare grants remain a running-MVP verification task. |
| RSS and media | Apple/RSS baseline, stable GUID, common HTML and IANA timezones | Defines supported field scope, defers chapters/transcripts/episode artwork, preserves offsets/GUIDs and establishes explicit application file-size limits. |
| Migration | Keep old workers.dev URLs redirecting to the custom domain | Selects per-show 301 plus generated migration tag, confirmed cutover/rollback and no automatic endpoint retirement. |
| Export/restore | Minimal manual SQL management snapshot, not a media backup | Defines same-bucket strict required-source checks, stopped-target replacement, monotonic revision and explicit hold/resume. |
| Dependencies and files | TypeScript/Bun and Cloudflare; no implementation existed | Selects package dependencies and enumerates planned source/configuration/test/document files. Lock versions and verify runtime compatibility during implementation. |

The brief has been reconciled to reference the approved refinements without treating historical working notes as a second authority. Old raw Goldfish reports remain unchanged. The approved design is the implementation contract; supporting notes explain decisions/history.

Still unperformed: SQL/alarm interruption tests; real R2 cross-bucket copy; cache/range/purge integration on both paths; standalone binary compatibility; representative archive CPU/storage/operation measurements; exact least-permission verification; and fresh-context EGM review of the final document. These are verification tasks, not newly open product choices.

## 14. Stage 5 review refinement — cached range ownership

**Status:** Accepted by the author after reviewing ZO-1. Applied to the finalized design; no implementation or deployed verification has occurred.

Workers Cache owns byte-range slicing on the cached delivery path. The delivery origin streams full 200 representations with accurate lengths and validators. Do not build a duplicate range engine for this path. Add application range handling only if deployed checks demonstrate a supported bypass/uncached path that needs it. Retain public HEAD, single-range, unsatisfiable-range, multiple-range and conditional-response checks on both delivery modes. Report platform mismatches against the intended contract for review; do not silently weaken that contract.

The [Stage 5 report](./reviews/design_review/zoom_out_report.md) records the finding and its disposition. Stages 6–9 remain unperformed.

## 15. Stage 7 round 1 author resolutions

**Status:** Resolved after an item-by-item author review. Two changes applied; one Major finding contested without changing its original severity. No implementation or runtime verification occurred.

* **CR-1 / design-1-1 — accepted with revised wording:** Show stop/deletion does not require publication-ready title, description or cover. Describe this as the operation's eligibility conditions, not as queued work or a priority change. Authentication, identity, revision and confirmation checks remain; source updates still require syntax and supported protocol/schema checks. Invalid metadata preserves last-valid delivery for an active show. Updated the executor policy, delivery behavior and planned verification cases.
* **CR-2 / structural-1-1 — contest approved:** Keep author-attributed alternative decisions. The cited standard restricts unsupported maintainer attribution, and does not require issue/PR links for the author's recorded design choices.
* **CR-3 / structural-1-2 / style-1-1 — accepted:** Replace the stale open-choice wording with remaining implementation/runtime verification gates.

See the [annotated review record](./reviews/design_review/goldfish_review_report.md). Applied fixes have not been re-audited; Stages 8–9 have not run.

## 16. Stage 9 round 1 author resolutions

**Status:** All seven consolidated findings accepted individually and applied on 2026-11-08, including author-revised solutions for IR-3 and IR-4. No production implementation, runtime verification or post-edit re-audit has occurred. Raw reviewer severities are unchanged.

* **IR-1 — accepted:** Define version-1 operation/result/maintenance contracts, canonical fingerprints, logical SQL records and export envelopes. Add ledger inspection GET; keep physical SQL details private and staged restore bounded per show.
* **IR-2 — accepted:** Bind metadata-list pages to one revision. If the revision changes between pages, return an error, leave local TOML/baseline unchanged and ask the administrator to rerun pull. No automatic retry. Referenced immutable TOML bodies are fetched separately from R2.
* **IR-3 — accepted with simplification:** Store the current URL and a nullable pending migration URL in the show's SQLite. Activate redirects only after new-domain media access, full new feed and required purges are ready, using a guarded SQL switch. Reuse existing delivery bucket/keys/MP3s; do not copy audio for migration.
* **IR-4 — accepted with replacement solution:** Use smol-toml plus Zod strict Show/Episode schemas with declared fields and types. Reject unknown keys and type mismatches before uploads and at server acceptance. Missing publication requirements remain saveable drafts. Replace the original arbitrary-field/BigInt preservation proposal; do not require distinguishing numeric spelling 1 from 1.0 when their allowed numeric value is identical.
* **IR-5 — accepted:** One captured affected-show batch per invocation. Newer uncovered concurrent intent stays pending for explicit recovery even if runtime remains. Measure configured DO CPU separately from elapsed time; no predictive budget scheduler, continuation or automatic retry.
* **IR-6 — accepted:** Name parse option `useLegacyDate: false` and serializer option `strictTemporal: true` separately.
* **IR-7 — accepted:** Recovery deletes/rebuilds derived public resources from latest intent, completes withdrawal where requested, and never undeletes an entity.

See the [resolution record](./reviews/design_review/readiness/goldfish_review_report.md). The author subsequently completed the final checkpoint as recorded in section 17. Applying these fixes does not retroactively make round 1 clean or establish review-loop convergence.

## 17. Final review checkpoint

**Status:** The author selected “Conclude review and finalize document” on 2026-11-08 after all seven Stage 9 findings were resolved.

The authoritative design remains [Castloop MVP](./docs/designs/castloop-mvp.md). EGM Stages 5–9 and the approved resolutions are complete; there are no unaddressed review findings. The author chose finalization without a post-edit re-audit. No review-loop convergence, runtime validation or implementation authorization is implied. Implementation verification gates remain in the Detailed Implementation Plan. This checkpoint does not perform a git commit, deployment or production implementation.
