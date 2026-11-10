# Draft: delegate R2 media copies

Status: **approved for MVP by the administrator**. This design amends the MVP design to address the real 100-Episode publication failure recorded in [verification](../verification.md), while retaining complete reruns after failures and the existing publication order. Supported bounds remain subject to measurement and implementation validation.

## Problem

One accepted batch made 90 previously prepared Episodes eligible. During the single Show Durable Object invocation, R2 CopyObject requests exceeded the deployment's per-invocation subrequest limit. Publication failed after some public audio objects had been written; the previous 10-Episode feed remained available. The 100-Episode intended state was not achieved. Raising limits would not satisfy the Free-plan goal.

An isolated real-account experiment used the current `copyMediaObject` implementation to copy 60 distinct small objects through two private Service Binding invocations of 30 copies each. A further run made those calls from a SQLite Durable Object. All 60 destination bodies matched and the test objects were removed. A separate control loop reached the subrequest limit at 50 direct fetches. These observations justify a prototype; they do not establish correctness, limits or performance for a complete publication batch.

An additional harness injected an incorrect source ETag after 37 successful copies, removed all test destination keys and verified the prefix was empty, then reran both groups successfully. The reset was performed by the test harness; neither the experimental Durable Object nor the application implements this recovery flow as a result of that proof.

Another isolated run copied 60 objects including 52,801,454-byte and 105,601,611-byte audio sources using two delegated calls. All destination SHA-256 digests matched their source metadata, and the isolated objects were removed. This is not yet a complete publication test.

With the implemented delegate deployed, explicit recovery published the previously failing 100-Episode Show, and a later custom-domain migration and rollback preserved its GUIDs without changing the audio objects. Details and remaining measurement limits are in [verification](../verification.md).

## Proposed approach

Keep the Show Durable Object responsible for one captured publication candidate, source pins, accepted revision, cache invalidation, feed construction and the final guarded SQLite update. Give a private Worker entrypoint the existing signed, source-ETag-conditional R2 CopyObject operation. The entrypoint has only the R2 copy credentials and receives explicit, validated source references and destination paths through a Service Binding; it has no public route and no TOML or audio request bodies.

For one publication attempt, split the needed media operations into bounded groups. The initial 30-copy experiment used 49 ms of stateless Worker CPU, so the current implementation uses at most four copies per invocation pending measurement. Await each group's complete result before considering the next. The Show retains its pins and waits for every required copy before purging media paths, rebuilding the entire feed, purging the feed path and committing delivery references. Do not expose credentials through RPC responses or logs. Preserve current checks of source ownership, MIME, destination path, source ETag and the parsed CopyObject response.

This proposal does **not** add a persistent queue, an automatic retry, or a per-file progress cursor. If a delegated group or later publication stage fails, record an incomplete outcome. Explicit recovery starts the affected publication again from deletion and rebuilds the feed from the beginning, following the existing recovery semantics; it does not resume at the failed item. Temporary public state during a failure and convergence on an administrator-requested recovery remain governed by the approved design.

## Limits and open verification

- A Service Binding call counts toward a request's subrequest budget, and Cloudflare documents a maximum of 32 Worker invocations per request. Allow for the caller and other bindings rather than assuming 32 copy groups are available. Establish the exact accounting with the deployed implementation.
- The four-copy group size is a test starting point, not an assertion that an arbitrary archive fits. Candidate preparation also reads metadata and verifies source objects; Free-plan internal-service subrequest, CPU, memory, wall-time, R2 and cache-purge limits remain applicable. In particular, 1,000 Episodes are not established as supported.
- Avoid adding an implicit partial publication for batches exceeding a measured safe bound. Before accepting or applying a batch, either validate an established supported bound and return an actionable error, or revise this design after a separate review.
- A failed call can have copied some destinations before its response is lost. Tests must show that the next explicit recovery deletes and copies the affected targets from scratch, preserves authoritative R2 sources and does not mark a stale revision complete.
- Confirm behavior when an administrator accepts a newer revision during a delegated call, when a purge fails, when a Show or Episode is withdrawn, and when the runtime terminates. Confirm that no partial or stale completion is reported as success and that pins remain safe.
- Verify 100 published Episodes on a disposable Free-plan account, including source/destination contents, GUIDs, feed, cache purge and deletion. Record the plan, CPU and wall time, operation counts and memory where observable. Test representative 30–50 MB audio separately; the 60-object proof used tiny synthetic objects.
- Test migration and rollback, including the no-audio-copy invariant, with a delegated publisher. The existing one-Episode migration result is not evidence for a 100-Episode migration.

## Implementation gate

The private copy entrypoint and bounded calls are approved. Determine the supported batch/archive bound after measurement; do not claim the 100-Episode end-to-end case until it passes.
