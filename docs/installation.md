# Install Castloop on Cloudflare

[日本語](installation_ja.md)

This guide deploys Castloop to your Cloudflare account using a `workers.dev` URL, then publishes a Show and Episode. A custom domain is optional.

Castloop is under development. The guide's deployment and publishing flow has been exercised in an isolated Cloudflare account, with the credential and authentication differences noted in [verification](verification.md). Try a test installation before relying on it for an existing podcast.

## Before you begin

You need:

- A Cloudflare account with Workers, a registered `workers.dev` subdomain, R2 enabled, and permission to create Workers and R2 buckets. The account owner must enable any required billing or service terms. Usage beyond applicable free allowances may incur charges.
- [Bun](https://bun.sh/), Git, Python 3 and a POSIX-like shell. These examples use Bash. Native Windows installation has not yet been verified.
- An MP3 and a square RGB JPEG or PNG cover, 1400–3000 pixels per side, without transparency. Use material you are allowed to publish.
- Two R2 S3 API credentials: a CLI credential with object read/write access to the management bucket, and a separate copier credential that can read the management bucket and write the delivery bucket. Create these after creating the buckets. See [credential scopes](deployment.md#credential-and-permission-inventory); proposed narrower grants have not yet been fully verified.

Keep credentials out of Git, command arguments and shared terminals. The examples use a protected, Git-ignored `.local-test/install` directory for configuration and secrets. Back up the administrator token and R2 credentials securely.

## 1. Get the source and select names

Clone the repository, enter it, and build the CLI:

```sh
git clone https://github.com/simosako/castloop-v3.git
cd castloop-v3
bun install --frozen-lockfile
bun run build:cli
export CASTLOOP_REPO="$PWD"
```

Authenticate Wrangler and confirm the account:

```sh
bunx wrangler login
bunx wrangler whoami
```

Alternatively, use a Cloudflare API token with the required deployment and resource-provisioning permissions. Exact minimum deployment permissions remain to be verified; see [deployment permissions](deployment.md#credential-and-permission-inventory).

Choose **new names** for this installation. Worker names must be distinct in your account; bucket names must follow R2 naming rules. Do not use names of existing Workers or buckets: deploying could replace an existing Worker. Replace the examples, including the account ID and workers.dev subdomain, and run these commands in the same shell:

```sh
export CLOUDFLARE_ACCOUNT_ID="your-32-character-account-id"
export CASTLOOP_MANAGEMENT_WORKER="my-castloop-management"
export CASTLOOP_DELIVERY_WORKER="my-castloop-delivery"
export CASTLOOP_COPIER_WORKER="my-castloop-copier"
export CASTLOOP_MANAGEMENT_BUCKET="my-castloop-management"
export CASTLOOP_DELIVERY_BUCKET="my-castloop-delivery"
export CASTLOOP_WORKERS_SUBDOMAIN="your-workers-subdomain"
```

The URLs will be `https://<worker-name>.<workers-subdomain>.workers.dev`. Keep the delivery URL stable while the podcast is in use.

## 2. Create private R2 buckets and credentials

```sh
bunx wrangler r2 bucket create "$CASTLOOP_MANAGEMENT_BUCKET"
bunx wrangler r2 bucket create "$CASTLOOP_DELIVERY_BUCKET"
```

Leave public `r2.dev` access disabled for both buckets. The management bucket holds private source files. Only material intended for publication is copied to the delivery bucket; its contents are served publicly by the delivery Worker.

Check the management bucket's [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/):

```sh
bunx wrangler r2 bucket lifecycle list "$CASTLOOP_MANAGEMENT_BUCKET"
```

If there is not already an enabled rule covering all prefixes that aborts incomplete multipart uploads after seven days or less, add one:

```sh
bunx wrangler r2 bucket lifecycle add "$CASTLOOP_MANAGEMENT_BUCKET" castloop-abort-incomplete --abort-multipart-days 7
```

Confirm the prompt to apply the rule to all prefixes. Newly created buckets may already have a seven-day default rule; in that case no additional rule is needed.

Do not add an expiration rule for completed objects: accepted podcast sources must be retained. Create the two R2 S3 API credentials described in [credential scopes](deployment.md#credential-and-permission-inventory) in the Cloudflare dashboard. Save each access key ID and secret access key securely. These credentials are different from the API token used by Wrangler.

## 3. Prepare Worker configurations

The management and delivery Workers refer to each other. Initial deployment creates two temporary Workers that return 404, then replaces them with the application after the copier exists. The following creates configuration files under `.local-test/install`, without changing the checked-in templates:

```sh
mkdir -p .local-test/install
chmod 700 .local-test/install
python3 - <<'PY'
import json
import os
from pathlib import Path

root = Path.cwd()
out = root / '.local-test/install'
env = os.environ
names = {kind: env['CASTLOOP_' + kind.upper() + '_WORKER']
         for kind in ('management', 'delivery', 'copier')}
mgmt = env['CASTLOOP_MANAGEMENT_BUCKET']
delivery = env['CASTLOOP_DELIVERY_BUCKET']
account = env['CLOUDFLARE_ACCOUNT_ID']
origin = f"https://{names['delivery']}.{env['CASTLOOP_WORKERS_SUBDOMAIN']}.workers.dev"

placeholder = out / 'placeholder.mjs'
placeholder.write_text("export default { fetch() { return new Response('Not found', { status: 404 }); } };\n")
for kind in ('management', 'delivery'):
    config = {'name': names[kind], 'main': str(placeholder),
              'compatibility_date': '2026-11-04', 'workers_dev': False, 'preview_urls': False}
    (out / f'{kind}-placeholder.json').write_text(json.dumps(config, indent=2))

sources = {'management': 'packages/worker/wrangler.jsonc',
           'copier': 'packages/worker/wrangler.copier.jsonc',
           'delivery': 'packages/delivery/wrangler.jsonc'}
for kind, source in sources.items():
    source_path = root / source
    config = json.loads(source_path.read_text())
    config.pop('$schema', None)
    config['name'] = names[kind]
    config['main'] = str((source_path.parent / config['main']).resolve())
    config['workers_dev'] = kind != 'copier'
    config['preview_urls'] = False
    for service in config.get('services', []):
        service['service'] = names[{'castloop-management': 'management',
                                    'castloop-delivery': 'delivery',
                                    'castloop-copier': 'copier'}[service['service']]]
    for binding in config.get('r2_buckets', []):
        binding['bucket_name'] = {'castloop-management': mgmt,
                                  'castloop-delivery': delivery}[binding['bucket_name']]
    if kind in ('management', 'copier'):
        config['vars'].update(R2_ACCOUNT_ID=account, R2_MANAGEMENT_BUCKET=mgmt,
                              R2_DELIVERY_BUCKET=delivery)
    if kind == 'management':
        config['vars']['DELIVERY_BASE'] = origin
    (out / f'{kind}.json').write_text(json.dumps(config, indent=2))
print('Prepared configurations for:', ', '.join(names.values()))
print('Delivery origin:', origin)
PY
```

Review the printed names, origin and generated files before deploying. Entry-point paths are absolute, so regenerate the configurations if you move the checkout. The initial configuration leaves email notifications and custom-domain delivery unconfigured; see [deployment](deployment.md) to configure them later.

## 4. Prepare Worker secrets and deploy

This command generates a random Castloop administrator token and prompts for the **copier** R2 access key and secret. It creates protected JSON files for Wrangler without displaying the secrets. It refuses to overwrite existing files:

```sh
python3 - <<'PY'
import getpass
import json
import os
import secrets
from pathlib import Path

out = Path('.local-test/install')
key = getpass.getpass('Copier R2 access key ID: ')
secret = getpass.getpass('Copier R2 secret access key: ')
if not key or not secret:
    raise SystemExit('Both copier credentials are required')
files = {
    'management-secrets.json': {'ADMIN_TOKEN': secrets.token_urlsafe(48)},
    'copier-secrets.json': {'CASTLOOP_WORKER_R2_ACCESS_KEY_ID': key,
                            'CASTLOOP_WORKER_R2_SECRET_ACCESS_KEY': secret},
}
if any((out / name).exists() for name in files):
    raise SystemExit('Secret file exists; preserve it and resolve this before continuing')
for name, values in files.items():
    fd = os.open(out / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(values, file)
print('Prepared protected secret files.')
PY
```

Deploy from the repository root, in this order:

```sh
bunx wrangler deploy -c .local-test/install/management-placeholder.json
bunx wrangler deploy -c .local-test/install/delivery-placeholder.json
bunx wrangler deploy -c .local-test/install/copier.json --secrets-file .local-test/install/copier-secrets.json
bunx wrangler deploy -c .local-test/install/management.json --secrets-file .local-test/install/management-secrets.json
bunx wrangler deploy -c .local-test/install/delivery.json
```

Check that Wrangler reports the expected names and URLs. The copier has no public `workers.dev` route. The management endpoint requires the administrator token; the delivery endpoint is public. If deployment fails, fix the error and resume from the failed command. Do not redeploy placeholders over a working installation.

Check that the management endpoint rejects a request without credentials; this should return HTTP `401`:

```sh
curl -i "https://${CASTLOOP_MANAGEMENT_WORKER}.${CASTLOOP_WORKERS_SUBDOMAIN}.workers.dev/v1/shows"
```

Keep the generated configurations and back up the secret files securely for later upgrades. Wrangler deployments can overwrite dashboard configuration; review bindings and variables before updating. Do not commit these files. See [deployment](deployment.md) for Worker update behavior and optional email setup.

## 5. Configure a CLI workspace

Create a separate directory for podcast metadata. Keep the environment variables from step 1 in the same shell:

```sh
mkdir -p "$HOME/castloop-workspace"
cd "$HOME/castloop-workspace"
export PATH="$CASTLOOP_REPO/dist:$PATH"
"$CASTLOOP_REPO/dist/castloop" init
"$CASTLOOP_REPO/dist/castloop" config set management_url "https://${CASTLOOP_MANAGEMENT_WORKER}.${CASTLOOP_WORKERS_SUBDOMAIN}.workers.dev"
"$CASTLOOP_REPO/dist/castloop" config set account_id "$CLOUDFLARE_ACCOUNT_ID"
"$CASTLOOP_REPO/dist/castloop" config set management_bucket "$CASTLOOP_MANAGEMENT_BUCKET"
"$CASTLOOP_REPO/dist/castloop" config set delivery_bucket "$CASTLOOP_DELIVERY_BUCKET"
```

The `PATH` change applies to this shell. In another shell, add the binary directory again, or invoke `"$CASTLOOP_REPO/dist/castloop"` directly.

Set the administrator token for this shell from the protected file and enter the **CLI** R2 credentials at the interactive prompts:

```sh
export CASTLOOP_ADMIN_TOKEN="$(python3 -c 'import json, os; print(json.load(open(os.path.join(os.environ["CASTLOOP_REPO"], ".local-test/install/management-secrets.json")))["ADMIN_TOKEN"])')"
castloop auth set r2_access_key_id
castloop auth set r2_secret_access_key
```

Alternatively, use `castloop auth set admin_token` to store the same token interactively. Credentials entered with `auth set` are stored separately from the workspace under `$XDG_CONFIG_HOME/castloop/credentials.toml`, or `~/.config/castloop/credentials.toml` by default. See [operations](operations.md#workspace-and-credentials) for environment-variable alternatives.

## 6. Publish a Show and Episode

In the commands below, replace `<show-id>`, `<episode-id>` and the example file paths with your own values. Create a Show:

```sh
castloop show new
```

The command prints a Show ID such as `s-xxxxxxxx` and creates `<show-id>/show.toml`. Edit the file and fill in the title, description, HTTPS website, language, author, artwork filename, category, explicit flag and timezone. Keep `publish = false` for now. The `artwork` filename should end in `.jpg` or `.png` to match your cover.

For example, fill the generated fields with your own values; keep the generated `id`:

```toml
title = "My podcast"
description = "A podcast about technology."
website = "https://example.com"
language = "en"
author = "Podcast host"
artwork = "cover.jpg"
categories = [{ name = "Technology" }]
explicit = false
timezone = "UTC"
type = "episodic"
```

```sh
castloop push --show <show-id>
castloop show upload-cover <show-id> /path/to/cover.jpg
```

The first push may report that the cover is missing; the structurally valid draft is still saved. Cover upload may report delivery pending while the Show is unpublished. Set `publish = true` in `show.toml` and push again:

```sh
castloop push --show <show-id>
```

Create an Episode and edit `<show-id>/<episode-id>/episode.toml`:

```sh
castloop episode new <show-id>
```

Fill in its title, description and publication date. For the first test, use a past local TOML datetime in the Show timezone, for example `published_at = 2025-01-01T12:00:00`, and leave `publish = false` initially. Push the metadata, then upload the MP3:

```sh
castloop push --show <show-id>
castloop episode upload-audio <show-id> <episode-id> /path/to/episode.mp3
```

The initial Episode push saves the draft but reports a missing audio validation issue and exits with code 2. Once audio is accepted, set `publish = true` in the Episode TOML and push again. The CLI can report pending or blocked delivery while a draft is incomplete; check the reported acceptance and validation messages before retrying. A future publication date schedules the Episode. The feed is updated automatically.

```sh
castloop push --show <show-id>
castloop check --show <show-id> --delivery
```

Replace the placeholders with your delivery Worker name, workers.dev subdomain and Show ID, then add this URL to a podcast app:

```text
https://<delivery-worker>.<workers-subdomain>.workers.dev/<show-id>/feed.xml
```

The feed, artwork and published audio are public. If a command reports a validation error, correct the TOML and push again. For failed or pending delivery, inspect `castloop check --show <show-id>` and use `castloop recover <show-id>` after correcting the cause. See [operations](operations.md) for details. `castloop export` preserves metadata and object references, not the media bodies; preserve private source objects separately.
