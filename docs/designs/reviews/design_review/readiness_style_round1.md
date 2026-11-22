# Stage 9 — Style Review, Round 1

Reviewer: `readiness_style_round1`, fresh conversation context (`fork_turns: none`).
Persona: `egm-style`. Mode: REVIEW. No additional style standard supplied.
Active scope: [Detailed Implementation Plan](../../castloop-mvp.md#detailed-implementation-plan), lines 410–654.

## Complete reviewer result

### readiness-style-1-1 — Major

**Active lines:** 523 and 649.

“Once the invocation budget cannot safely do another complete affected attempt” is an implementation decision without a defined decision rule. Neither the active section nor the earlier architecture specifies the selected budget, the measured quantity, or how the runner determines whether another attempt fits. The measurement step in line 649 does not explicitly turn its results into the runner’s stopping criterion. Different implementations could stop at materially different points or begin work they cannot finish.

**Proposed edit:** Require the archive measurements to produce a documented execution limit and stopping rule, distinguishing CPU from elapsed time and identifying any configured runtime limit. Specify when the runner checks that rule, what constitutes a complete affected attempt, and that work deferred by the rule remains pending for explicit recovery. Retain the failure gate that requires architectural review when a full feed rebuild cannot fit.

### readiness-style-1-2 — Nit

**Active lines:** 422 and 433.

“Strict Temporal datetime mode” merges two distinct library options. Capture 07 documents `useLegacyDate: false` as the parser option selecting Temporal, whereas `strictTemporal` is a serializer option rejecting unsupported IANA-zone/calendar information. The intended behavior is discernible from the context, but the current terminology can direct an implementer toward the wrong option.

**Proposed edit:** Name the options and their purposes explicitly: parse with `useLegacyDate: false`; configure serialization separately, including `strictTemporal: true` where appropriate. Keep the invalid-date, offset-preservation and unknown-field round-trip gates.

### readiness-style-1-3 — Nit

**Active line:** 479.

“Reapply latest accepted intended delivery from deletion” can read as recovery of a deleted entity. Earlier architecture clarifies that deletion is the starting phase of rebuilding public delivery, and that recovery follows current withdrawal intent without undeleting metadata. That distinction should be visible in the command contract.

**Proposed edit:** Replace the opening with: “Read latest accepted intent and restart affected public delivery by deleting the affected public files, then rebuilding eligible delivery and the full feed. If current intent is withdrawal, complete withdrawal.” Preserve the existing unresolved-target scope and distinction from ordinary publishing.

No Blocker findings. None of these findings concerns a defensive caveat; DROP/CALIBRATE/RELOCATE classification is therefore inapplicable. Concrete compatibility, SQL/alarm, delivery/cache, native-binary and controlled-recipient verification gates should remain.

**Read coverage:** Read the persona first; the complete active scope, lines 410–654; earlier target lines 1–409 for clarification; all three local context documents; and captures 01–15 listed in `context.txt`. Reread truncated gaps. No old review files, parent transcript or memory accessed.

**Limitations:** This is a read-only document audit against the supplied captures. No files changed, builds run, deployments performed or runtime behavior verified.
