# Stage 9 — Implementation Readiness, Round 1

Reviewer: `readiness_execution_round1`, fresh conversation context (`fork_turns: none`).
Persona: `egm-implementation-readiness`. Mode: REVIEW. Standard: `implementation-readiness-standard`.
Active scope: [Detailed Implementation Plan](../../castloop-mvp.md#detailed-implementation-plan), lines 410–654.

## Complete reviewer result

Four Major findings; no Blockers or Nits.

### readiness-1-1 — Major — Versioned management contracts still require interface design

Affected scope: lines 491–501, 505–515 and 541–549.

The plan names routes and required information but does not define the promised concrete protocol/schema shapes. For example, `/operations` says action enums distinguish creation/update without specifying their values or payload variants. It does not define how a batch represents episode creation, its GUID, metadata/audio reference reuse, or a field being absent versus explicitly cleared. Cleanup and restore routes likewise lack request/response structures. Export describes included information, but not the versioned envelope and nested snapshot representation that restore must validate.

An engineer must independently design these persisted and externally exchanged interfaces before implementing `contracts.ts`, the CLI client and server handlers. Two implementations can satisfy the prose and still be incompatible.

Define the protocol-v1 discriminated mutation union, common request/reference/result/error types, cleanup and restore payloads, and export-v1 envelope/snapshot types. Specify required, optional and nullable fields and unsupported-value handling. Add representative serialized fixtures and round-trip/invalid-payload assertions. Physical SQL column choices and ordinary helper signatures can remain implementation details.

### readiness-1-2 — Major — Paginated metadata snapshots lack a consistency mechanism

Affected scope: lines 472–473, 495 and 597.

Pull requires an internally consistent metadata/revision/reference snapshot and bounded paginated calls, but the plan does not say how that consistency survives multiple requests.

For example, pull reads the first page at revision 12, another command updates or deletes episodes at revision 13, and pull reads the next page. The engineer must decide whether the cursor preserves revision 12, detects revision drift, or permits mixed revisions. Mixed results cannot safely establish the baseline used by the subsequent atomic show push.

Specify the page envelope, revision/cursor relationship and revision-change behavior. A revision-bound cursor that rejects subsequent pages after a revision change, followed by a documented pull restart, would fit the existing architecture without adding a snapshot service. Define an integration assertion that changes accepted state between pages and verifies that no mixed inventory becomes the completed local baseline.

### readiness-1-3 — Major — Migration redirect activation is not durably distinguished from accepted URL intent

Affected scope: lines 510, 513–514 and 557–559.

The sequence requires accepting the new URL intent, applying/checking/purging the new feed, and only then activating old workers.dev redirects. Delivery resolves the destination from the DO. However, the specified state contains current/previous bases and migration time without defining the durable condition that tells delivery whether the accepted destination has completed cutover.

If execution stops after URL acceptance but before the feed purge succeeds, reading the accepted current base can redirect prematurely. Always retaining the old route until another migration command runs can instead strand a successfully completed cutover. This is a missing durable decision rule, beyond the accepted temporary inconsistency during external operations.

Define which applied outcome or explicit cutover field authorizes redirect activation, its relationship to the URL-setting revision, and what recovery does after interruption or superseding URL changes. Reuse the existing outcome model rather than introducing a processing-stage journal. Test interruption before feed write, after write but before purge, and after successful purge but before the response, including a newer rollback acceptance.

### readiness-1-4 — Major — Unknown TOML field preservation does not account for documented numeric type loss

Affected scope: lines 422, 433, 439 and 581.

The plan requires preserving unknown fields when inserting an initial timezone forces TOML reserialization. The supplied smol-toml README explicitly documents that its default numeric behavior loses integer-versus-float type information: `1.0` serializes as `1`, and integers beyond JavaScript’s safe precision require BigInt configuration. The plan selects Temporal handling but leaves this known preservation issue unresolved.

An episode containing an unknown extension field such as `extension_ratio = 1.0` can therefore change type during timezone normalization. A valid unknown 64-bit integer also needs a deliberate parsing policy. These are observable changes to retained user input.

Specify a type-preserving numeric adapter policy, such as the documented BigInt parse/float stringify combination with explicit conversion for known integer fields, or equivalent token preservation. Require normalization tests covering unknown integral floats, large integers and nested values, while preserving raw bytes when normalization is unnecessary.

## Reading coverage and limitations

Read the readiness persona and standard; the complete target, including earlier architecture for clarification; all three linked local documents; and all fifteen external captures listed in `reviews/design_review/context.txt`. Substantive gaps from truncated combined output were reread in bounded chunks. Findings are anchored within lines 410–654.

Document/source review only. No workspace modifications, builds, deployment or runtime verification occurred. Unperformed runtime gates, unmeasured free capacity, manual failure recovery and accepted temporary delivery inconsistency were not treated as deficiencies.
