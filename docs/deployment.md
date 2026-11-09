# Deployment preparation

Castloop has not yet been verified against a real Cloudflare account. Use a disposable installation for initial validation and follow [verification](verification.md); the configuration below describes the implementation rather than a production deployment guarantee.

Create separate management and delivery R2 buckets. Keep `r2.dev` access disabled. Bind both buckets to the management Worker; bind only the delivery bucket to the delivery Worker. The optional custom domain is attached to the delivery bucket, with Cloudflare cache rules for the public podcast paths and no caching of error responses. Configure an incomplete-multipart lifecycle; do not expire completed accepted objects. A custom domain makes its public podcast objects accessible through that domain, so the delivery bucket must contain only intended public material.

Set the actual account ID, bucket names and initial workers.dev delivery origin in `packages/worker/wrangler.jsonc`. Configure `packages/delivery/wrangler.jsonc` to bind the same delivery bucket. Keep the internal service bindings and the SQLite Durable Object migration in place. Both Workers refer to each other by service binding; initial deployment/bootstrap ordering needs verification in a real disposable account. The management Worker must not expose an unauthenticated management API.

Keep credential purposes separate:

- The CLI uses an R2 S3 API access key restricted to the management bucket, with the object operations required for reading, listing, uploading and explicit cleanup. Its `admin_token` matches the management Worker's `ADMIN_TOKEN` secret.
- The management Worker uses `R2_COPY_ACCESS_KEY_ID` and `R2_COPY_SECRET_ACCESS_KEY` for server-side promotion. Restrict the associated R2 credential to reading the management bucket and writing the delivery bucket as far as the available R2 permission model allows.
- For custom-domain cache purge, set `CUSTOM_DELIVERY_BASE` to the same HTTPS origin in both Workers, set `CUSTOM_ZONE_ID` in the management Worker, and store `ZONE_PURGE_TOKEN` as a Worker secret with the minimum applicable zone cache-purge permission. Do not give this token to the CLI.
- Email is optional: configure `EMAIL_FROM` and `EMAIL_TO`, enable the sender domain for Cloudflare Email Sending, and restrict the email binding's allowed sender and destination addresses to the installation. Empty sender or destination leaves notifications unconfigured. A send success indicates provider acceptance, not confirmed inbox delivery.

Precise Cloudflare grant names, account-plan limits, cache-rule configuration, service-binding bootstrap and secret provisioning must be checked against current Cloudflare documentation and the target account during integration. Never commit credentials or generated secret files. The application uses R2's beta conditional destination CopyObject extension for multipart source staging; verify it in the disposable account before relying on it.

After configuration, verify direct uploads of representative 50 MiB and 100 MiB audio, immutable create-only behavior, server-side copy, future-release alarms, full and ranged delivery, caching and purge, withdrawals, optional email and per-Show migration/rollback. Measure actual Durable Object CPU and memory for representative archives. Local test elapsed time is not evidence of Cloudflare CPU usage or free-tier capacity.
