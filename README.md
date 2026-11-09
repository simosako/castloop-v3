# Castloop

Castloop is a self-hosted podcast service for a Cloudflare account. An administrator uses a standalone CLI to manage Shows and Episodes; listeners receive a public RSS feed and MP3 audio. Show and Episode metadata is edited as TOML. Private source files are retained separately from public delivery objects.

Castloop is under development. The CLI and Workers have been exercised locally with simulated Cloudflare services, but deployment, cache behavior, account permissions and free-tier capacity still need verification on a real account. See [verification](docs/verification.md) for test coverage and its limits.

## Build and test locally

Install [Bun](https://bun.sh/) and the project dependencies, then run:

```sh
bun install --frozen-lockfile
bun run build:cli
bun run test:domain
bun run test:cli
bun run test:workers
bun run typecheck
```

The compiled CLI is `dist/castloop`. Worker tests start a local runtime; they do not deploy the application. The release build script can produce binaries for multiple targets, but each target needs native-host testing before support is claimed.

## Create a podcast

First configure a Cloudflare installation using [deployment](docs/deployment.md). In a separate workspace, run `castloop init`, configure the management URL, account and bucket names, and set the administrator and R2 credentials as described in [operations](docs/operations.md).

1. Run `castloop show new`, edit the generated `show.toml`, and push it with `castloop push --show <show-id>`.
2. Upload the Show artwork with `castloop show upload-cover <show-id> <path>`. Set `publish = true` in the Show TOML and push again.
3. Run `castloop episode new <show-id>`, edit the Episode TOML, and push. Upload the MP3 with `castloop episode upload-audio <show-id> <episode-id> <path>`.
4. Set the Episode's `publish = true` and `published_at`, then push. Run `castloop check --show <show-id>` to inspect readiness and delivery.

`castloop pull` retrieves metadata without downloading media. Metadata changes, withdrawal, conflict backups, uncertain operations, cleanup and export are described in [operations](docs/operations.md). Custom-domain migration and restoration are described in [migration and restore](docs/migration-and-restore.md).

The [approved MVP design](docs/designs/castloop-mvp.md) records the architecture and intended behavior.
