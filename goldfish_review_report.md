# Goldfish Brainstorm Review Report

**Date:** 2026-11-07  
**Mode:** BRAINSTORM  
**Targets:** `concepts_brief.md`, original lines 1–210; `toml_spec.md`, lines 1–177. References below use those reviewed lines, before the synthesis append.  
**Disposition:** Seven lenses completed. No Blocker established; 10 deduplicated Major decisions/risks and 4 Nits. The CLI and two-bucket direction is proportionate. This is a brainstorm review, not approval of a technical design or a free-tier feasibility claim.

## Reviewer completion and evidence

| Requested reviewer | Persona | Native completion | Verbatim report |
| --- | --- | --- | --- |
| egm-design | `agents/design_critic.md` | completed | [Architecture and costs](./reviews/design_brainstorm.md) |
| egm-codebase-details | `agents/codebase_details.md` | completed | [Operations and diagnostics](./reviews/operations_brainstorm.md) |
| egm-zoom-out | `agents/zoom_out.md` | completed | [Simplicity and reuse](./reviews/simplicity_brainstorm.md) |
| egm-comprehension | `agents/comprehension.md` | completed | [UX and ergonomics](./reviews/ergonomics_brainstorm.md) |
| egm-implementation-readiness | `agents/implementation_readiness.md` | completed | [Rollout and compatibility](./reviews/compatibility_brainstorm.md) |
| egm-structural | `agents/structural.md` | completed | [Maintainability](./reviews/maintainability_brainstorm.md) |
| egm-inventive-catalyst | `agents/inventive_catalyst.md` | completed; no false compromise detected | [Inventive assessment](./reviews/inventive_brainstorm.md) |

Each reviewer was launched with `fork_turns: "none"`, an explicit BRAINSTORM task, absolute input paths, and no parent transcript or other reviewer findings. At most two reviewers ran concurrently. The first six ran in three pairs; the seventh ran afterward. All seven returned actual final-completion results; none failed, timed out, or required retry. The synthesizer saved their returned reports verbatim and inspected the resulting files. Each report records the persona, both targets, `docs/codex.md`, and `resources/execution_instructions.md` actually read. The zoom-out lens also read `resources/document_standards/zoom-out-standard.md`; the inventive lens used its inline pattern catalog. Other personas name no concrete additional BRAINSTORM standard. Bundled paths resolve against `/home/sim/.codex/plugins/cache/egm/egm/0.1.0`.

Reading evidence consists of the reviewers' explicit reading records and native completion results; this host does not expose their complete nested tool transcripts to the synthesizer. Fresh conversation turns do not establish exclusion of host instruction files, shared filesystem access, or memory services. Instruction-file exclusion remains unverified.

Reviewers evaluated concept behavior and risks rather than imposing finished-design templates. No production implementation was created or inspected, except a limited reuse inventory by the zoom-out reviewer: no `.codegraph/` index or implementation/dependency files were found in its documented inventory scope. That is not a claim about ignored files or external code.

## Blockers

None established. Open policies explicitly marked as open are decisions to resolve, not evidence that the architecture is impossible. No reviewer established that scheduling, workers.dev delivery, or R2-side promotion is infeasible.

## Major findings

### M1 — One administrator still leaves CLI and scheduler as concurrent publishers

**Lenses:** design §1; zoom-out §1; comprehension E3; implementation-readiness §3; structural §1.  
**Scope:** `concepts_brief.md:87–108`; `toml_spec.md:86–88`.

A timed release can select prepared content, then overwrite a newer CLI feed or restore cancelled/deleted media. Sequential CLI use does not prevent overlap with Cron. Merely checking a generation before several later writes is not cross-object atomicity.

**Recommendation, unresolved:** Define one publication-ordering contract shared by immediate and scheduled operations. State how accepted edits, replacements, cancellation, deletion and due-time overlap supersede reservations; how stale work is prevented from mutating delivery; and how still-valid failed work is retried or re-prepared. Tie preparation to current show/episode/media revisions. Select the smallest mechanism after those behaviors are agreed; no journal, workflow platform, or global lock service follows automatically.

### M2 — Draft saving, invalid candidates and intentional withdrawal need a behavior table

**Lenses:** design §3; zoom-out §4; comprehension E1; structural §2.  
**Scope:** `concepts_brief.md:26–35,50,89–96,112–116`; `toml_spec.md:94–100`.

Invalid episode metadata, invalid show metadata/artwork, invalid replacement audio and either `publish = false` can affect the feed and existing media URLs differently. Leaving each command to choose independently would make ordinary edits unpredictable and duplicate reconciliation rules.

**Recommendation, unresolved:** Choose a compact table stating whether metadata saves, what remains public, what is withdrawn, whether direct media URLs keep working, and when pending reservations are cancelled. Preserve the accepted withdrawal of an MP3 found unpublishable, while identifying the revision and event being judged. Preserve the accepted distinction that an interrupted upload alone does not invalidate the working public revision. Do not extend the MP3 rule silently to every incomplete draft or invalid cover.

### M3 — Public media availability must precede feed exposure, including cache work

**Lenses:** design §4; zoom-out §2; implementation-readiness §4.  
**Scope:** `concepts_brief.md:32,35,50–56,81,93–94,104`; `toml_spec.md:86,102`.

The proposed sequence confirms the R2 copy, writes RSS and then invalidates caches. A cached missing-media response can survive the successful copy, so this sequence does not establish the accepted public audio-before-RSS behavior. Replacement and deletion have the same origin/public-state distinction. [R2 consistency documentation](https://developers.cloudflare.com/r2/reference/consistency/)

**Recommendation, unresolved:** Specify media availability against the configured public delivery path. Clear or prevent negative/stale media responses before exposing the feed entry, then expose and refresh the feed. Name cache ownership, TTLs and failure reporting separately for workers.dev and custom-domain CDN delivery.

**Verified platform distinction:** The lower-level Cache API's `cache.delete()` is local to a data center. Current Workers Caching supports global `ctx.cache.purge()`, including workers.dev, but scopes it to the owning Worker and calling entrypoint; another Worker or a zone purge cannot directly clear it. A small authenticated call into the owning delivery entrypoint is one candidate, not a selected design. [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/), [Workers Cache](https://developers.cloudflare.com/workers/cache/), [purge ownership and scope](https://developers.cloudflare.com/workers/cache/purge/)

### M4 — Inspected media facts need a durable association with exact uploaded bytes

**Lenses:** design §2; zoom-out §3; structural §3.  
**Scope:** `concepts_brief.md:24–25,50,74–78,89–93,106,123–143`; `toml_spec.md:68–70,173`.

The CLI inspects audio, but another computer and the scheduler must recover duration, size, MIME and approval without downloading the archive. A mutable `audio.mp3` key alone cannot show that the currently stored bytes are those originally inspected; reservations may otherwise promote a later replacement.

**Recommendation, unresolved:** Retain a small generated private media descriptor or equivalent metadata tied to an explicit inspected revision/object identity. Define replacement invalidation and recovery from another computer. Keep these facts generated, outside hand-maintained TOML fields. This is a data-flow inference; no particular R2 revision API or storage representation has been selected or verified by this finding.

### M5 — Saved intent, effective publication and unattended failure need distinct evidence

**Lenses:** codebase-details O1/O2; comprehension E2.  
**Scope:** `concepts_brief.md:30–32,87–116`; `toml_spec.md:68,86,102`.

Valid authoritative TOML does not establish that listeners receive the current feed or media. Cron invocation success also does not establish that each due episode completed copying, feed replacement and invalidation. Without a minimal observed-state contract, an administrator cannot diagnose an overdue release or recover after losing CLI output.

**Recommendation, unresolved:** Agree on human-readable outcomes such as saved draft, blocked, scheduled, published and publication incomplete. Report completed stages and a useful next action. Keep `check` read-only and distinguish metadata validity, due/overdue reservations, observed public resources and unverified delivery. Record show/episode IDs, due instant, attempt time, completed stage and failure reason for unattended work, initially using native logs if sufficient. Cloudflare provides [Cron history](https://developers.cloudflare.com/workers/configuration/cron-triggers/#view-past-events) and [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/); their existence does not prove the eventual app captures the needed evidence. No listener analytics or new monitoring service is implied.

### M6 — Sequential local edits can still overwrite newer authoritative TOML

**Lens:** comprehension E4.  
**Scope:** `concepts_brief.md:23–24,89–98`.

An older file from another computer can revert publication intent or release time even when commands never overlap. The per-show operation preference addresses neither an old local baseline nor the administrator's understanding of what will be overwritten.

**Recommendation, unresolved:** Choose a simple stale-baseline warning/rejection and a way to obtain the current TOML and reapply edits. Decide how genuinely new local inputs and any explicit replacement route are handled. No merge engine, multi-user system or distributed lock is needed to state this contract.

### M7 — Incomplete metadata and structurally unusable input need different save rules

**Lens:** comprehension E5.  
**Scope:** `concepts_brief.md:30,90`; `toml_spec.md:9,177`.

Missing a title can be an ordinary saved draft. Unparseable TOML or an ID/path mismatch can make the authoritative object unusable or ambiguous; treating all failures as saved-with-errors would hide that difference.

**Recommendation, unresolved:** Define accepted incomplete metadata versus rejected updates. A small candidate policy rejects parse/identity failures without replacing the previous authoritative object, while saving identifiable, supported drafts missing publication fields. This is a recommendation for agreement, not a newly accepted rule.

### M8 — Show timezone edits can reinterpret existing publication times

**Lenses:** design §6; comprehension E6; implementation-readiness §5; structural §4.  
**Scope:** `concepts_brief.md:27–28,104,194`; `toml_spec.md:72,78–88`.

The same local episode datetime resolves to another instant after a timezone edit. Existing prepared work can retain the old instant while later CLI processing uses the new one. The documents correctly mark published-instant preservation and future-reservation behavior as proposals/open choices.

**Recommendation, unresolved:** Choose whether existing reservations preserve their instants or are deliberately reinterpreted/rescheduled. State effects on already published dates and retain enough generated information to reproduce the chosen interpretation. Show the named timezone and resolved offset/instant when scheduling. Preserve the existing rejection of silent daylight-saving ambiguity; exact syntax can wait.

### M9 — Delivery migration needs old-URL continuity and a rollback boundary

**Lens:** implementation-readiness §1.  
**Scope:** `concepts_brief.md:52–58,152`; `toml_spec.md:28,70`.

Stable episode GUIDs preserve identity, not URL addressability. Removing the old Worker breaks existing feeds/media; announcing a permanent move can cause clients to retain the new URL even if deployment is later reverted.

**Recommendation, unresolved:** Validate new delivery first and retain the old Worker as a compatibility endpoint/redirect path. Choose feed-transition and old-media retention policies, and keep the destination working through rollback after announcement. Apple's guidance calls for an old-feed 301, `itunes:new-feed-url`, unchanged GUIDs and at least four weeks of feed-transition support; that minimum does not determine the lifetime of previously distributed media links or every client's behavior. [Apple migration instructions](https://podcasters.apple.com/support/837-change-the-rss-feed-url)

### M10 — Independently upgraded CLI and Worker need a small format-compatibility rule

**Lenses:** implementation-readiness §2; structural §5.  
**Scope:** `concepts_brief.md:9,23–24,74–85,102–108`; `toml_spec.md:5,68,175–177`.

The CLI, Worker, authoritative metadata and prepared artifacts can outlive one another. An older component may misinterpret a newer persisted representation. Cloudflare Worker code rollback does not restore connected storage or undo data-format changes. [Worker rollback limitations](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

**Recommendation, unresolved:** During drafting, define detectable supported formats, an actionable refusal for incompatible mutation/release, and a safe upgrade/rollback order. This concerns the proposed first upgrade, not an invented legacy migration. A generic migration framework is unnecessary.

## Nits and proportional guardrails

### N1 — Bound minute-polling work before claiming low/free-tier cost

**Lenses:** design §5 (reported Major); zoom-out §5 (reported Nit).  
**Scope:** `concepts_brief.md:11,83,100–108,114`.

The concept does not require a full archive scan, so no measured performance defect is established. A 30-day month contains 43,200 minute ticks; 100 object reads per tick would be 4.32 million reads, before listing and release work. Listing is an R2 Class A operation; included allowances are account-level. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

**Recommendation:** State a representative workload, estimate idle-tick/release operations and measure CPU/subrequests. Compare straightforward pending-reservation enumeration with a small derived pending-work manifest. The former has fewer artifacts; the latter adds synchronization/rebuild work but can avoid archive-size polling. No database or queue is assumed. Synthesized as Nit because this is an unselected implementation and no measurements establish a current limit violation.

### N2 — Illustrate duplicate storage and choose temporary-copy cleanup

**Lens:** design §7.  
**Scope:** `concepts_brief.md:11,48,143`.

At 30–50 MB per episode, 52–104 annual releases and two retained copies, one show adds about 3.12–10.4 GB of audio per year before temporary copies and artwork. This is a simple illustration from the brief, not a forecast. Decide when abandoned candidates and superseded temporary copies are removed; preserve accepted duplicate storage and the actual podcast archive. No archival service follows.

### N3 — Make stable IDs discoverable through ordinary CLI use

**Lens:** comprehension E7.  
**Scope:** `concepts_brief.md:18,24–25,120–143`; `toml_spec.md:143–173`.

Creation should return identity and an editable starting point; a lightweight list/retrieve path should show titles and stable IDs without downloading media. Exact command spelling and interactive selection can wait. This avoids requiring the administrator to inspect R2 keys or maintain a personal UUID list.

### N4 — Distinguish initial scheduler activation from normal release timing

**Lens:** implementation-readiness §6.  
**Scope:** `concepts_brief.md:9,102–108`.

Cloudflare documents up to 15 minutes for Cron configuration changes to propagate; that does not mean unchanged ticks normally have that delay. Show activation readiness and define catching still-valid overdue reservations on a later successful tick. Keep the accepted 1–2 minute target scoped to normal active operation. [Cron configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## Small practical alternatives and next hypothesis

Retain direct source uploads, R2-side promotion, CLI processing, two buckets, stable identities, explicit TOML operations and the excluded analytics/website scope. Inventive Catalyst found no false compromise and recommended no new pattern.

The next anchored hypothesis should explain one release through ordinary editing, cancellation and partial failure. A prepared-complete-feed candidate retains CLI feed generation but must regenerate/supersede future artifacts after relevant edits. A pending-work manifest may make discovery cheap, but adds derived-state maintenance. Native logs plus read-only public checks are a smaller diagnostic starting point than a new journal or dashboard. These are alternatives and recommendations, not approvals or newly selected architecture.

Resolve the withdrawal table and reservation behavior first; use their answers to select publication ownership, media revision records and cache ordering. Keep exact command names, dependency selection and full implementation plans for later drafting. No code was changed, no deployment was performed, and `toml_spec.md` remains unchanged.

## Subsequent decisions

Accepted placement decision: the user selected Cloudflare-side full feed generation in one DO per show and SQLite for derived publication/scheduling state. No explicit publish command is required; it was suggested only to enable CLI-side rendering. Existing update-triggered publication, unattended scheduled release, full delete/recreate retries, direct CLI MP3 uploads, R2 authority, and invalid-show preservation remain. D1, custom queues and strict distributed locking are not added. This supersedes the earlier CLI-heavy XML-generation preference while retaining CLI preflight/media inspection. Schema, scheduler wiring, cache handling and measured free-tier feasibility remain technical design work.

Workload correction and new alternatives: the user clarified that one show is common but three or five are plausible and more than ten is rare, not a hard limit. They proposed explicit CLI feed generation, full XML regeneration only, and considering free-tier DB storage including DO SQLite. Feed generation placement remains open; explicit CLI-only generation conflicts with existing unattended scheduled release and cloud-side current-state regeneration unless requirements change or full prepared feed snapshots are maintained. The new comparison recommends a shared show DO generator plus derived SQLite state if unattended behavior stays, while preserving direct media upload, R2 authority and full restart semantics. This is not a user-approved DO adoption or a free-tier feasibility result.

Recovery clarification: the user requires retrying failed publication from scratch, deleting affected delivery files and regenerating feed XML, rather than inspecting stages and resuming midway. Typical deployment size is about one show, with episode growth around 100 per year. The revised proposal favors lightweight periodic inventory/metadata checks (A) over a separate pending queue plus rotating-show verification (C). Complete retries affect the selected episode's media and full feed; they do not imply re-copying every episode's audio. Preserve the accepted invalid-show/last-valid-feed exception. Discovery, generated feed inputs, CPU costs and cache failure handling remain draft details; no mechanism has been adopted.

Governing clarification after the concurrency discussion: the user accepts temporary incorrect public state, including audio briefly reappearing after overlapping withdrawal/publication, provided conflicts/failures are detected or revisited and delivery ultimately converges to current accepted administrator intent. M1 and M3 must be assessed against this requirement, not strict isolation or zero transient inconsistency. Retry-based reconciliation is a candidate again; no permanent lock, queue, or DO is accepted. Recovery discovery after crashes and late writes still needs a small explicit design. Preserve source-edit protection, validation, and confirmation rules. Original review findings are historical evidence and do not impose a stronger consistency requirement.

After this review, the user resolved part of M2: failed episode publication validation withdraws that episode from RSS and removes its public MP3/cache copies, even if previously published. The management TOML and source MP3 are retained and errors are reported. This covers invalid episode metadata as well as invalid media. The live brief and TOML proposal now record this rule; original reviewer reports and review-time references remain unchanged.

The user then resolved show validation failure: return errors and preserve the last valid public feed and its required delivery resources. Invalid show TOML or artwork must not stop a working feed. The user subsequently required rejecting episode additions and updates with errors while current show TOML is invalid, and blocking previously registered timed releases in that state. The user then selected immediate automatic publication processing for overdue eligible episodes after a valid show correction, with no extra episode edit. Episode unpublish was then resolved: `publish = false` removes the RSS entry and public MP3/cache copies while retaining management TOML/audio, and prevents old reservations from republishing it. Show-level unpublishing was then resolved: explicitly confirm the administrator intent, then remove public MP3s/feed and invalidate caches while retaining management data. Structural input acceptance remains open. These follow-up decisions do not change the original review findings or counts.

The user subsequently resolved M8: show timezone is a default; the CLI fills a missing episode timezone on initial save and persists it in episode TOML. A show timezone edit leaves existing episode TOML and reservation instants unchanged. Future static pages display episode instants in the current show timezone and regenerate when that setting changes. The user also confirmed preserving an existing stored episode timezone when a later input omits it; do not apply the changed show default to that update. Original reviewer findings are retained as historical review evidence.

The user resolved the syntax-error portion of M7: format-check TOML in the CLI before sending it to R2; report syntax errors and abort processing without changing remote data or publication. Parseable but publication-incomplete TOML continues to use the accepted save-and-validate policy. Original review-time findings remain unchanged.

M6 follow-up: the user selected a warning/confirmation flow and permits replacing remote TOML with an older local version after explicit approval. Local modification time was proposed for detection; comparison with a recorded remote ETag is an alternative under discussion. The override behavior is accepted; the detection mechanism and baseline representation are not yet selected.

M6 subsequent decision supersedes the ordinary overwrite flow above: use R2-authoritative metadata-only pull/push, with no Git/GitHub dependency, automatic merging, or built-in diff. Track a downloaded ETag and baseline content digest locally. When both sides changed differently, pull preserves local contents in a unique sibling `.bak`, installs R2's TOML, and records that fetched revision after successful installation. The administrator compares and edits with external tools, then pushes conditionally against the new baseline. Never overwrite existing backups, replace local contents if backup fails, or upload backup files. Missing-baseline and remote-deletion handling remain technical draft details; publication concurrency is still separate from file-level stale-write protection. Original reviewer reports and counts are unchanged.
