# Design Critic — BRAINSTORM

## Materials read

Read in full:

- Persona: `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/agents/design_critic.md`
- Integration instructions: `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/docs/codex.md`
- Execution instructions: `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/resources/execution_instructions.md`
- Target: `/home/sim/project/castloop-v3/concepts_brief.md`, lines 1–210
- Target: `/home/sim/project/castloop-v3/toml_spec.md`, lines 1–177

The persona references no concrete additional standard. Its generic “Target Standard” instruction belongs to REVIEW mode; no finished-design completeness standard was imposed on this brainstorm.

External documentation sections consulted through Context7 and official Cloudflare pages:

- Workers Cache: overview, configuration example, pricing
- Workers Cache purge: ownership, entrypoint scope, propagation, return values
- Legacy Cache API: deletion behavior
- Workers limits: free-plan limits, subrequests, daily requests
- R2 pricing: free allowance, storage prices, operation classes
- Workers pricing and legacy cache overview were also opened.

No conversation history or memory was retrieved. Fresh-context execution does not establish exclusion of host instruction files.

## Findings

### 1. Major — Scheduled publication introduces a second writer, despite the one-administrator model

**Dimension:** Architecture, Quota & Resource Economics  
**Affected scope:** `concepts_brief.md:87–108`, particularly lines 98 and 106.

**Mechanism:** The document correctly identifies stale prepared feeds as a risk, but the single-operation-per-show proposal does not yet include the timed publisher. A CLI edit and Cron execution can overlap even when there is only one administrator.

For example, Cron reads a prepared feed containing episode A; the administrator deletes A and publishes a new feed; Cron then writes its older prepared feed. The deletion can be undone publicly. A similar race can copy cancelled audio into delivery storage without advertising it in RSS, violating the requirement to keep unpublished scheduled media private.

This is a documented unresolved design choice, not evidence that Cron or R2 cannot support the feature.

**Minimal recommendation:** Before selecting the prepared-feed hypothesis, define one publication ordering rule shared by CLI operations and the scheduler. State how edits invalidate reservations, how a timed operation detects that its input revision changed, and what it does when it loses a race. Include deletion and cancellation in that rule. A generation identifier and conditional operations may form part of the answer, but a preflight revision check alone must not be described as cross-object atomicity. No workflow platform is required by this finding.

### 2. Major — Remote media facts need a durable association with the inspected revision

**Dimension:** Architecture, Quota & Resource Economics  
**Affected scope:** `concepts_brief.md:24–25, 74–77, 89–93, 106, 123–136`; `toml_spec.md:68, 173`.

**Mechanism:** Feed generation requires duration, size and MIME information obtained through CLI inspection, while a new computer and normal checks must avoid downloading all remote MP3 bodies. The documents do not identify where inspection results persist or how they remain associated with the exact uploaded object.

The proposed fixed management key, `audio.mp3`, makes this particularly relevant to reservations: replacing that key after scheduling can leave a valid-looking prepared feed or validation result referring to different bytes. Merely confirming that an object exists does not demonstrate that it is the revision previously inspected.

**Minimal recommendation:** Record derived media facts in private management storage or object metadata, associated with an explicit source revision or verified object identity. Make replacement invalidate or regenerate dependent publication preparation. State how a new CLI installation recovers those facts without downloading the full archive. These are generated implementation records; administrators should not maintain them in TOML.

This recommendation is an architectural inference from the stated responsibilities, not a claim about an unverified R2 API guarantee.

### 3. Major — Invalid replacement and unpublish behavior determine the publication architecture

**Dimension:** Architecture, Quota & Resource Economics  
**Affected scope:** `concepts_brief.md:29–35, 50, 90–96, 112–116`; `toml_spec.md:96`.

**Mechanism:** Several explicitly open policies affect whether the product must retain a last successful public revision, withdraw individual assets, or withdraw the entire show:

- A completed replacement MP3 fails validation.
- Saved episode metadata becomes incomplete.
- Show artwork or required show metadata becomes invalid.
- An existing show or episode changes to `publish = false`.

The brief already distinguishes interrupted uploads from proven invalid MP3s, which is useful. The remaining gap is the precise event that turns a private candidate into grounds for withdrawing currently working public content. Without that decision, publication and scheduled-release reconciliation cannot share a clear rule.

**Minimal recommendation:** Agree on a small behavior table covering these cases: whether saving succeeds, what remains public, what is withdrawn, and whether existing media URLs continue working. Preserve the accepted rule that a proven unpublishable MP3 is withdrawn; clarify which revision is being judged and when. This is a product decision needed for the anchored hypothesis, rather than a demand for a finished failure-recovery design.

### 4. Major — Cache selection and purge ownership must be explicit

**Dimension:** Architecture, Quota & Resource Economics  
**Affected scope:** `concepts_brief.md:35, 50–56, 81, 94, 104`.

**Mechanism:** Replacement, deletion and the scheduled-release tolerance depend on public cache behavior. “Workers Cache” does not by itself identify the invalidation mechanism or which Worker owns it.

Current Cloudflare documentation distinguishes two relevant mechanisms:

- Legacy Cache API `cache.delete()` removes entries only in the data center executing that call. [Legacy Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- Current Workers Cache supports globally propagated `ctx.cache.purge()`, but purge scope belongs to the owning Worker and calling entrypoint. A separate management Worker cannot directly purge another Worker’s cache. Zone purges do not affect this cache. [Workers Cache purge](https://developers.cloudflare.com/workers/cache/purge/)

Current Workers Cache explicitly supports `workers.dev`, so a blanket assertion that global invalidation requires a custom domain would be incorrect. [Workers Cache overview](https://developers.cloudflare.com/workers/cache/)

**Minimal recommendation:** Name the chosen cache mechanism and its owner. If using current Workers Cache, provide an authenticated control path that causes the owning delivery entrypoint to purge its cache. Specify the separate custom-domain CDN purge path, error reporting, and cache lifetimes relevant to the release tolerance. Confirm that media checks account for previously cached absence before publishing RSS. This can remain a small management responsibility.

### 5. Major — The minute scheduler needs an economical discovery hypothesis

**Dimension:** Cost, Quota & Resource Economics  
**Affected scope:** `concepts_brief.md:11, 83, 100–108`.

**Mechanism:** One Cron Trigger avoids a trigger per show, but “find due publication work” leaves the dominant recurring cost unspecified. Scanning every show and episode each minute would make scheduler work grow with the entire archive, even when no episode is due.

At 43,200 runs in a 30-day month, reading 100 metadata objects each run would produce approximately 4.32 million reads before listing, copying and feed work. This is an illustrative calculation, not a forecast or an assertion that the design already performs those reads. R2 listing is a Class A operation; the current free allowance is one million Class A and ten million Class B operations monthly. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

Worker CPU and subrequest limits also require a bounded per-invocation workload; the brief already correctly declines to claim a free-tier fit without measurement. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

**Minimal recommendation:** Choose a small private schedule manifest or similarly simple due-work representation maintained by the CLI, so ordinary polling need not inspect the complete archive. State how it is regenerated after reservation changes and what happens when several releases are due together. Estimate operations per idle tick and per release before treating the hypothesis as economical. A database is not required.

### 6. Nit — Timezone preservation needs a durable resolved instant if that policy is selected

**Dimension:** Architecture & Resource Economics  
**Affected scope:** `toml_spec.md:72, 78–88`; `concepts_brief.md:27, 104, 194`.

**Mechanism:** The proposed policy preserves published instants after a show timezone change, but the example stores only a local datetime in episode TOML. Reinterpreting that unchanged value using the new timezone changes the instant. Scheduled publication also needs a clear answer about whether pending episodes move.

The documents explicitly mark this policy as unaccepted, so this is a decision to settle rather than an internal contradiction.

**Minimal recommendation:** Select the timezone-edit policy before drafting reservation behavior. If published instants are preserved, identify where the resolved instant survives independently of the current show timezone, while keeping administrator-entered metadata authoritative. Define whether pending reservations retain their instant or require explicit rescheduling.

### 7. Nit — Add one retention-based storage illustration

**Dimension:** Cost & Storage Economics  
**Affected scope:** `concepts_brief.md:11, 48, 143`.

**Mechanism:** Duplicate storage is acknowledged, but its relationship to the stated release cadence remains implicit. At 30–50 MB per episode, 52–104 annual releases and two retained copies produce roughly 3.12–10.4 GB of audio per year for one show, before artwork and temporary revisions. These are calculations from the brief’s assumptions, not expected audience or show-count requirements.

R2 currently includes 10 GB-month of Standard storage and charges $0.015 per GB-month beyond included usage. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

**Minimal recommendation:** Include that illustration and decide when abandoned upload candidates and superseded temporary copies are removed. Retaining the actual podcast archive can remain the default; no storage optimization service or archival tier is justified by this finding.
