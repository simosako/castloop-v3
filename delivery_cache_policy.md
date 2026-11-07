# Delivery URLs, caching and invalidation

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Accepted by the user: stable feed/audio URLs, revision-specific artwork URLs, 30-day shared-cache TTL for feed and media, client revalidation, explicit purge after origin updates/withdrawal, and record/report failures without automatic retry. Do not use short TTLs as insurance against hypothetical platform purge malfunction.

## Decisions and recommendation

| Decision | Proposed MVP behavior | Reason |
| --- | --- | --- |
| Feed URL | Stable `/<show-id>/feed.xml` | A subscriber keeps the same subscription URL when metadata changes |
| Audio URL | Stable `/<show-id>/<episode-id>/audio.mp3` | Requests to the existing URL can receive replacement audio after invalidation; no redirect or revision lookup is needed on direct CDN delivery |
| Cover URL | Revision-specific `/<show-id>/covers/<revision>.jpg` or `.png` | Preserve the earlier decision that updated artwork changes its public URL |
| Shared edge cache lifetime | Feed, audio and cover: 30 days (accepted) | Rely on explicit purge for changes rather than periodic origin revalidation |
| Client cache lifetime | `max-age=0, must-revalidate`; use `s-maxage` for shared-cache lifetime | Clients revalidate while shared edges retain a long freshness lifetime |
| Explicit invalidation | Purge after origin mutation, including feed and affected media | TTL is a fallback, not the normal update/withdrawal mechanism |
| Failed purge | Record delivery incomplete; report/email under the agreed failure policy | Do not claim the withdrawal/replacement is finished or automatically retry |

Use `Cache-Control: public, max-age=0, s-maxage=2592000, must-revalidate` for feed and media responses. These are accepted response values, to verify on both delivery paths during implementation. Do not configure a zone Browser Cache TTL to override them with a longer client lifetime. Do not enable serving stale deleted/replaced content through `stale-while-revalidate`, `stale-if-error` or an equivalent installation rule.

DO not confuse podcast application polling with CDN expiry. A feed update and purge do not force podcast apps to poll immediately. Downloaded MP3s and independently retained application copies cannot be recalled. These limits match the earlier decision not to replace already downloaded listener audio.

Stable audio URLs plus purge are chosen as the recommendation over revision-specific audio URLs: the latter avoids one replacement cache problem, but an old audio URL would stop receiving the new audio unless another routing layer were added. Episode GUID remains stable in either case. Only artwork retains the previously accepted changing-URL policy.

## Both delivery paths

### No custom domain

The delivery Worker uses Workers Cache and an R2 binding. It sets cache headers on successful content and serves HEAD/range requests correctly. Do not use the older `caches.default` as a second cache layer.

The show DO invokes a protected maintenance operation belonging to the delivery Worker/entrypoint that owns the listener cache, preferably through an internal service binding. That owner calls `ctx.cache.purge()` using affected path prefixes or tags and checks the result's success/errors. A service binding does not by itself authenticate an otherwise public maintenance URL; any public route to that operation must require authorization. Exact endpoint/RPC form is a drafting detail. Do not assume purging an unrelated management Worker clears the delivery Worker's cache.

Workers Cache purges propagate globally. Zone-level cache rules/purges and local `caches.default.delete()` are not substitutes for this owner-scoped API. See [Workers Cache](https://developers.cloudflare.com/workers/cache/) and [Workers Cache purge](https://developers.cloudflare.com/workers/cache/purge/).

### Custom domain

Deliver directly through the R2 custom-domain CDN, with r2.dev disabled as previously agreed. Store the chosen HTTP cache metadata on public R2 objects. Configure cache eligibility and origin-header handling explicitly, including XML rather than assuming extension defaults. Do not put a delivery Worker back on this route for invalidation.

The management layer calls the zone purge API with affected public prefixes. Prefix purge is available on Free and clears query-string variants under the selected path; use one episode prefix for its audio, the feed path for RSS, and the show prefix for full withdrawal. Batch related prefixes into requests rather than issuing one request per object. A successful purge followed by a new request fetches origin content; origin deletion alone does not clear already cached content. See [single-file purge](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/) and [R2 cache consistency](https://developers.cloudflare.com/r2/reference/consistency/#caching).

Keep query parameters out of emitted feed/media URLs. Use prefix purge to cover query variants without a custom cache-key framework. Prefixes contain no query strings or fragments. The CDN API takes hostname/path prefixes while the Workers API takes path prefixes; convert these in the delivery adapter. See [CDN prefix purge](https://developers.cloudflare.com/cache/how-to/purge-cache/purge_by_prefix/). Free prefix purge currently has an account token-bucket rate of five requests/minute, burst capacity 25 and up to 100 prefixes/request. Batch and check errors; do not add an automatic retry loop on rate limiting. See [purge limits](https://developers.cloudflare.com/cache/how-to/purge-cache/#availability-and-limits).

Expose one internal operation such as `purgeDelivery(paths)` to publication code; it selects the applicable owner/zone mechanism. Use least-scoped installation credentials needed for the chosen purge method. Do not add a separate queue or purge microservice.

## Origin/cache ordering

* First publication: copy eligible audio and cover to delivery R2, clear any cached missing responses for their URLs, then install the fully regenerated feed and purge its URL. Prevent a previously cached 404 from hiding newly advertised audio.
* Replacement: follow the accepted full-restart rule for the affected episode's delivery objects, copy current audio, purge that audio URL, then delete/recreate the full feed and purge the feed URL. Unchanged episodes' audio remains untouched.
* Episode unpublish, invalidity or deletion: delete its public audio, purge affected URLs, then install the regenerated feed without its entry and purge feed. Keep the target discoverable until cleanup succeeds. A failure leaves a clear incomplete outcome and does not erase the original source.
* Intentional show stop/deletion: remove delivery feed/media/cover and purge all their known public URLs, batching as required by the applicable API limits. Confirmed show stop remains distinct from invalid show metadata. No unrelated zone-wide purge is needed.
* Cover replacement: copy the new revision and advertise that URL in the rebuilt feed. Remove/purge old public artwork under the retained-source policy; management assets required for last-valid-show fallback stay retained.

R2 permits atomic per-object writes, but the accepted preference is delete/recreate affected public objects and whole feed on retries. Cache handling must follow that preference rather than quietly substituting stage resume or an XML patching design.

Workers can return `Cache-Control: no-store` for missing/error responses. On the direct R2 route, default negative caching may apply; configure non-storage for 404/410 where supported and explicitly purge newly created paths before advertising them regardless. Status-code TTL settings and query normalization require concrete Free-plan validation during drafting. See [cache-by-status behavior](https://developers.cloudflare.com/cache/how-to/configure-cache-status-code/).

## Completion and limitations

Check both origin mutation and purge API results. A successful purge response establishes acceptance by the purge service, not proof that every edge/client has switched at the same instant. Brief stale availability or unavailability remains accepted; this is not a zero-window access-revocation system.

If a required copy, feed write or purge fails, persist the affected target and failure, return an error when a CLI is connected, and send administrator email when configured. Do not schedule an application retry or endlessly rearm the failed reservation. Administrator recovery restarts affected publication against latest accepted input.

Use the documented purge behavior as the normal platform contract. Do not shorten TTL, poll every edge or build another recovery mechanism to compensate for a hypothetical malfunction after a correctly scoped successful purge. Check normal API errors, permissions, scope and limits, and keep the accepted record/notify/manual-recovery policy. Independent listener copies remain outside CDN control. A long freshness lifetime is not guaranteed retention: Cloudflare can evict unpopular assets before TTL, so 30 days does not guarantee only one R2 read per object per month. See [retention versus freshness](https://developers.cloudflare.com/cache/concepts/retention-vs-freshness/).

Before implementation is accepted, verify feed refresh, audio replacement at the same URL, old artwork removal, episode/show withdrawal, cached-404 removal and HEAD/range behavior on both routes. Check failure reporting when purge is denied or rate-limited. These checks establish behavior for this configuration, not a blanket guarantee of free-tier capacity.

## Purge versus invalidate

Cloudflare distinguishes deleting cached objects (`purge`) from retaining them marked stale (`invalidate`) for conditional revalidation. Recommend purge for all MVP origin updates and withdrawal to keep one behavior, without a separate soft-invalidation path. Workers `ctx.cache.purge()` uses global Instant Purge, while zone purge does not affect Workers Cache. See [Workers purge/invalidate behavior](https://developers.cloudflare.com/workers/cache/purge/). A successful API response means the service accepted the request; correct targeting remains the application responsibility. Functional verification during implementation is sufficient; no runtime worldwide purge audit is proposed.
