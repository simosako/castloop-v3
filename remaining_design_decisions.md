# Design checkpoint after the four implementation topics

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** The four topics and the three follow-up policy directions are agreed at brainstorming level. Domain migration uses redirects; source retention uses a SQLite asset ledger and manual cleanup; administrator retry and manual management export/restore remain minimal. Exact protocol, schema and command details belong in drafting.

## Completed topics

1. CLI update acceptance: prepare immutable R2 objects, notify the show DO, commit selected references and operation identity atomically in SQLite.
2. SQLite contents: selected source references, revisions/operation identity, release times and public outcome/error state. Accepted selection is persistent service data.
3. Publication and failure: one show DO, full feed generation, affected media only, whole-operation restart on administrator recovery; DO alarms for reservations; no automatic application retry; durable error reporting and optional administrator email.
4. Delivery cache: stable feed/audio URLs, changing cover URLs, 30-day shared-cache freshness with client revalidation, explicit purge on changes/withdrawal, and record/notify on failure. Trust the platform purge contract rather than adding a short-TTL safety mechanism.

## Remaining product choices worth resolving

### Delivery-domain migration

**Accepted:** Redirect old workers.dev feed/media endpoints to the new domain, preserving episode identities. Old endpoints remain available to perform those redirects. Exact redirect codes, RSS signaling, retention duration and rollback sequence belong in the draft; no new time limit is selected here.

The requirement to start without a custom domain and later bypass the delivery Worker is accepted. The old feed and media URL behavior during that migration still needs agreement. Recommend keeping old workers.dev endpoints usable through redirects to the new domain, preserving GUIDs and defining a deliberate rollback path. Do not retire the old hostname merely because the new feed is reachable. Retention duration and feed migration signaling remain open; consult directory guidance before finalizing those values.

### Retained source and cleanup

**Accepted:** Retain source versions in management R2, including old MP3s, rather than immediately deleting them. Track object ownership, identity and times in SQLite. MVP cleanup is explicit. Future rollback is a possible extension, not MVP scope. See the [asset ledger proposal](./management_asset_ledger.md). The historical recommendation below is superseded where it treats retention as undecided.

Unpublish retains management assets by agreement. Define whether explicit show/episode deletion also retains those assets, and how an administrator deliberately removes them permanently. Separately define cleanup for abandoned preparations and obsolete source revisions; these grow storage even though ordinary publication only duplicates current audio. Recommend an explicit maintenance command first, with SQL-selected and last-valid-show assets protected, rather than a new periodic cleanup subsystem. Exact grace periods and command names remain open.

### Administrator recovery and backup

**Accepted:** Minimal administrator-initiated retry and manual management export/restore in the MVP. Exact commands and consistent export mechanics remain drafting details. No automatic retry or continuous backup service is added.

Define how an administrator retries a failed scheduled release after inspecting the error; no separate manual publish step is required for normal operation. Recommend a small explicit retry action using current accepted state and the same full-restart operation. Retrying uncertain source acceptance still uses its original operation ID. These are different intents and must not silently restore old metadata.

SQLite now owns accepted selection, so deleting it loses information that a raw R2 listing cannot reliably reconstruct. Recommend a minimal manual export/restore path for management state, together with the referenced R2 contents. This does not require a continuous backup service. Exact recovery commands and snapshot consistency rules can be specified in the technical draft.

## Technical details suitable for drafting

Single-administrator API authentication and credential setup/rotation, exact SQL columns, ID and schema-version validation, API/CLI command spellings, local baseline handling against accepted SQL revisions, alarm arming around crashes, HTML sanitizer/media inspection libraries, and CLI/DO upgrade compatibility still need concrete specifications. Prefer one installation management credential and the already accepted S3 upload credentials over account/multi-user machinery. Authentication must be specified before implementation exposes management operations.

Check representative feed generation, upload/copy/range delivery, alarm/error behavior and Free-plan cache configuration during implementation. No measured free-tier capacity guarantee has been established. These are verification tasks rather than reasons to reopen accepted product behavior.

## Suggested next step

The user has agreed to these policy directions. Prepare a coherent final concepts brief for user review, carrying the minimal ledger proposal and any unresolved protocol details into the draft. Exact schemas, dependencies and setup steps can be developed section by section in egm-draft after the user confirms readiness. Do not enter drafting or launch another review automatically.
