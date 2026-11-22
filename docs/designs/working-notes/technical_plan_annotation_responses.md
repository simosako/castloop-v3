# Technical Plan annotation responses

* **Date:** 2026-11-07
* **Status:** The author selected an eight-character random suffix and Workers Logs with minimal current failure state in SQLite, then approved the Technical Plan. The English design and consolidated brief reflect these decisions. The temporary Japanese translation was removed after review at the author's request. Earlier length options below are historical; RSS GUID representation remains open.

## 1. Short identifiers

**Accepted refinement:** Use eight lowercase Base32 characters after `s-` / `e-`, for ten total characters. The 40-bit space has 1,099,511,627,776 possibilities. At 1,000 independently generated IDs, the pre-check probability of any collision is approximately 0.0000454%. Authoritative checks reject collisions, and a new creation generates another candidate. Uncertain retries retain their operation and target identities. The earlier 10/12-character options below were not selected.

The author wants unique identifiers that are convenient to type. UUIDv4 in the management ID is a proposal, not an accepted length requirement. Retain `s-` and `e-` and consider a shorter cryptographically random suffix.

| Option | Example | Randomness | Consequence |
| --- | --- | --- | --- |
| 10 lowercase Base32 characters | `e-k7m3q9t2vx` | 50 bits | 12 total characters; smaller collision space |
| 12 lowercase Base32 characters | `e-k7m3q9t2vx4n` | 60 bits | 14 total characters; larger collision space |

Use a fixed 32-character alphabet that omits easily confused letters, and generate an unbiased random value. No new ID-generation service or sequential counter is required. A new UUID library is not necessary merely to generate these random bits.

Randomness reduces collisions; it does not guarantee uniqueness. Authoritative creation checks remain necessary: an existing show control record rejects a different creation operation, and episode IDs use a unique constraint in their show. On a genuine new-ID collision, CLI generates another candidate. An uncertain retry retains its saved operation identity and target ID instead of generating a different entity.

Episode identity and URLs remain scoped to the show; human-entered operations include show context. Do not add a global episode registry merely to guarantee an unneeded global short-ID namespace. IDs do not grant authorization and need not be secret.

The existing proposal derives an RSS GUID from an ID containing a UUID. Shortening that ID means this derivation must change explicitly. One compatible mechanism is generating and persisting an independent UUID-based RSS GUID when creating an episode, leaving the short ID for CLI and paths. This GUID never changes. The exact GUID representation remains subject to approval with the ID change; do not put a non-UUID short ID into a `urn:uuid:` value.

No ID format has been implemented or published, so this is a draft amendment rather than a migration of real subscriptions.

## 2. Platform logs instead of a SQLite log store

**Accepted:** Detailed diagnostics go to Workers Logs; SQLite retains only compact current unresolved publication state. Do not create a separate SQL error-history store or log viewer.

Workers Logs can collect structured console logs and exceptions and support dashboard filtering. Durable Object logs can also be viewed through the namespace's Observability tab. Emit publication diagnostics with show ID, episode ID when applicable, operation ID, accepted revision, action, error code and exception details. Do not include credentials or private source bodies.

As of 2026-11-07, documented Workers Free allowances are 200,000 log events per day and three-day retention; Paid retention is seven days. The documentation announces a pricing transition on 2026-12-01, so deployment guidance must recheck those values. See [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [Durable Object logging](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/#view-logs).

Proposed responsibility split:

| Store | Contents |
| --- | --- |
| Workers Logs | Detailed diagnostic messages, exception stacks and event history for investigation in Cloudflare |
| Existing SQLite publication outcome | Current unresolved result: target/revision, incomplete or failed state, compact error code/message, failure time and operation identity needed to correlate logs |

Remove the draft's implication that Castloop builds its own general error-log table or log viewer. The compact current failure result is service state, not an append-only log history. It lets `castloop check` report an unresolved problem after logs expire and prevents another reservation from treating a known failed target as never attempted. It need not duplicate exception stacks, every error event or platform log retention.

Workers Issues can additionally group errors and capture handled exceptions passed to `console.error()`. It is currently free in open beta. It is optional investigation support rather than a required MVP dependency; no custom Tail Worker, Logpush pipeline or external log service is needed. See [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/).

Keep the accepted optional administrator email behavior. Selecting Workers Logs alone does not establish email delivery or replace durable current publication outcomes.

## Draft amendments

English Technical Plan sections 2–3, 8 and 10 and predecessor wording reflect the accepted identifier length and logging split. The temporary translation was updated for review and then removed at the author's request. The GUID representation is explicitly unresolved; shortening the CLI ID does not silently select another RSS representation.
