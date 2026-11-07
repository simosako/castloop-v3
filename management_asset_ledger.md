# Management R2 retention and asset ledger

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Accepted direction: retain source versions, manage ownership/time in a SQLite ledger, and use explicit cleanup in the MVP. Fields and registration flow below are a minimal proposal for the technical draft.

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

## Proposed registration and upload flow

To account for a CLI failure before the existing final notification, recommend one small preparation call before file upload:

1. CLI generates and saves its operation ID and tells the show DO the intended object keys, targets, kinds and sizes. DO registers those planned assets idempotently. This does not accept new source references or change public state.
2. CLI uploads file bodies directly to R2. Worker/DO still never proxies the audio.
3. On final acceptance notification, DO verifies object presence/identities and confirms the stored asset records. The same SQL acceptance transaction selects current references and records acceptance as already agreed. Incomplete but identifiable draft content still follows existing validation rules.

A planned row can legitimately have no completed object. Conversely, CLI failure after upload can leave a stored object whose row is still only planned. Explicit inventory/cleanup reconciles those cases against R2; notification-free preparation never becomes accepted content. No periodic Cron scan is required. Distinguish operational asset registration from source acceptance so an extra preparation call does not turn into partial publication.

Keep show/episode IDs and operation identity in deterministic keys under the appropriate owning prefix as well. That makes exceptional unregistered objects attributable during explicit inventory, without making key parsing the authority for acceptance. Define exact immutable layout in the technical draft.

## Cleanup and deletion

Provide explicit inventory/cleanup operations rather than immediate or periodic source deletion. Before destructive cleanup, show candidates and sizes and obtain administrator confirmation. Protect current selected assets, last-valid-show assets, and potentially active preparations. Missing/inaccessible SQL state is not evidence that all R2 objects are unused.

Recommend that normal show/episode deletion withdraw public resources and mark the management entity deleted while retaining its source assets and ownership records. Permanent source removal is an explicit maintenance action. This is consistent with the requested retention direction but exact delete/cleanup command behavior must be specified in drafting. Do not destroy a show DO's ledger when public show delivery is deleted.

A later cleanup can intentionally discard older material; history cannot be restored after that removal. Report partial cleanup failures without losing the information needed to inspect remaining objects. Do not add stage-resume or a continuous garbage-collection service merely to implement manual cleanup.

## Backup boundary

The accepted minimal manual management export/restore must include the selected-reference state and asset ledger, with access to their referenced R2 objects. A metadata export is not a second copy of the MP3 archive. Define snapshot consistency and verification in the technical draft. No continuous backup pipeline is part of this decision.
