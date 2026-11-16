# CloudflareへのCastloop導入

[English](installation.md)

この手順書では、自分のCloudflareアカウントにCastloopをデプロイし、`workers.dev` のURLを使ってShowとEpisodeを公開します。独自ドメインは任意です。

Castloopは開発中です。この手順書のデプロイと公開の流れは、分離したCloudflareアカウント環境で検証しています。ただし認証情報と認証方法には[検証記録（英語）](verification.md)に記載した違いがあります。既存のPodcastで利用する前に、テスト環境で試してください。

## 事前準備

次のものが必要です。

- Workersを利用でき、`workers.dev` サブドメインを登録し、R2を有効にしたCloudflareアカウント。WorkersとR2バケットを作成する権限も必要です。必要な課金設定やサービス利用規約への同意はアカウント所有者が行ってください。無料枠を超える利用には料金が発生する場合があります。
- [Bun](https://bun.sh/)、Git、Python 3、POSIX系のシェル。この例ではBashを使います。Windowsネイティブ環境での導入はまだ検証していません。
- MP3音源と、縦横1400〜3000ピクセルの正方形で、透過のないRGBのJPEGまたはPNGカバー画像。公開する権利のある素材を使用してください。
- 2組のR2 S3 API認証情報。CLI用には管理バケットのオブジェクト読み書き権限、コピー用Workerには管理バケットの読み取りと配信バケットへの書き込み権限が必要です。バケット作成後に用意してください。[認証情報の権限範囲（英語）](deployment.md#credential-and-permission-inventory)を参照してください。提案している限定的な権限はまだ十分に検証されていません。

認証情報をGit、コマンド引数、共有端末に含めないでください。この手順では、保護されたGit管理対象外の `.local-test/install` ディレクトリに設定と秘密情報を保存します。管理者トークンとR2認証情報は安全にバックアップしてください。

## 1. ソースの取得と名前の決定

リポジトリをクローンして移動し、CLIをビルドします。

```sh
git clone https://github.com/simosako/castloop-v3.git
cd castloop-v3
bun install --frozen-lockfile
bun run build:cli
export CASTLOOP_REPO="$PWD"
```

Wranglerで認証し、対象アカウントを確認します。

```sh
bunx wrangler login
bunx wrangler whoami
```

代わりに、デプロイとリソース作成に必要な権限を持つCloudflare APIトークンを使うこともできます。デプロイに必要な最小権限の詳細はまだ検証が必要です。[デプロイ権限（英語）](deployment.md#credential-and-permission-inventory)を参照してください。

このインストール用に**新しい名前**を選んでください。Worker名はアカウント内で重複できず、バケット名はR2の命名規則に従う必要があります。既存のWorkerやバケットの名前は使わないでください。デプロイによって既存Workerが置き換わる可能性があります。アカウントIDとworkers.devサブドメインを含めて以下の例を置き換え、同じシェルでコマンドを実行します。

```sh
export CLOUDFLARE_ACCOUNT_ID="your-32-character-account-id"
export CASTLOOP_MANAGEMENT_WORKER="my-castloop-management"
export CASTLOOP_DELIVERY_WORKER="my-castloop-delivery"
export CASTLOOP_COPIER_WORKER="my-castloop-copier"
export CASTLOOP_MANAGEMENT_BUCKET="my-castloop-management"
export CASTLOOP_DELIVERY_BUCKET="my-castloop-delivery"
export CASTLOOP_WORKERS_SUBDOMAIN="your-workers-subdomain"
```

URLは `https://<worker-name>.<workers-subdomain>.workers.dev` の形式になります。Podcastの利用中は配信URLを維持してください。

## 2. 非公開R2バケットと認証情報の作成

```sh
bunx wrangler r2 bucket create "$CASTLOOP_MANAGEMENT_BUCKET"
bunx wrangler r2 bucket create "$CASTLOOP_DELIVERY_BUCKET"
```

両バケットの公開 `r2.dev` アクセスは無効のままにします。管理バケットには非公開の元ファイルを保存します。公開対象の素材だけを配信バケットへコピーし、配信Worker経由で公開します。

管理バケットの[R2ライフサイクルルール](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)を確認します。

```sh
bunx wrangler r2 bucket lifecycle list "$CASTLOOP_MANAGEMENT_BUCKET"
```

すべてのプレフィックスを対象に、未完了のマルチパートアップロードを7日以内に中止する有効なルールがまだない場合は、次のように追加します。

```sh
bunx wrangler r2 bucket lifecycle add "$CASTLOOP_MANAGEMENT_BUCKET" castloop-abort-incomplete --abort-multipart-days 7
```

すべてのプレフィックスにルールを適用する確認画面で承認してください。新規バケットには7日間のデフォルトルールが既にある場合があります。その場合、追加のルールは不要です。

アップロードが完了したオブジェクトを期限切れにするルールは追加しないでください。受理されたPodcastの元ファイルを保持する必要があります。Cloudflareダッシュボードで、[認証情報の権限範囲（英語）](deployment.md#credential-and-permission-inventory)に記載した2組のR2 S3 API認証情報を作成してください。それぞれのアクセスキーIDとシークレットアクセスキーを安全に保存します。これらはWranglerが使うAPIトークンとは別のものです。

## 3. Worker設定の準備

管理Workerと配信Workerは互いを参照します。そのため、初回デプロイでは404を返す2つの仮Workerを作成し、コピー用Workerの作成後にアプリケーションへ置き換えます。次のコマンドは、Git管理されているテンプレートを変更せず、`.local-test/install` 以下に設定ファイルを作成します。

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

デプロイ前に、表示された名前と配信元URL、および生成されたファイルを確認してください。エントリーポイントのパスは絶対パスなので、チェックアウト先を移動した場合は設定を再生成してください。初期設定ではメール通知と独自ドメイン配信は設定されません。後から設定する方法は[デプロイ手順（英語）](deployment.md)を参照してください。

## 4. Workerの秘密情報の準備とデプロイ

次のコマンドはランダムなCastloop管理者トークンを生成し、**コピー用Worker**のR2アクセスキーとシークレットの入力を求めます。秘密情報を画面に表示せず、Wrangler用の保護されたJSONファイルを作成します。既存ファイルがある場合は上書きせずに終了します。

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

リポジトリのルートから、次の順序でデプロイします。

```sh
bunx wrangler deploy -c .local-test/install/management-placeholder.json
bunx wrangler deploy -c .local-test/install/delivery-placeholder.json
bunx wrangler deploy -c .local-test/install/copier.json --secrets-file .local-test/install/copier-secrets.json
bunx wrangler deploy -c .local-test/install/management.json --secrets-file .local-test/install/management-secrets.json
bunx wrangler deploy -c .local-test/install/delivery.json
```

Wranglerに表示される名前とURLが想定どおりであることを確認します。コピー用Workerには公開 `workers.dev` ルートがありません。管理エンドポイントには管理者トークンが必要で、配信エンドポイントは公開されます。デプロイに失敗した場合は、エラーを修正して失敗したコマンドから再開してください。稼働中の環境に仮Workerを再デプロイしないでください。

管理エンドポイントが認証情報のないリクエストを拒否することを確認します。HTTP `401` が返るはずです。

```sh
curl -i "https://${CASTLOOP_MANAGEMENT_WORKER}.${CASTLOOP_WORKERS_SUBDOMAIN}.workers.dev/v1/shows"
```

後のアップグレードに備えて生成された設定を保持し、秘密情報ファイルを安全にバックアップしてください。Wranglerのデプロイによってダッシュボード上の設定が上書きされる場合があるため、更新前にバインディングと変数を確認してください。これらのファイルはコミットしないでください。Workerの更新時の動作とメール設定については[デプロイ手順（英語）](deployment.md)を参照してください。

## 5. CLIワークスペースの設定

Podcastのメタデータ用に別のディレクトリを作成します。手順1で設定した環境変数を同じシェルで引き続き使用してください。

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

`PATH` の変更はこのシェルに適用されます。別のシェルではバイナリのディレクトリを再度追加するか、`"$CASTLOOP_REPO/dist/castloop"` を直接実行してください。

保護されたファイルから管理者トークンをこのシェルに設定し、対話形式の入力画面で**CLI用**R2認証情報を入力します。

```sh
export CASTLOOP_ADMIN_TOKEN="$(python3 -c 'import json, os; print(json.load(open(os.path.join(os.environ["CASTLOOP_REPO"], ".local-test/install/management-secrets.json")))["ADMIN_TOKEN"])')"
castloop auth set r2_access_key_id
castloop auth set r2_secret_access_key
```

代わりに `castloop auth set admin_token` を使って同じトークンを対話形式で保存することもできます。`auth set` で入力した認証情報はワークスペースとは別の `$XDG_CONFIG_HOME/castloop/credentials.toml` に保存されます。`XDG_CONFIG_HOME` が未設定の場合は `~/.config/castloop/credentials.toml` です。環境変数を使う方法は[運用ガイド（英語）](operations.md#workspace-and-credentials)を参照してください。

## 6. ShowとEpisodeの公開

以下のコマンドでは、`<show-id>`、`<episode-id>`、ファイルパスの例を自分の値に置き換えてください。Showを作成します。

```sh
castloop show new
```

コマンドは `s-xxxxxxxx` のようなShow IDを表示し、`<show-id>/show.toml` を作成します。ファイルを編集し、タイトル、説明、HTTPSのWebサイト、言語、作者、カバー画像のファイル名、カテゴリ、explicitフラグ、タイムゾーンを入力します。ここでは `publish = false` のままにします。`artwork` のファイル名は、カバー画像に合わせて `.jpg` または `.png` で終わるようにしてください。

たとえば、生成された `id` を維持し、次のフィールドに自分の値を入力します。

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

最初のpushではカバー画像がないことが報告される場合がありますが、構文とスキーマが正しいドラフトは保存されます。Showが非公開の間は、カバー画像のアップロードで配信待ちが報告される場合があります。`show.toml` の `publish = true` を設定して再度pushします。

```sh
castloop push --show <show-id>
```

Episodeを作成し、`<show-id>/<episode-id>/episode.toml` を編集します。

```sh
castloop episode new <show-id>
```

タイトル、説明、公開日時を入力します。最初のテストでは、`published_at = 2025-01-01T12:00:00` のようにShowのタイムゾーンにおける過去のローカルTOML日時を指定し、最初は `publish = false` のままにします。メタデータをpushし、MP3をアップロードします。

```sh
castloop push --show <show-id>
castloop episode upload-audio <show-id> <episode-id> /path/to/episode.mp3
```

最初のEpisodeのpushではドラフトが保存されますが、音源がないという検証エラーが報告され、終了コード2が返ります。音源が受理されたら、EpisodeのTOMLに `publish = true` を設定して再度pushします。ドラフトが未完成の間、CLIは配信待ちや配信ブロックを報告する場合があります。再実行する前に、受理結果と検証メッセージを確認してください。未来の公開日時を指定するとEpisodeが予約されます。フィードは自動的に更新されます。

```sh
castloop push --show <show-id>
castloop check --show <show-id> --delivery
```

次のURLのプレースホルダーを配信Worker名、workers.devサブドメイン、Show IDに置き換え、Podcastアプリに追加します。

```text
https://<delivery-worker>.<workers-subdomain>.workers.dev/<show-id>/feed.xml
```

フィード、カバー画像、公開済み音源は誰でもアクセスできます。コマンドで検証エラーが報告された場合は、TOMLを修正して再度pushしてください。配信が失敗または待機中の場合は、`castloop check --show <show-id>` で確認し、原因を修正してから `castloop recover <show-id>` を実行します。詳しくは[運用ガイド（英語）](operations.md)を参照してください。`castloop export` はメタデータとオブジェクト参照を保存しますが、音源などのファイル本体は保存しません。非公開の元ファイルは別途保持してください。
