# Castloop

Castloop is a self-hosted, public podcast hosting service for your Cloudflare account. Edit Show and Episode metadata in TOML, manage your podcast with a standalone CLI, and distribute an RSS feed and MP3 audio to podcast apps.

The administrator deploys Castloop to their own Cloudflare account. Source metadata and media are kept in a private R2 bucket; separate delivery objects are served through a Worker or, with a custom domain, through Cloudflare's CDN. You can start with a `workers.dev` URL and no custom domain. Castloop is designed with Cloudflare's free allowances in mind, although usage and costs depend on your workload and account.

Castloop is under development. A Free-plan test installation has published real podcast audio and artwork to a podcast app, and other operations have been exercised with test data. Installation, least-privilege credentials and some recovery paths still need more verification; see [verification](docs/verification.md).

## Get started

Follow the [installation guide](docs/installation.md) to build the CLI, deploy the Workers and publish your first Show and Episode. The initial setup uses `workers.dev` and does not require a custom domain.

Once installed, the usual workflow is:

1. Run `castloop show new`, edit the generated Show TOML and push it. Upload a cover image and set `publish = true`.
2. Run `castloop episode new <show-id>`, edit and push the Episode TOML, then upload its MP3 with `castloop episode upload-audio <show-id> <episode-id> <file.mp3>`.
3. Set the Episode's publication date and `publish = true`, then push. Castloop updates the RSS feed; future-dated Episodes are scheduled automatically.

Use `castloop pull` to retrieve current metadata without downloading audio, and `castloop check --show <show-id> --delivery` to check publication and delivery. See the [operations guide](docs/operations.md) for updates, deletion, recovery and backups.

## Documentation

- [Installation](docs/installation.md) — prerequisites, Cloudflare setup and the first podcast.
- [Deployment and permissions](docs/deployment.md) — configuration details, credential scopes and optional services.
- [Operations](docs/operations.md) — metadata, publication, troubleshooting and retention.
- [Custom-domain migration and restore](docs/migration-and-restore.md).
- [Verification](docs/verification.md) — tests performed and remaining limitations.
- [MVP design](docs/designs/castloop-mvp.md) — architecture and design decisions.

## Development

Install [Bun](https://bun.sh/) and run:

```sh
bun install --frozen-lockfile
bun run build:cli
bun run test:domain
bun run test:cli
bun run test:workers
bun run typecheck
```

The compiled CLI is `dist/castloop`. Cross-compiled release targets require testing on their native platforms before they can be claimed as supported.
