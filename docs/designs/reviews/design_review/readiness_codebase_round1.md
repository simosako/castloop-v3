# Stage 9 — Codebase Details, Round 1

Reviewer: `readiness_codebase_round1`, fresh conversation context (`fork_turns: none`).
Persona: `egm-codebase-details`. Mode: REVIEW. Standard: `implementation-readiness-standard`.
Active scope: [Detailed Implementation Plan](../../castloop-mvp.md#detailed-implementation-plan), lines 410–654.

## Complete reviewer result

Two Major findings; no Blockers or Nits.

**codebase-1-1 — Major — Protocol and persisted shapes still require implementer design decisions.**

Affected active-scope lines: **491–519, 541–547, 579–580, 608**.

The plan names routes and information groups, but does not define the concrete contracts it asks implementation to create. Examples:

- Line 496 requires explicit action enums without specifying their values or per-action payloads, including the one-show metadata batch.
- Line 491 requires a canonical mutation fingerprint without defining canonical serialization, digest algorithm or handling of omitted/defaulted fields.
- Lines 505–515 promise versioned JSON shapes but supply neither those shapes nor precise SQL column definitions, constraints and initial singleton values.
- Lines 541–547 describe export contents and restore behavior without specifying the version-1 envelope and row/reference schemas.

Repository searches confirm there is no existing contracts module, SQL schema, API implementation or serialization helper to reuse. Thus a fresh implementer must independently design durable and cross-component interfaces, contrary to the standard’s zero-decision rule. Add concrete typed request/response/export definitions, canonical fingerprint rules and initial schema specification.

**codebase-1-2 — Major — Unknown TOML preservation lacks the selected library’s necessary numeric policy.**

Affected active-scope lines: **422, 430–439, 581, 587**.

The plan promises preservation of unknown fields through parsing and normalization but only specifies Temporal handling. The supplied `smol-toml` capture explicitly states:

- Default parsing cannot represent integers beyond 53 bits (`sources/07.txt:203–218`).
- Default serialization changes a floating-point value such as `1.0` into an integer; full numeric type preservation requires the documented BigInt/serialization options (`sources/07.txt:219–224`, also the stringify notes).

Consequently, an otherwise valid draft containing an unsupported large integer can fail parsing, and normalization can change an unknown field’s TOML type. Preserving raw bytes only when no normalization occurs does not cover initial timezone insertion. Specify numeric parse/stringify options, conversion rules for known integer fields, and fixtures covering unknown 64-bit integers and integral floats during timezone normalization.

## Read/search evidence and coverage

- Read the required persona and Implementation Readiness Standard first.
- Read the entire target, including active lines 410–654 and preceding architecture for clarification.
- Read all three supplied local context documents and all fifteen external captures; closed substantive truncation gaps with bounded rereads.
- Checked `.codegraph/` first: absent, so skipped CodeGraph.
- Used repository file enumeration and read-only inventory validation. All **68** inventory entries are marked Create/Modify; all **nine Modify paths exist**. No planned Create path already exists.
- No production source, dependency manifests, build scripts, test configurations, shared mocks or test helpers currently exist under the planned implementation areas. No actual implementation reuse or test-infrastructure contradiction was found.
- Supplied platform captures support the selected asynchronous SQLite transaction direction, alarm semantics, same-entrypoint cache purge ownership, platform-owned cached ranges and current `@cloudflare/vitest-plugin` package name.
- No writes, builds, deployments or runtime verification performed. External APIs absent from the supplied captures, resolved dependency compatibility and deployed behavior remain unverified.
