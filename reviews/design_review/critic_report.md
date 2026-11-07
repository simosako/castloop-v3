# Castloop MVP — Stage 7 Critic Review, Round 1

* Target: [Final design](../../docs/designs/castloop-mvp.md), feature range 1–404.
* Status: Round 1 findings resolved by the author. Two changes applied and one contest approved. The review loop has not converged; Stages 8–9 have not run.
* Changes: CR-1 and CR-3 applied after item-by-item author review. CR-2 left unchanged as contested. Original line references below refer to the pre-edit review target.
* Context: Three linked local documents and fifteen captured external sources. Each reviewer ran in a fresh conversation context.

## Findings and disposition

Four raw observations consolidate to **two Major findings and one Nit**. One Major is contested with evidence; the proposed changes address the other Major and the Nit. Reviewer severities are retained.

| ID | Severity | Finding | Author resolution |
| --- | --- | --- | --- |
| CR-1 (`design-1-1`) | Major | Invalid-show preservation can prevent an explicit stop or deletion. | Applied: withdrawal does not require publication-ready metadata; conditions-based wording, not a queue or priority change. |
| CR-2 (`structural-1-1`) | Major | Author-attributed rejections allegedly require issue/discussion/PR links. | Contested with author agreement: the restriction names a maintainer, not the author. |
| CR-3 (`structural-1-2`, `style-1-1`) | Nit | Alternatives introduction calls approved choices open. | Applied: section 13 describes remaining verification gates. |

Precise replacement text and contest evidence are in the [annotated resolution report](goldfish_review_report.md). No finding is silently downgraded, and a contested finding is distinct from an applied fix.

## Reviewer completion and traceability

| Reviewer | Status | Raw findings | Complete result |
| --- | --- | --- | --- |
| egm-design | completed | design-1-1 → CR-1 | [Design review](critic_design_round1.md) |
| egm-structural | completed | structural-1-1 → CR-2; structural-1-2 → CR-3 | [Structural review](critic_structural_round1.md) |
| egm-style | completed | style-1-1 → CR-3 | [Style review](critic_style_round1.md) |

All requested reviewers returned actual reports. No reviewer was omitted or treated as clean after failing. Coverage and limits are preserved in their reports. This is document review, not platform, performance or deployment verification.

## Next boundary

CR-1 and CR-3 are fixed at the document level; CR-2 is settled as contested with author agreement. No finding remains unaddressed. The original round was not clean because it contained an unsettled Major; applying fixes does not make it retrospectively clean. The loop is not declared converged. Fresh re-audit or progression under the parent workflow requires the author checkpoint. Runtime verification remains unperformed.
