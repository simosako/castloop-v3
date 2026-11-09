# Castloop operations

This guide describes the current development implementation. It has been tested locally with simulated Cloudflare services, not deployed for production use. See [verification](verification.md) for the remaining integration checks.

## Workspace and credentials

Build the CLI with `bun run build:cli` and run `dist/castloop` from a workspace directory. For release artifacts, run `bun run build:release --target bun-linux-x64` (or `--all` for the five planned targets); this writes binaries and SHA-256 checksums under `dist/release`. Cross-compiled binaries require tests on their native hosts before support is claimed. Run `castloop init` once, then set `management_url`, `account_id`, `management_bucket` and `delivery_bucket` using `castloop config set <key> <value>`. The optional `r2_endpoint` is intended for an alternative compatible endpoint or local test service.

Set `admin_token`, `r2_access_key_id` and `r2_secret_access_key` using `castloop auth set <name>` in an interactive terminal. Alternatively supply `CASTLOOP_ADMIN_TOKEN`, `CASTLOOP_R2_ACCESS_KEY_ID` and `CASTLOOP_R2_SECRET_ACCESS_KEY` as environment variables. Credentials are stored separately from workspace TOML under `$XDG_CONFIG_HOME/castloop/credentials.toml`, or `~/.config/castloop/credentials.toml` when the variable is unset. Do not put credentials in Show or Episode TOML.

## Publishing

1. Run `castloop show new`. The command prints the new Show ID and creates a Show TOML draft with `publish = false`.
2. Edit the TOML. Set title, description, HTTPS website, language, timezone, artwork filename, Apple category and explicit flag. Run `castloop push --show <show>`. Validation messages may report the missing cover; a structurally valid draft is still accepted.
3. Run `castloop show upload-cover <show> <path>`. Castloop uses the artwork filename from the accepted Show TOML as the logical name; the local file's basename can differ, but its JPEG/PNG format must match that name. Supported images are square 1400–3000 pixel RGB JPEG or PNG without transparency.
4. Set Show `publish = true` and push. To create an Episode, run `castloop episode new <show>`, edit its TOML and push it. Episode updates require a publication-ready Show.
5. Run `castloop episode upload-audio <show> <episode> <path>` to select an MP3. Set Episode `publish = true` and a `published_at` TOML datetime, then push. An incomplete Episode remains saved but is not published. Future dates use a per-Show Durable Object alarm; local times use the Show timezone unless the Episode has its own timezone. Explicit UTC offsets are supported.
6. Run `castloop check --show <show>` to inspect validation and delivery status. Add `--delivery` to probe the published feed and an audio range, or `--json` for a machine-readable check report. A delivery failure requires explicit `castloop recover <show>`; `--episode <episode>` limits recovery to one Episode when no migration is pending.

The source TOML is authoritative. Edit it and push rather than using title-specific commands. `castloop push --json` reports each Show's acceptance and delivery result, including retained operation IDs when the outcome is uncertain. `castloop pull --show <show>` fetches metadata without downloading MP3s. If both local and remote TOML changed, the existing local file is retained as a `.bak` file and the remote file is installed. Compare and edit before pushing. A missing local file is not a deletion request. `pull`, `show list`, `inventory`, `export`, `restore`, `restore-resume`, and `cleanup` also support `--json`; the output includes partial failures and, for an uncertain restore, the retained operation ID. JSON restore and resume, and cleanup with `--apply`, require `--yes` for confirmation.

If a large audio upload is interrupted, the CLI attempts to abort its multipart transfer and reports that the configured R2 incomplete-multipart lifecycle handles any remaining parts. A hard termination or an unavailable R2 service can prevent the abort request from completing. Configure that lifecycle as described in [deployment](deployment.md).

The CLI uses exit code 2 for invalid command arguments and local validation errors, 1 for operational or transport failures and accepted operations whose delivery remains pending, 3 for revision or identity conflicts, and 4 for a cancelled or missing confirmation. Code 0 indicates success. A pending result means the intent was saved, but publication or withdrawal has not finished: check its status and recover it if it remains pending. An explicitly empty `--show` is invalid; omit the option to target discovered shows.

## Withdrawal and recovery

Set an Episode's `publish = false` and push, or run `castloop episode delete <show> <episode>`. To stop an entire Show, set Show `publish = false` and push, or run `castloop show delete <show>`. Show stop and deletion require confirmation; noninteractive use requires `--yes`. These operations remove public delivery while retaining private source versions. Replacing audio uses `episode upload-audio` again; already downloaded copies are unaffected.

If an operation's response is uncertain, retain the operation ID shown by the CLI and run `castloop operation retry <operation-id>`. This replays the saved request; do not invent a new operation for an uncertain outcome. If the server accepted an operation but the CLI could not update local state or remove the receipt, the CLI reports the accepted revision and delivery outcome. Fix the local error, then retry the retained operation; use `pull` if instructed to refresh the baseline. `check` reports stored publication and notification outcomes. Cloudflare Workers Logs contain diagnostic events. `recover` starts the applicable publication work again from current accepted intent; there is no automatic publication retry.

If the CLI stops during local ID collision recovery, run `castloop operation recover-local` to restore the pre-move files without contacting Cloudflare. Until that recovery succeeds, commands that could modify the workspace or remote state are stopped; `check` and `show list` remain available. A `push` also attempts the local recovery before proceeding. If the affected TOML has been edited since interruption, recovery stops and reports the file instead of overwriting the edit.

If the administrator chooses to stop retrying an unresolved operation, `castloop operation abandon <operation-id>` requires confirmation and moves its record to `.castloop/abandoned/`. This only changes the local record: the operation may already have been accepted, so pull the Show before preparing another update. Add `--yes --json` for noninteractive use. If the server explicitly rejected an operation but the CLI could not remove its receipt, fix the filesystem error and retry the saved operation or abandon its record. A revision conflict requires pulling the latest metadata before preparing a new update.

## Retention and backups

`castloop inventory --show <show>` discovers attributable private R2 objects, registers unknown versions and reports unresolved claims. `castloop cleanup --show <show> --older-than <days>` previews eligible old versions; add `--apply` and confirm to delete them. Current, delivered, pinned and uncertain sources are protected. Review the preview, especially after interrupted uploads.

`castloop export <file> --show <show>` exports metadata and references, not MP3 or image bodies. Preserve the referenced private R2 objects separately. `castloop restore <file>` previews and requires confirmation; replacing an existing Show requires `--replace` after stopping it and completing withdrawal. Restore installs a hold. `castloop restore-resume <show>` previews and confirms rebuilding delivery and reservations.

## Delivery changes

After configuring and verifying the custom domain as described in [deployment](deployment.md), use `castloop delivery migrate <show> --to https://podcasts.example.com`. `castloop delivery rollback <show>` selects the previously committed origin, or cancels a pending migration by returning to the current origin. Both require confirmation. `check` reports the current and pending origin. An unsuccessful cutover remains pending for explicit whole-Show `recover`. Clients may retain a permanent redirect after rollback; do not remove the custom domain until affected clients have been addressed.
