# gws-drive-exposure-watch

Detects overly broad Google Drive sharing (link sharing, public, external) via Admin SDK Reports API and notifies Slack.

Google Workspace の Drive で、広い範囲に共有されたファイルやフォルダを監査ログから検知し、Slack に通知する Google Apps Script です。

## 検知対象

Drive の監査ログのうち、公開範囲（`visibility`）が次のいずれかに**変わった**イベントを通知します。

| visibility | 意味 |
| --- | --- |
| `people_with_link` | リンクを知っている全員 |
| `public_on_the_web` | ウェブ上で一般公開 |
| `shared_externally` | 外部ユーザー・グループとの共有 |

判定条件は次のとおりです（[Drive Audit Activity Events](https://developers.google.com/workspace/admin/reports/v1/appendix/activity/drive) に基づく）。

- イベント種別が `acl_change` で、イベント名が次のいずれか
  - `change_document_visibility`（リンク共有の公開範囲の変更）
  - `change_document_access_scope`（リンク共有のアクセス種別の変更）
  - `change_user_access`（ユーザー・グループへの共有権限の変更）
- `primary_event` が `true`（親フォルダからの継承などで派生した副次イベントは除外）
- `visibility`（変更後）が上の 3 つのいずれかで、`old_visibility`（変更前）と異なる

すでに外部共有されているファイルに外部ユーザーを追加した場合など、公開範囲が変わらない操作は通知しません。

### 検知しないケース

- **フォルダからの継承**: 公開されているフォルダへファイルを移動・新規作成して公開状態になった場合は、副次イベント扱い、またはイベント自体が出ないため通知しません。フォルダ自体の公開範囲を変えた操作は、フォルダに対する 1 件として通知します。
- **共有ドライブへの外部メンバー追加**: `shared_drive_membership_change` は対象外です。
- **反映が大きく遅れたイベント**: 監査ログへの反映が重なり幅（既定 60 分）より遅れたイベントは通知しません。

なお、「一般公開 → 外部共有のみ」のように範囲が狭まった場合でも、変更後が対象値であれば通知します。

## 仕組み

1. 時間主導トリガーが 10 分ごとに `run` を実行する
2. Admin SDK Reports API（`AdminReports` 拡張サービス、`applicationName=drive`）で監査ログを取得する
3. 条件に合うイベントを Slack Incoming Webhook で通知する

- **重複防止**: 監査ログは反映が遅れることがあるため、前回の取得時刻から 60 分さかのぼって重ねて取得します。通知済みのイベントは ID（`id.time`・`id.uniqueQualifier`・ファイル ID のハッシュ）で記録し、二重に通知しません。
- **状態の保存**: スクリプト プロパティに「最終取得時刻」「持ち越し中の取得位置」「重なり幅の期間内の処理済み ID」だけを保存します。期間外の ID は実行のたびに削除します。
- **実行時間の上限**: 4 分 30 秒を超えたら処理を打ち切り、取得位置（時間幅・ページトークン）を保存して次回の実行で続きから再開します。
- **エラー通知**: スクリプトが失敗すると Slack にエラーを通知します。エラーが続く間は 60 分に 1 回だけ通知します。

## 必要なもの

- Drive の監査ログを利用できる Google Workspace エディション（管理コンソールの［レポート］→［監査と調査］→［ドライブのログイベント］が見られること）
- 監査ログを読める管理者権限を持つ Google アカウント
- Slack の Incoming Webhook URL
- Node.js と [clasp](https://github.com/google/clasp)

## 実行アカウントについて（推奨）

スクリプトは、トリガーを作成したアカウントの権限で動きます。次の構成をおすすめします。

- **専用のアカウントで動かす**: 個人のアカウントで動かすと、担当者の異動や退職でトリガーが止まります。
- **権限は「レポート」のみにする**: このスクリプトに必要なのは監査ログの読み取りだけです。管理コンソールの［アカウント］→［管理者ロール］で、［レポート］権限だけを持つカスタムロールを作って割り当てると、特権管理者などの強いロールを使わずに済みます。

## セットアップ

スクリプトを動かすアカウントで行います。

### 1. clasp の準備とログイン

```sh
npm install -g @google/clasp
clasp login
```

ログインの前に、<https://script.google.com/home/usersettings> で Google Apps Script API をオンにしておきます。

### 2. Apps Script プロジェクトの作成と push

```sh
clasp create --type standalone --title "gws-drive-exposure-watch" --rootDir src
git restore src/appsscript.json   # clasp create が上書きした場合に元へ戻す
clasp push -f
```

`clasp create` はリポジトリ直下に `.clasp.json`（スクリプト ID と `rootDir`）を作ります。既存のプロジェクトを使う場合は、`.clasp.json` に `{"scriptId": "<スクリプト ID>", "rootDir": "src"}` を書いてから `clasp push -f` します。

`.clasp.json` と認証情報の `.clasprc.json` は、環境ごとに異なるため `.gitignore` で除外しています。

### 3. Slack App の作成と Webhook URL の取得

1. <https://api.slack.com/apps> →［Create New App］→［From a manifest］を選び、[`slack/manifest.yml`](slack/manifest.yml) の内容を貼り付けて作成する
2. ［Install to Workspace］でインストールし、通知先のチャンネルを選ぶ
3. ［Incoming Webhooks］に表示される Webhook URL を控える

App に付与する権限は `incoming-webhook`（選んだチャンネルへの投稿）だけです。

### 4. スクリプト プロパティの設定

スクリプト エディタ（`clasp open-script`）の［プロジェクトの設定］→［スクリプト プロパティ］に次を追加します。

| プロパティ | 値 |
| --- | --- |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook の URL |

Webhook URL はコードには書かず、ここから読み込みます。

### 5. 動作確認とトリガーの作成

スクリプト エディタで、次の関数を順に実行します。初回は権限の承認画面が出ます。

1. `sendTestNotification` … Slack にテスト通知が届くことを確認する
2. `run` … 監査ログの取得がエラーなく終わることを確認する
3. `setupTrigger` … 10 分間隔のトリガーを作成する

`setupTrigger` は既存のトリガーを消してから作り直すので、何度実行してもトリガーは 1 つだけです。止めるときは `removeTrigger` を実行します。

## 初回実行時の挙動

状態が空のとき（初回、またはリセット後）は、実行時刻の **60 分前から現在まで**の監査ログを対象にします。それより前の変更は通知されません。

## 状態のリセット

スクリプト エディタで `resetState` を実行すると、最終取得時刻・持ち越し位置・処理済み ID がすべて消え、次回の実行は初回実行と同じ扱いになります。`SLACK_WEBHOOK_URL` は消えません。

リセット後の最初の実行では、直近 60 分のうち通知済みだったイベントがもう一度通知されます。

## 設定値（`src/Config.js`）

| 定数 | 既定値 | 内容 |
| --- | --- | --- |
| `TRIGGER_INTERVAL_MINUTES` | 10 | トリガー間隔（分）。1 / 5 / 10 / 15 / 30 のいずれか。変更後は `setupTrigger` を再実行する |
| `OVERLAP_MINUTES` | 60 | 前回取得時刻からさかのぼって重ねる幅（分） |
| `INITIAL_LOOKBACK_MINUTES` | 60 | 初回実行時にさかのぼる幅（分） |
| `MAX_RUNTIME_MS` | 270000 | 1 回の実行を打ち切るまでの時間（ミリ秒） |
| `TARGET_VISIBILITIES` | 上記 3 値 | 通知対象とする変更後の公開範囲 |
| `ERROR_NOTIFY_INTERVAL_MINUTES` | 60 | エラーが続くときのエラー通知の最短間隔（分） |

通知の時刻表示は `src/appsscript.json` の `timeZone`（既定は `Asia/Tokyo`）に従います。通知の文面は日本語です。

## 使用する OAuth スコープ

| スコープ | 用途 |
| --- | --- |
| `https://www.googleapis.com/auth/admin.reports.audit.readonly` | 監査ログの読み取り |
| `https://www.googleapis.com/auth/script.external_request` | Slack への送信 |
| `https://www.googleapis.com/auth/script.scriptapp` | トリガーの作成・削除 |

## 通知内容

ファイル名（Drive へのリンク付き）、フォルダかファイルか、マイドライブか共有ドライブか、オーナー、操作したユーザー、変更前後の公開範囲、発生時刻、共有先（記録されている場合）を Block Kit で表示します。共有ドライブ上のアイテムでは、オーナー欄は共有ドライブ名になります。

通知にはファイル名やメールアドレスが含まれるため、通知先は閲覧できる人が限られたチャンネルにすることをおすすめします。

## 注意事項

- Google および Slack の公式ツールではありません。
- 検知の補助を目的としたもので、すべての共有を漏れなく検知することは保証しません（「検知しないケース」を参照）。

## ライセンス

[MIT License](LICENSE)
