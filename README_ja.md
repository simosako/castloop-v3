# Castloop

[English](README.md)

Castloopは、自分のCloudflareアカウントで公開Podcastを配信するセルフホスト型サービスです。Show（番組）とEpisodeのメタデータをTOMLで編集し、単体で動作するCLIで管理します。リスナーはRSSフィードとMP3音源をPodcastアプリで受け取れます。

管理者は自分のCloudflareアカウントにCastloopをデプロイします。メタデータと音源の元ファイルは非公開のR2バケットに保存し、配信用のファイルは別に用意してWorker経由、または独自ドメインを使ってCloudflareのCDN経由で配信します。独自ドメインがなくても `workers.dev` のURLで始められます。Cloudflareの無料枠を念頭に設計していますが、利用量と料金はワークロードやアカウントによって異なります。

Castloopは開発中です。無料プランのテスト環境で実際のPodcast音源とカバー画像を公開し、Podcastアプリで確認しました。その他の操作もテストデータで検証しています。導入手順、最小権限の認証情報、一部の復旧経路については、さらなる確認が必要です。詳しくは[検証記録（英語）](docs/verification.md)を参照してください。

## はじめに

[導入手順書](docs/installation_ja.md)に従ってCLIをビルドし、Workerをデプロイして、最初のShowとEpisodeを公開してください。初期設定では `workers.dev` を使用するため、独自ドメインは必要ありません。

導入後の基本的な操作は次のとおりです。

1. `castloop show new` を実行し、生成されたShowのTOMLを編集してpushします。カバー画像をアップロードし、`publish = true` にします。
2. `castloop episode new <show-id>` を実行し、EpisodeのTOMLを編集してpushします。続いて `castloop episode upload-audio <show-id> <episode-id> <file.mp3>` でMP3をアップロードします。
3. Episodeの公開日時と `publish = true` を設定してpushします。CastloopがRSSフィードを更新します。未来の日時を指定したEpisodeは自動的に予約公開されます。

`castloop pull` を使うと、音源をダウンロードせずに最新のメタデータを取得できます。`castloop check --show <show-id> --delivery` では公開と配信の状態を確認できます。更新、削除、復旧、バックアップについては[運用ガイド（英語）](docs/operations.md)を参照してください。

## ドキュメント

- [導入手順書](docs/installation_ja.md) — 前提条件、Cloudflareの設定、最初のPodcastの公開。
- [デプロイと権限（英語）](docs/deployment.md) — 設定の詳細、認証情報の権限範囲、オプションのサービス。
- [運用ガイド（英語）](docs/operations.md) — メタデータ、公開、トラブルシューティング、データの保持。
- [独自ドメインへの移行と復元（英語）](docs/migration-and-restore.md)。
- [検証記録（英語）](docs/verification.md) — 実施済みのテストと残る制約。
- [MVP設計（英語）](docs/designs/castloop-mvp.md) — アーキテクチャと設計上の決定事項。

## 開発

[Bun](https://bun.sh/)をインストールし、次のコマンドを実行します。

```sh
bun install --frozen-lockfile
bun run build:cli
bun run test:domain
bun run test:cli
bun run test:workers
bun run typecheck
```

ビルドされたCLIは `dist/castloop` に作成されます。クロスコンパイルした配布用バイナリは、各プラットフォームで対応済みとする前に、そのプラットフォームの実機でテストする必要があります。

`v1.0.0` のような `v*` タグをpushすると、Linux x86-64、Windows x86-64、macOS arm64 の各環境でネイティブビルドを実行します。3つのバイナリでバージョン表示のスモークテストが通ると、GitHub Actionsがバイナリと `SHA256SUMS` を含むReleaseを作成します。
