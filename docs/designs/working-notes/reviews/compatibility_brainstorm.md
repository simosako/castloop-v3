# Rollout & Compatibility Brainstorm

## Scope and reading basis

**Persona:** Rollout & Compatibility Brainstormer, applying the **Implementation Readiness Goldfish** persona in **BRAINSTORM** mode.

**Targets read in full:**

- `/home/sim/project/castloop-v3/concepts_brief.md`
- `/home/sim/project/castloop-v3/toml_spec.md`

**Bundled instructions read in full:**

- `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/agents/implementation_readiness.md`
- `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/docs/codex.md`
- `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/resources/execution_instructions.md`

**Applicable standard:** The persona’s BRAINSTORM instructions require evaluating migration, backward compatibility, and rollout/rollback safety. The persona references an unspecified “Target Standard” only in its REVIEW instructions; it names no concrete finished-design standard applicable to this assignment. This report therefore does not claim finished-design or implementation-readiness compliance.

**External resources consulted:** Relevant official documentation excerpts obtained through connected Cloudflare documentation tools, Context7, and direct official-page access:

- [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [R2 consistency and caching](https://developers.cloudflare.com/r2/reference/consistency/)
- [Workers Cache overview](https://developers.cloudflare.com/workers/cache/)
- [Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/)
- [Workers Cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/)
- [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [How the cache works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Apple: Change the RSS feed URL](https://podcasters.apple.com/support/837-change-the-rss-feed-url)
- Context7’s Cloudflare Workers documentation collection, `/llmstxt/developers_cloudflare_workers_llms-full_txt`, for rollback and trigger-configuration excerpts.

No reviewer artifacts were read. The findings concern the documented MVP and its explicitly requested delivery migration; they assume no existing Castloop installation or legacy system.

## Findings

### 1. Major — Delivery migration needs a retained compatibility endpoint and a rollback boundary

**Dimension:** Migration & Backward Compatibility

**Affected scope:** `concepts_brief.md`, “Accepted storage and delivery directions,” lines 52–58; “In-Scope Goals,” line 152. `toml_spec.md`, show `new_feed_url`, line 28, and “Generated values,” line 70.

**Compatibility hazard:** The brief requires subscriptions, old media URLs, and episode identities to survive migration from `workers.dev` to a custom domain, but does not establish what remains at the old hostname. Removing the delivery Worker immediately would break those URLs. Conversely, announcing a permanent feed move before validating the destination lets clients adopt the new URL, making a later return to the old URL more complicated than reverting a configuration value.

Stable GUIDs are already correctly specified; that alone does not preserve addressability.

**Verified service/client behavior:** Apple’s self-hosted migration instructions call for a 301 redirect at the old feed, `itunes:new-feed-url` in the new feed, retention of both for at least four weeks, and unchanged episode GUIDs. These are Apple’s documented instructions, not a guarantee that every podcast client behaves identically. [Apple migration guidance](https://podcasters.apple.com/support/837-change-the-rss-feed-url)

**Migration requirement / minimal recommendation:** Establish that migration keeps the old Worker as a compatibility redirect endpoint for existing feed and media URLs. This still allows new listener downloads to use CDN/R2 delivery. Validate the new feed and media path before announcing the permanent move, and preserve both endpoints during any rollback after announcement. Choose an explicit retention policy for old media links; do not interpret Apple’s minimum feed-transition period as permission to break previously distributed media URLs.

### 2. Major — CLI and scheduled Worker upgrades need a small persistent-format compatibility rule

**Dimension:** Migration & Backward Compatibility

**Affected scope:** `concepts_brief.md`, lines 23–24, 74–81, and “Scheduled publication,” lines 102–108. `toml_spec.md`, proposed schema status, line 5, and generated media values, line 68.

**Compatibility hazard:** The standalone CLI writes authoritative TOML and may prepare publication artifacts that a separately deployed scheduled Worker consumes later. Updating the CLI, updating the Worker, or rolling either back can therefore leave one component reading another version’s stored representation. The documents do not yet say how an unsupported representation is detected or whether an older component may rewrite it.

This is a first-upgrade decision for the proposed system, not a claim that legacy data already exists. The risk becomes particularly concrete if prepared schedules contain resolved timestamps, media revisions, or complete feed snapshots.

**Verified service behavior:** Cloudflare warns that Worker rollback does not change connected resources and that older code can fail when stored data structures have changed. Rolling back Worker code therefore does not restore R2 metadata or prepared publication objects. [Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

**Migration requirement / minimal recommendation:** Record a simple compatibility contract for authoritative metadata and any persisted scheduler artifacts: identify supported formats, refuse unsupported mutation or scheduled execution with an actionable error, and avoid destructive automatic rewrites. State a safe CLI/Worker upgrade order and the condition under which rollback remains supported. No generic migration framework or legacy importer is warranted.

### 3. Major — Cancelled or outdated scheduled work must not survive edits, deletion, or rollback

**Dimension:** Migration & Backward Compatibility

**Affected scope:** `concepts_brief.md`, “Proposed publication sequence,” lines 96–98; “Scheduled publication,” lines 102–108; validation/unpublish decisions, line 116. `toml_spec.md`, scheduling behavior, line 86.

**Compatibility hazard:** The brief already recognizes stale future-feed snapshots. The compatibility consequence needs to become a product invariant: prepared work must not later restore a cancelled episode, deleted show, replaced media revision, or older feed.

For example, an administrator schedules an episode, then unpublishes or deletes it before its due time. A timed Worker acting on the previous preparation could copy the audio back into delivery R2 and restore its RSS entry. Similarly, a CLI edit and a scheduled release can overlap even when the administrator runs only one command at a time. Reverting Worker code does not by itself cancel persisted work.

**Documented gap:** This is explicitly acknowledged at line 106, but the invalidation and cancellation behavior remains open. It is not evidence that the proposed implementation is already unsafe.

**Migration requirement / minimal recommendation:** Adopt one invariant: scheduled work may apply only while its referenced show state, episode intent, media revision, and prepared publication remain current. Unpublish, deletion, replacement, and relevant edits must invalidate or replace affected reservations. Stale work must not mutate delivery. Define a simple manual retry/reprepare path for failed or stale reservations; a workflow engine or operation journal is unnecessary to state this behavior.

### 4. Major — R2 copy completion does not establish listener-visible media availability

**Dimension:** Migration & Backward Compatibility

**Affected scope:** `concepts_brief.md`, required audio-before-RSS ordering, line 32; proposed publication steps 5–6, lines 93–94; scheduled-release target, line 104; deletion behavior, line 35.

**Compatibility hazard:** The proposed sequence confirms the R2 copy, writes the feed, and then invalidates affected caches. That sequence can temporarily advertise media which the public path still reports as missing or stale.

A request for a predictable future audio URL can cache a 404 before release. After the copy succeeds, an authenticated S3 or binding check sees the new object while listeners continue seeing the cached 404. The same distinction affects replacement and deletion: origin state and public delivery state can disagree.

**Verified service behavior:** R2 documents that cached 404 responses may outlive an upload, overwritten objects may retain old cached bodies, and deleted objects may remain publicly available until cache expiry or purge. S3 and Worker binding operations bypass that cache. [R2 consistency and caching](https://developers.cloudflare.com/r2/reference/consistency/)

The phrase “Workers Cache” also needs care: current Workers Caching and the Cache API are distinct systems. In particular, Cache API deletion operates locally rather than providing a global invalidation operation. [Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/), [Cache API behavior](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)

**Migration requirement / minimal recommendation:** Define “media available before RSS” against the configured public delivery path. Ensure negative or stale media responses are cleared or prevented before exposing the corresponding feed entry. Select and name the actual Workers caching surface during drafting, including its invalidation behavior. Treat failed invalidation as incomplete publication or withdrawal when it prevents the promised public state.

### 5. Major — Timezone edits need an explicit policy for existing reservations

**Dimension:** Migration & Backward Compatibility

**Affected scope:** `toml_spec.md`, “Generated values,” line 72, and “Publication time and show timezone,” lines 78–88; `concepts_brief.md`, lines 27–28 and 104–106.

**Compatibility hazard:** The proposed episode value is a local datetime whose meaning depends on mutable show-level timezone configuration. Changing that timezone can reinterpret existing TOML without changing the episode file. Meanwhile, already prepared scheduled work may retain the previous resolved instant.

For example, changing a show from `Asia/Tokyo` to another timezone can make the current metadata and stored reservation disagree about when the same episode is due. A later regeneration or rollback might silently switch between interpretations.

**Documented gap:** The specification explicitly leaves future-episode behavior open and proposes preserving published instants. That is the right issue to resolve; the proposal is not yet an accepted contract.

**Migration requirement / minimal recommendation:** Choose whether timezone edits preserve existing reservations’ instants or explicitly reschedule them according to their local wall times. A simple default is to preserve existing resolved instants and require deliberate episode edits to reschedule. Preserve enough durable information to reproduce the chosen policy after a new CLI installation or Worker rollback, while retaining authoritative TOML as required. Exact field names can wait.

### 6. Nit — Initial scheduler deployment has a different readiness window from normal release timing

**Dimension:** Migration & Backward Compatibility

**Affected scope:** `concepts_brief.md`, “Scheduled publication,” lines 102–108, and self-deployment overview, line 9.

**Compatibility hazard:** The one-to-two-minute target is explicitly a normal-operation target, which is appropriate. The self-deployment path does not yet distinguish that state from a newly added or changed Cron Trigger. An administrator could finish deployment and immediately reserve a release, assuming the schedule is already active.

**Verified service behavior:** Cloudflare documents that adding, changing, or deleting Cron Triggers can take up to 15 minutes to propagate. This is a trigger-configuration caveat, not evidence that every unchanged periodic invocation has that delay. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

**Migration requirement / minimal recommendation:** Make scheduler activation readiness visible during deployment and document that the normal release target applies after activation. Define what happens to reservations that become overdue during setup or redeployment; a later successful tick should reconcile still-valid due work rather than requiring the exact scheduled minute to have been observed.
