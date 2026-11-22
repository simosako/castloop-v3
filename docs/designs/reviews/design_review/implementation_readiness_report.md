# Castloop MVP — Stage 9 Implementation Readiness, Round 1

* Target: [Detailed Implementation Plan](../../castloop-mvp.md#detailed-implementation-plan), lines 410–654.
* Status: Round 1 complete; all seven author-approved resolutions applied on 2026-11-08. The author concluded the review and finalized the design. No post-edit re-audit; the loop has not converged.
* Method: Three independent reviewers, each launched with `fork_turns: none`, with all approved local context and captured external references.

## Result

**0 Blockers, 5 Majors, 2 Nits after deduplication.** At review time, the five Major issues left important execution or interface choices unresolved under the Implementation Readiness Standard. All seven findings have since been addressed through author-approved edits; final readiness has not been re-audited. This does not overturn the prior high-level architecture assessment or treat planned runtime tests as failed tests.

## Consolidated findings

| ID | Severity | Issue | Proposed action |
| --- | --- | --- | --- |
| IR-1 | Major | Management, persisted and export contracts are still information groups rather than concrete schemas. | Specify action/payload/result unions, canonical fingerprints and versioned record/export shapes. |
| IR-2 | Major | Paginated pull can mix accepted revisions. | Bind page cursors to one revision; reject drift before installing a completed baseline. |
| IR-3 | Major | Accepted domain intent and completed redirect activation lack separate durable state. | Let an applied routing receipt authorize redirects only after successful feed application/purge and guarded SQL commit. |
| IR-4 | Major | TOML normalization can lose unknown integer/float types. | Configure type-preserving numeric parsing/serialization and test unknown nested values. |
| IR-5 | Major | Runner stopping depends on an undefined prediction of remaining invocation budget. | Proposed behavior choice: one captured affected batch per invocation, with concurrent newer intent left visibly pending for explicit recovery. |
| IR-6 | Nit | “Strict Temporal mode” conflates parser and serializer options. | Name the distinct options and their purposes. |
| IR-7 | Nit | Recover “from deletion” can sound like undeleting an entity. | Describe deletion/rebuild of derived public files and completion of current withdrawal intent. |

All seven dispositions were **PROPOSE FIX** and have been accepted/applied. IR-3 uses current/pending URLs with no audio copies; IR-4 replaces unknown-value preservation with strict Zod schemas and smol-toml. The table above records the original proposed actions; the resolution record is the final disposition. See the [annotated resolution record](readiness/goldfish_review_report.md) and [concrete specification proposal](readiness_specification_proposal.md).

The proposal makes two observable contract/behavior refinements explicit: an inventory GET surface for inspecting records/claims on the existing route, and the bounded-runner rule in IR-5. Both were explicitly approved by the author rather than treated as invisible implementation details. The additional Zod dependency and strict unknown-key/type rejection were also explicitly approved during IR-4 discussion. The rest concretizes existing requirements without adding a service, queue, Cron, stage journal or automatic retry.

## Reviewer completion and traceability

| Reviewer | Status | Raw finding → consolidated ID | Complete report |
| --- | --- | --- | --- |
| egm-implementation-readiness | completed | readiness-1-1 → IR-1; readiness-1-2 → IR-2; readiness-1-3 → IR-3; readiness-1-4 → IR-4 | [Execution readiness](readiness_execution_round1.md) |
| egm-codebase-details | completed | codebase-1-1 → IR-1; codebase-1-2 → IR-4 | [Codebase details](readiness_codebase_round1.md) |
| egm-style | completed | readiness-style-1-1 → IR-5; readiness-style-1-2 → IR-6; readiness-style-1-3 → IR-7 | [Style review](readiness_style_round1.md) |

Raw observations: seven Majors and two Nits. Two overlapping Major pairs were deduplicated; no severity was downgraded. All requested reviewers returned actual reports; no failed reviewer was counted as clean.

## Coverage and limits

All reviewers read the complete target for clarification, the active Detailed Implementation Plan, the three linked local documents and all fifteen supplied external captures. Codebase inspection found no implementation to reuse; all 68 planned file entries declare Create/Modify, all nine Modify paths exist and no planned Create path exists. The absence of proposed files was not treated as a defect.

This was document/source review only. There was no build, deployment, email or runtime experiment. SQL/alarm, direct copy, caches, numeric round trips, native binary compatibility, capacity and exact permissions still need the already planned implementation verification.

## Next boundary

The author completed item-by-item resolution, all seven fixes are applied, and the author selected the terminal checkpoint to conclude review and finalize the design on 2026-11-08. Round 1 contained Majors and is not retroactively clean after applying fixes. No post-edit re-audit, convergence or runtime readiness is claimed. Implementation remains a separate next step.
