# Goldfish Annotated Review Report — Stage 9

**Target:** [Castloop MVP](../../../castloop-mvp.md), Detailed Implementation Plan lines 410–654, round 1.

**Status: resolved.** All seven fixes were accepted individually and applied on 2026-11-08. IR-3 and IR-4 use author-revised solutions. All reviewer severities and complete results are preserved in the [consolidated report](../implementation_readiness_report.md).

The exact proposed contract/behavior additions are in [Specification Refinements](../readiness_specification_proposal.md). The accepted text is integrated into Detailed Implementation Plan sections 10–15 and the existing planned source/test responsibilities. No production code was created.

## Prioritized Findings & AI Suggestions

### IR-1 [egm-implementation-readiness, egm-codebase-details] — Severity: Major

* **Raw IDs:** `readiness-1-1`, `codebase-1-1`.
* **Affected Scope:** API at lines 491–501, persisted records at 505–519, export/restore at 541–549, planned contract/storage files.
* **Discrepancy Description:** Routes and information groups exist, but operation discriminators, payload/result shapes, canonical fingerprint rules, typed persisted data and export envelope remain undefined.
* **Rationale:** Independently implemented CLI, DO and restore code could all follow the prose yet be incompatible.
* **AI Suggestion:** PROPOSE FIX.
* **Justification:** This is an actual cross-component design gap. Physical SQL statement layout need not be prescribed, but logical types, nullability, identities, constraints and stable serialization must be fixed. The two reviewer findings overlap and are resolved together without reducing their severity.
* **Proposed Edit:** Add IR-1's shared scalar/reference/error rules, six-action discriminated operation union, canonical JSON/SHA-256 definition, results and maintenance payloads, seven logical record schemas and `ExportV1`/`ShowSnapshotV1` to the Detailed Implementation Plan. Keep known metadata facts separate from arbitrary parsed TOML values. Add generated contract/round-trip/error fixtures to the already listed tests.
* **Observable additions for approval:** Explicit GET on the existing inventory route for record/claim inspection; restore/resume revision and duplicate-receipt behavior; one-show staged restore envelopes under the existing 16 MiB bound. No new service or source-file family.

### IR-2 [egm-implementation-readiness] — Severity: Major

* **Raw ID:** `readiness-1-2`.
* **Affected Scope:** pull/push at lines 472–473, snapshot API at 495 and paginated client at 597.
* **Discrepancy Description:** Multiple pages are not bound to one accepted revision, so a concurrent edit can produce a mixed snapshot and incorrect completed baseline.
* **Rationale:** The CLI needs a consistent inventory before replacing local files and recording its stale-update baseline.
* **AI Suggestion:** PROPOSE FIX.
* **Justification:** A revision-bound cursor fits the existing per-show SQL authority and immutable refs; it avoids an additional snapshot service.
* **Proposed Edit:** Add IR-2's page envelope, 100-entry ordering, versioned route/show/revision/key cursor and `snapshot_revision_changed` response. Stage the complete pull locally; on revision drift leave current files/baseline unchanged, discard staging and instruct a manual rerun. Add inter-page concurrent-edit and failed-backup assertions.

### IR-3 [egm-implementation-readiness] — Severity: Major

* **Raw ID:** `readiness-1-3`.
* **Affected Scope:** show/outcome/delivery records at 510–514 and migration at 557–559.
* **Discrepancy Description:** Current/previous accepted bases do not define when the old route is permitted to redirect after the new feed has passed write/verification/purge.
* **Rationale:** A crash can otherwise activate the destination prematurely or leave the completed cutover unrecognized. This needs a durable authority rule, not stricter external atomicity.
* **AI Suggestion:** PROPOSE FIX.
* **Justification:** Reuse accepted/applied state and guarded completion in existing SQL. This is not stage-resume tracking.
* **Proposed Edit:** Add IR-3's desired/applied delivery records. Delivery reads the applied record; only a successful feed/purge attempt guarded against the latest desired migration identity commits a new applied route. A later ordinary feed failure does not revoke it. Recovery starts again from latest intent; superseding rollback cannot be completed by an old runner. Add the stated interruption/supersession cases.

### IR-4 [egm-implementation-readiness, egm-codebase-details] — Severity: Major

* **Raw IDs:** `readiness-1-4`, `codebase-1-2`.
* **Affected Scope:** TOML dependency and normalization at 422, 430–439 and planned TOML/validation files.
* **Discrepancy Description:** Default parser/serializer settings cannot preserve all unknown integer values or integer-versus-float types when timezone insertion causes normalization.
* **Rationale:** Unknown `1.0` can become integer `1`, and valid 64-bit integers require deliberate BigInt handling. Raw-byte preservation does not cover required normalization.
* **AI Suggestion:** PROPOSE FIX.
* **Justification:** The smol-toml README supplied during review documented `integersAsBigInt` and `numbersAsFloat`. The existing parser can satisfy this without adding a new dependency. See the [upstream README](https://github.com/squirrelchat/smol-toml/blob/mistress/README.md); its current contents may differ from the reviewed version.
* **Proposed Edit:** Apply the shared IR-4/IR-6 option policy: BigInt source integers plus float-aware serialization, separate safe numeric extraction for known fields, untouched unknown nested values, raw preservation when possible, backups before normalization and fixtures for the enumerated numeric cases. If a round-trip compatibility case fails, stop normalization and preserve the original; do not upload a silently changed value.

### IR-5 [egm-style] — Severity: Major

* **Raw ID:** `readiness-style-1-1`.
* **Affected Scope:** runner rule at line 523 and measurement step at 649.
* **Discrepancy Description:** “Cannot safely do another complete affected attempt” has no defined budget, measured variable or stopping rule.
* **Rationale:** CPU and elapsed time differ; an implementer cannot reliably infer this rule from future capacity measurements alone.
* **AI Suggestion:** PROPOSE FIX.
* **Justification:** Defining a predictive scheduler would add complexity. A fixed one-batch invocation boundary makes the behavior explicit while retaining manual recovery and existing runtime measurement gates. This is a proposed behavior choice, not an automatic consequence of the finding.
* **Proposed Edit:** Replace the predictive budget sentence with IR-5's one captured affected-show batch per runner invocation. Do not drain concurrent newer revisions in an unbounded loop; report uncovered newer intent pending for explicit recovery. Document that this can defer a concurrent edit despite remaining runtime. Keep guarded completion, one-runner ownership and the stop-for-review gate if one complete supported workload does not fit measured configured DO limits. Add concurrent-edit/pending/recovery assertions.

### IR-6 [egm-style] — Severity: Nit

* **Raw ID:** `readiness-style-1-2`.
* **Affected Scope:** lines 422 and 433.
* **Discrepancy Description:** “Strict Temporal datetime mode” conflates selecting Temporal during parsing with rejecting unsupported zone/calendar information during serialization.
* **Rationale:** The two separately documented options have different purposes.
* **AI Suggestion:** PROPOSE FIX.
* **Justification:** Naming the actual options prevents implementing the wrong parser configuration; it overlaps the adapter specification in IR-4 without changing its Major severity.
* **Proposed Edit:** Name `useLegacyDate: false` for parsing and `strictTemporal: true` for serialization, with the numeric options described in the shared proposal. Retain existing invalid-calendar/offset/round-trip gates.

### IR-7 [egm-style] — Severity: Nit

* **Raw ID:** `readiness-style-1-3`.
* **Affected Scope:** recover command at line 479.
* **Discrepancy Description:** “From deletion” can be read as recovery of a deleted entity rather than rebuilding derived public files from the beginning.
* **Rationale:** The command contract should make the already approved latest-intent behavior visible without requiring readers to resolve the phrase elsewhere.
* **AI Suggestion:** PROPOSE FIX.
* **Justification:** This is a local wording correction, not an undelete feature or a processing-stage mechanism.
* **Proposed Edit:** Use the exact recover wording in IR-7 of the proposal, including completion of current withdrawal intent and no undelete.

## Applied author resolutions

The Proposed Edit bullets above retain the original recommendations for traceability. Final author decisions supersede them where stated:

| Finding | Final disposition |
| --- | --- |
| IR-1 | Accepted/applied: protocol, logical persistence and export contracts; inventory GET. |
| IR-2 | Accepted/applied: revision-bound pages; on drift return error and ask for a new pull without changing local data. |
| IR-3 | Accepted/applied with revision: current URL plus nullable pending URL, guarded cutover after all preparation; reuse existing MP3s without migration copies. |
| IR-4 | Accepted/applied with replacement: smol-toml plus strict Zod field/type schemas; reject unknown keys and wrong types before uploads. No arbitrary unknown-value/BigInt preservation mechanism. |
| IR-5 | Accepted/applied: one captured batch per invocation, uncovered concurrent intent pending for manual recovery. |
| IR-6 | Accepted/applied: separately named parse/serialization Temporal options. |
| IR-7 | Accepted/applied: delete/rebuild derived files from latest intent; no entity undelete. |

Counts: accepted fixes 7; contested 0; escalated 0; declined 0; remaining unaddressed 0. Original severities remain five Majors and two Nits. Markdown/link checks were performed; runtime checks and post-edit re-audit were not. The author completed the final parent checkpoint on 2026-11-08, choosing to conclude review and finalize the design without another audit round. No clean-round or convergence claim is made.
