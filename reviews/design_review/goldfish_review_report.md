# Goldfish Annotated Review Report

**Target:** [Castloop MVP](../../docs/designs/castloop-mvp.md), feature range 1–404, Stage 7 round 1.

**Status:** resolved. CR-1 and CR-3 were accepted and applied after item-by-item review; CR-2 was contested with author agreement and left unchanged. Original reviewer severities and raw reports remain unchanged. Line references in the findings below describe the reviewed pre-edit version.

## Prioritized Findings & AI Suggestions

### CR-1 [egm-design] — Severity: Major

* **Finding ID:** `design-1-1`.
* **Affected Scope:** [One publication executor](../../docs/designs/castloop-mvp.md#7-one-publication-executor), lines 218–219; desired behavior at 64–65. Related consistency updates proposed at lines 556 and 641.
* **Discrepancy Description:** The executor validates current show metadata and preserves old delivery before it evaluates a confirmed stop or deletion. Therefore an invalid show may remain public despite an explicit withdrawal.
* **Rationale:** An invalid title/description/cover is a reason to reject publication, not a reason to ignore authenticated, confirmed withdrawal. The current numbered sequence leaves the two policies in conflict.
* **AI Suggestion:** PROPOSE FIX.
* **Justification:** The document already distinguishes acceptance validation from publication readiness (line 204), and explicitly promises confirmed withdrawal (CUJ 3). Defining withdrawal eligibility independently of publication readiness addresses the conflict without adding infrastructure or changing typo protection for an active show. The author explicitly replaced the initial ordering-based proposal with this conditions-based wording.
* **Applied Edit:** Replaced the conflicting numbered steps with explicit policy cases:

> Publication readiness is not a prerequisite for show stop or deletion. The executor applies these policies according to latest accepted intent:
>
> * A confirmed show stop or deletion withdraws its feed and public assets, purges affected cache prefixes and disables reservations while the show remains stopped. Missing or invalid publication fields such as title, description or cover must not prevent withdrawal. Authorization, target identity, revision checks and administrator confirmation remain required; source updates still require acceptance checks for syntax and supported protocol/schema.
> * For a show whose accepted intent remains active, invalid show metadata preserves the last working feed and its required media/artwork, reports errors and blocks new releases. New publication still requires valid publication metadata.

The numbered publication flow now applies to a valid active show. This is not a new queue, scheduling priority or instruction to publish invalid metadata.

* **Related applied consistency edit:** Detailed Implementation Plan section 7 now states that confirmed show stop/deletion does not require publication-ready metadata, retains management acceptance checks and limits invalid-show delivery preservation to active intent.
* **Related applied verification edit:** Added planned cases for stop/delete with invalid show metadata and a confirmed stop update that also makes publication metadata incomplete.

The author approved this revised expression, rather than the original “process withdrawal first” formulation. No runtime test or fresh re-audit is claimed to have passed.

### CR-2 [egm-structural] — Severity: Major

* **Finding ID:** `structural-1-1`.
* **Affected Scope:** [Alternatives Considered](../../docs/designs/castloop-mvp.md#alternatives-considered), Decision bullets at lines 337–403.
* **Discrepancy Description:** The reviewer says every “Rejected by author” statement needs an issue/discussion/PR link under the standard's prohibition on unsupported maintainer attribution.
* **Rationale:** The reviewer considers author attribution equivalent to maintainer attribution.
* **AI Suggestion:** CONTEST.
* **Justification:** The actual [feature specification standard](/home/sim/.codex/plugins/cache/egm/egm/0.1.0/resources/document_standards/feature-spec-standard.md), which this reviewer read, says: “must not attribute a rejection to a maintainer without linking their issue, discussion, or PR.” It does not ban documenting an author's design choice. The target explicitly identifies its author (line 3), links the predecessor (line 6), explains decision provenance (line 331), and includes concrete benefits/costs and chosen directions. Its bullets attribute choices to the author, without asserting an upstream maintainer rejected the alternatives. The reviewer conflates two distinct attributions. Removing accurate author decision provenance is not required by this standard.
* **Proposed Edit:** None. Preserve the Major severity in the raw record; the author agreed to settle it as contested. Do not fabricate upstream issue links.

### CR-3 [egm-structural, egm-style] — Severity: Nit

* **Finding IDs:** `structural-1-2`, `style-1-1` (duplicate issue).
* **Affected Scope:** Alternatives Considered introduction, line 331.
* **Discrepancy Description:** It refers to “open choices in Technical Plan section 13,” while section 13 declares choices approved and lists remaining verification.
* **Rationale:** This stale phrase gives conflicting decision-status information.
* **AI Suggestion:** PROPOSE FIX.
* **Justification:** A short replacement corrects the status without reopening approved choices. Editorial action: CALIBRATE.
* **Applied Edit:** Replaced the full introduction paragraph with:

> These alternatives summarize the predecessor's recorded decisions and the approved Technical Plan review. Section 13 lists remaining implementation and runtime verification gates.

## Resolution result

* Accepted and applied: CR-1 (author-revised wording), CR-3.
* Contested with author agreement, no edit: CR-2.
* Escalated: 0. Declined: 0. Unaddressed findings: 0.
* Runtime verification: not performed. Fresh re-audit: not performed. The review loop is not declared converged.

All user decisions were collected before the single batch of design edits. The next review action requires the author checkpoint under the parent workflow.
