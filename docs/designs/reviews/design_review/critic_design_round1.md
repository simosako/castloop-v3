# Stage 7 — Design Review, Round 1

Reviewer: `critic_design_round1`, fresh conversation context (`fork_turns: none`).
Persona: `egm-design`. Mode: REVIEW. Standard: `feature-spec-standard`. Active target: lines 1–404.

## Complete reviewer result

One finding.

**design-1-1 — Major: Validation precedes explicit show withdrawal**

Affected scope: `docs/designs/castloop-mvp.md`, lines **218–219**, with the required behavior stated at lines **64–65**.

The executor first validates the show and preserves existing delivery when its metadata is invalid. Only afterward does it process a confirmed stop or deletion. This ordering makes explicit withdrawal conditional on publication readiness.

Concrete scenario: An established show receives parseable but incomplete metadata, so its existing feed correctly remains public. The administrator then confirms `publish = false` or deletes the show. Executing the listed steps encounters invalid metadata first and preserves the feed instead of applying the confirmed withdrawal. Similarly, a single confirmed stop update that also removes a required field takes the preservation branch.

The clarification-only implementation section does not resolve the precedence: line 556 reiterates both withdrawal and invalid-show preservation without saying which wins when both conditions hold.

Recommendation: Evaluate accepted deletion and confirmed show-stop intent before publication-readiness validation. Such operations need valid identity, authorization and confirmation, but should not require a publication-ready title, cover or description. Apply invalid-show preservation only when the latest accepted intent remains active. This keeps the typo-protection policy while ensuring an intentional stop can withdraw an invalid show.

**Coverage and limitations**

Read the design critic persona and feature specification standard; the complete target, with findings restricted to FeatureRange **1–404**; all three local context files; and all fifteen external captures listed in `context.txt`. Reads used bounded chunks, with truncated portions reread. No previous review reports were accessed and no files were changed.

Reviewed architecture, source acceptance, scheduling, failure outcomes, security boundaries, retention/cleanup, delivery/cache behavior, migration, recovery, economics and alternatives. Accepted temporary inconsistency, manual recovery, absence of automatic application retries and runtime verification gates were treated as constraints. No additional findings.

This is document review only. Platform compatibility, runtime behavior, capacity, permissions and cost measurements remain unverified.
