# Stage 7 — Structural Review, Round 1

Reviewer: `critic_structural_round1`, fresh conversation context (`fork_turns: none`).
Persona: `egm-structural`. Mode: REVIEW. Standard: `feature-spec-standard`. Active target: lines 1–404.

## Complete reviewer result

**structural-1-1 — Major — Alternatives Considered, lines 337, 343, 349, 355, 361, 367, 373, 379, 385, 391, 397 and 403**

Every alternative attributes its rejection to the author without linking an issue, discussion or PR documenting that decision. The supplied standard explicitly prohibits attributing rejection to a maintainer without such a link. The general predecessor link at line 6 and unlinked provenance statement at line 331 do not satisfy that requirement. Concrete technical and scope trade-offs already appear in the adjacent Cost paragraphs, so the alternatives themselves are substantively evaluated.

Proposed correction: remove “by author” and similar personal attribution from these Decision bullets, retaining the documented technical decisions and trade-offs. Alternatively, provide the required decision-record links if available; do not invent them.

**structural-1-2 — Nit — Alternatives Considered introduction, line 331**

The introduction refers to “the open choices in Technical Plan section 13.” That section is now “Approval and remaining verification” and explicitly states at line 306 that no product or architecture choice remains for implicit selection. This stale cross-reference makes the section's relationship to the approved plan unclear.

Proposed correction: replace the final clause with wording such as “The runtime and capacity checks in Technical Plan section 13 remain verification gates rather than rejected alternatives.”

Structure and standard coverage:

- H1: Castloop MVP.
- H2 sections: Overview; The Problem; Goals; Non-Goals; Critical User Journeys; Technical Plan (Architecture); Alternatives Considered.
- H3 sections: four user journeys; fourteen numbered architecture sections; twelve numbered alternatives.
- All 38 headings nest sequentially without skipped levels.
- Required subjects are covered: problem at lines 16–22; goals/non-goals at 24–45; architecture and integrations at 73–327; evaluated alternatives at 329–403.
- Risks and mitigations are distributed through the architecture: authentication and permissions at 102–104; interruption outcomes at 172–180; publication concurrency/failure at 214–242; cache/migration limits at 254–264; cleanup safeguards at 284–290; restore/compatibility at 296–302; capacity/runtime limits at 304–313. The standard does not require a separately titled Risks section.
- Six tables have consistent column counts and valid separator rows. Three fenced blocks close correctly. Lists use consistent Markdown syntax.
- Eight Markdown links have nonempty labels and structurally valid destinations. Both relative file destinations exist. The six external destinations correspond to supplied captures; their cited API topics and fragments are represented there.
- The next H2, Detailed Implementation Plan, begins at line 405, confirming the scope boundary.

Read/coverage evidence: read the structural persona and feature standard, all 404 active target lines, all three supplied local context documents (`concepts_brief.md`, `toml_spec.md`, `implementation_decisions.md`), and all fifteen page captures supplied at review time. Those captures have since been removed; their URLs remain in the review README. Long documents were read in bounded portions; repeated navigation prefixes were additionally inspected with duplicate lines consolidated. Scanned only the implementation-plan headings outside scope to confirm section references.

Limitations/skipped checks: no live HTTP availability checks or rendered Markdown/Mermaid execution; external-link checks used the supplied readable captures, which have since been removed. No prior review reports, conversation history or memories were inspected. No implementation/runtime checks were performed. No files were written or modified during the review.
