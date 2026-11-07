# Maintainability Brainstorm Review

**Mode:** BRAINSTORM  
**Persona:** Maintainability Brainstormer, applying Structural Goldfish’s BRAINSTORM instructions  
**Dimension:** Long-Term Tech Debt & Maintainability

## Review inputs

Read in full:

- Persona: `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/agents/structural.md`
- Integration guidance: `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/docs/codex.md`
- Execution instructions: `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/resources/execution_instructions.md`
- Target: `/home/sim/project/castloop-v3/concepts_brief.md`
- Target: `/home/sim/project/castloop-v3/toml_spec.md`

**Standards:** No concrete target-standard document is referenced by the persona’s BRAINSTORM instructions. The generic “Target Standard” appears in its REVIEW instructions and does not establish a finished-draft template requirement here.

No implementation files, reviewer artifacts, conversation history, or memory were retrieved. Findings concern documented responsibilities and unresolved behavior; they do not assert independently verified Cloudflare API behavior.

## Findings

### 1. Major — Scheduled publication introduces a second writer without a settled publication contract

**Affected scope:** `concepts_brief.md`, “Proposed simple responsibility split,” lines 74–81; “Proposed publication sequence,” lines 89–98; “Scheduled publication,” lines 102–108.

**Tech debt description:** The CLI validates and builds complete feeds, while the proposed timed Worker applies prepared future feeds. An ordinary edit changes the inputs to those prepared feeds: a title correction, cancellation, replacement MP3, or another episode becoming publishable can invalidate multiple reservations. The brief correctly recognizes this risk at line 106, but has not yet selected how current publication state controls a prepared release.

The “one management operation at a time per show” preference also needs to cover the timed Worker. One administrator does not prevent the CLI and Cron from operating concurrently. Without a common rule, the scheduler becomes a second publishing implementation with its own assumptions, stale-write behavior, and cancellation handling.

**Maintainability requirement:** Establish one per-show publication contract used by both immediate and scheduled operations. A prepared release must be tied to the metadata and media revisions it was prepared from; stale work must not replace a newer feed or resurrect withdrawn content. Decide what happens when an edit invalidates scheduled work and how CLI/scheduler overlap is handled.

**Minimal recommendation:** Resolve this contract before selecting prepared whole-feed snapshots as the implementation. Share publication rules where practical and choose one small stale-work rejection mechanism. This does not require a workflow engine, global lock service, or operation journal.

### 2. Major — Withdrawal semantics remain too open to define a reusable publication operation

**Affected scope:** `concepts_brief.md`, lines 29–35, 50, 89–96, and 112–116; `toml_spec.md`, “Artwork and serving,” lines 94–100.

**Tech debt description:** The documents deliberately distinguish saved TOML, valid candidates, working delivery copies, and intentional unpublishing. That distinction is useful, but the unresolved behaviors determine the core publishing algorithm:

- A saved episode edit makes required metadata invalid.
- A replacement MP3 is invalid after inspection.
- Required show artwork becomes invalid.
- An existing show or episode receives `publish = false`.

These cases can affect feed entries, direct media URLs, the entire show feed, and pending reservations differently. If each command chooses its own behavior, replacement, metadata editing, deletion, and scheduled publication will accumulate inconsistent cleanup paths.

**Maintainability requirement:** Define a small shared set of publication outcomes and their effects on the feed, delivery objects, and pending releases. Preserve the existing requirement that an interrupted candidate upload alone does not invalidate the working public revision.

**Minimal recommendation:** Add a compact behavior table for these cases before designing command internals. Specify the intended public result and when it takes effect; detailed recovery machinery can remain deferred.

### 3. Major — Validated media needs a durable association with the exact source revision

**Affected scope:** `concepts_brief.md`, lines 50, 66, 75–77, 91–93, 106, and 124–143; `toml_spec.md`, “Generated values,” lines 68–70 and 173.

**Tech debt description:** RSS generation depends on inspected media properties, while normal checks must avoid downloading every MP3. A new computer also does not automatically retrieve media. The concept therefore depends on remotely retained knowledge of which exact object revision passed inspection and which size, duration, and MIME information belong to it.

The proposed mutable `audio.mp3` source key makes that association especially important. After replacement, “this episode has validated audio” cannot safely mean “whatever bytes currently occupy this key.” Scheduled promotion must copy the inspected revision rather than a subsequently changed candidate.

**Maintainability requirement:** Associate generated media facts and approval with a specific uploaded revision. Preserve that association across CLI sessions, new computers, replacement attempts, and scheduled release.

**Minimal recommendation:** Retain a small private, generated media descriptor or equivalent object metadata identifying the revision and its inspected properties. Require publishing and scheduling to check that association. Keep it generated; do not add hand-maintained enclosure fields to TOML or introduce a database solely for this purpose.

### 4. Major — Publication time needs a durable interpretation independent of later show settings

**Affected scope:** `toml_spec.md`, “Generated values,” line 72; “Publication time and show timezone,” lines 78–88; `concepts_brief.md`, lines 27–28 and 104–106.

**Tech debt description:** Publication time is entered as a local datetime interpreted through mutable show-level timezone configuration. The specification proposes preserving already published instants, but neither the persistence rule nor the behavior of future reservations is selected.

Re-resolving the same TOML after a timezone change can otherwise produce a different release instant and RSS date. Prepared scheduled work can retain the old instant while a later CLI operation uses the new one. That creates disagreement between the two publishing paths even when both follow their local inputs correctly.

**Maintainability requirement:** Select a timezone-edit policy and make the resolved publication instant stable according to that policy. Define how existing future reservations are retained or rescheduled.

**Minimal recommendation:** Decide whether timezone edits affect presentation only or explicitly reschedule unpublished episodes. Retain enough generated information to preserve the chosen interpretation, and update scheduled work through the same publication contract. This is a product behavior decision before it is a timezone-library choice.

### 5. Nit — Self-deployed CLI and Worker upgrades need a small compatibility boundary

**Affected scope:** `concepts_brief.md`, lines 9, 74–85, and 102–108; `toml_spec.md`, lines 5 and 175–177.

**Tech debt description:** The standalone CLI, deployed Worker, authoritative TOML, and any prepared release data can outlive one another. As the schema evolves, a newer CLI can otherwise create a reservation or field that the installed Worker interprets differently. This risk increases if scheduled operations depend on generated private records.

**Maintainability requirement:** Make incompatible stored formats or CLI/Worker combinations detectable rather than silently interpreted.

**Minimal recommendation:** During technical drafting, define a minimal format/version compatibility rule and an actionable mismatch error. A full migration framework or automated deployment system is unnecessary for the MVP.

## Architectural constraints worth retaining

The concept already limits several substantial maintenance costs: explicit object operations avoid ambiguous synchronization; stable episode identity separates identity from mutable URLs; the private/public bucket split separates candidates from delivery; and analytics and generated websites remain outside the MVP.

Retain those boundaries while resolving the publication contract. The principal maintenance risk is the interaction among CLI publication, scheduled publication, replacement, and withdrawal—not a lack of enterprise infrastructure.
