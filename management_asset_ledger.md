# Management R2 retention and asset ledger

**Authority:** [Approved design](./docs/designs/castloop-mvp.md#detailed-implementation-plan). The approved Detailed Implementation Plan, sections 4–6, defines upload-first registration, per-object cleanup claims and source pins, elapsed-day cutoff, and export/restore. The pre-upload flow below remains superseded history.

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Accepted direction: retain source versions, manage ownership/time in a SQLite ledger, and use explicit cleanup in the MVP. Registration uses upload first, then acceptance or manual inventory. The earlier pre-upload flow below is superseded history.

## Scope

Management R2 holds immutable TOML, MP3 and cover versions. Do not automatically remove the previous source merely because a replacement was accepted. The user values keeping this material for a future restore-previous-version feature. Implementing that feature is outside the MVP.

Keep the current accepted-reference tables already agreed. Add a small asset ledger in each show DO's SQLite. It accounts for source objects; it is not a public-copy processing journal or a job queue. Retention does not imply downloading old MP3s during pull.

## Proposed minimum asset record

| Information | Purpose |
| --- | --- |
| Object key | Identifies one immutable management R2 object |
| Show ID and optional episode ID | Assigns ownership; show TOML and cover need no episode ID |
| Kind | Show TOML, episode TOML, audio or cover |
| Operation ID | Groups the files prepared for one request |
| Server registration time and confirmed stored time | Explains when the version was prepared/stored without relying on local file modification times |
| Size and confirmed object identity/ETag | Inspects inventory and identifies the exact stored object |

Current accepted references determine which assets are active. Keep last-valid-show references protected independently. An object unreferenced by the current version is retained history or abandoned preparation; it is not automatically garbage. A source object can be reused across metadata-only changes. Existing inspected media facts stay bound to their audio identity.

Retain per-update acceptance revision/time and its selected source references if historical associations are needed during drafting. Do not claim an object list alone is a complete prior-show snapshot. MVP promises retained, identifiable material, not an implemented rollback operation or a full audit system.

## Accepted registration direction

Upload directly to attributable immutable R2 keys without an initial registration request. Register submitted, verified assets during the final SQLite acceptance transaction. Explicit manual inventory later registers abandoned uploads; before inventory they may have no SQL row. Inspect key ownership and object identity, and handle unaccepted entities without creating or publishing them. Missing ledger entries alone do not establish that an object is safe to delete. The approved Detailed Implementation Plan defines inventory and cleanup safeguards.

## Earlier registration proposal (superseded)

To account for a CLI failure before the existing final notification, recommend one small preparation call before file upload:

1. CLI generates and saves its operation ID and tells the show DO the intended object keys, targets, kinds and sizes. DO registers those planned assets idempotently. This does not accept new source references or change public state.
2. CLI uploads file bodies directly to R2. Worker/DO still never proxies the audio.
3. On final acceptance notification, DO verifies object presence/identities and confirms the stored asset records. The same SQL acceptance transaction selects current references and records acceptance as already agreed. Incomplete but identifiable draft content still follows existing validation rules.

A planned row can legitimately have no completed object. Conversely, CLI failure after upload can leave a stored object whose row is still only planned. Explicit inventory/cleanup reconciles those cases against R2; notification-free preparation never becomes accepted content. No periodic Cron scan is required. Distinguish operational asset registration from source acceptance so an extra preparation call does not turn into partial publication.

Keep show/episode IDs and operation identity in deterministic keys under the appropriate owning prefix as well. That makes exceptional unregistered objects attributable during explicit inventory, without making key parsing the authority for acceptance. Define exact immutable layout in the technical draft.

## Cleanup and deletion

Provide explicit CLI inventory/cleanup operations rather than immediate or periodic source deletion. Support an administrator-specified age-in-days filter measured from server-side R2 object storage time; define the exact command and cutoff boundary during Detailed Implementation. Before destructive cleanup, show candidates and sizes and obtain administrator confirmation. The primary requirement is never deleting files still in use: protect live selected assets, last-valid-show assets, and potentially active preparations regardless of age. Missing/inaccessible SQL state or uncertain ownership/usage is a reason to skip deletion, not evidence that objects are unused. Recheck references immediately before deletion and define coordination with acceptance to prevent selecting a candidate during its deletion.

Accepted by author: normal show/episode deletion withdraws public resources and marks the management entity deleted while retaining its source assets and ownership records. Permanent source removal is a separate confirmed CLI cleanup action. Exact delete/cleanup command behavior must be specified in drafting. Do not destroy a show DO's ledger when public show delivery is deleted. Retention does not promise MVP undelete/rollback functionality.

A later cleanup can intentionally discard older material; history cannot be restored after that removal. Report partial cleanup failures without losing the information needed to inspect remaining objects. Do not add stage-resume or a continuous garbage-collection service merely to implement manual cleanup.

## Backup boundary

The accepted minimal manual management export/restore must include the selected-reference state and asset ledger, with access to their referenced R2 objects. A metadata export is not a second copy of the MP3 archive. Define snapshot consistency and verification in the technical draft. No continuous backup pipeline is part of this decision.
