/**
 * 設定値。運用に合わせて変更する場合はここだけを触る。
 */
const CONFIG = Object.freeze({
  /** トリガー間隔（分）。GAS の制約で 1 / 5 / 10 / 15 / 30 のいずれか。変更後は setupTrigger を再実行する。 */
  TRIGGER_INTERVAL_MINUTES: 10,

  /** 前回取得時刻からさかのぼって重ねて取得する幅（分）。監査ログの反映遅延対策。 */
  OVERLAP_MINUTES: 60,

  /** 初回実行時（状態が空のとき）にさかのぼる幅（分）。 */
  INITIAL_LOOKBACK_MINUTES: 60,

  /** 1 回の実行で使う時間の上限（ミリ秒）。GAS の 6 分上限より手前で打ち切り、続きは次回に持ち越す。 */
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,

  /** Reports API の 1 ページあたりの件数。 */
  PAGE_SIZE: 500,

  /** 通知対象とする変更後の公開範囲（visibility）。 */
  TARGET_VISIBILITIES: Object.freeze(['people_with_link', 'public_on_the_web', 'shared_externally']),

  /**
   * 取得するイベント名（type=acl_change のうち old_visibility を持ち、公開範囲が変わりうるもの）。
   * 出典: Drive Audit Activity Events
   * https://developers.google.com/workspace/admin/reports/v1/appendix/activity/drive
   */
  EVENT_NAMES: Object.freeze([
    'change_document_visibility', // リンク共有の公開範囲の変更
    'change_document_access_scope', // リンク共有のアクセス種別の変更
    'change_user_access', // ユーザー・グループへの共有権限の変更
  ]),

  /** 同じ状態でエラーが続くときの、エラー通知の最短間隔（分）。 */
  ERROR_NOTIFY_INTERVAL_MINUTES: 60,

  /** Slack が 429 を返したときの再試行回数。 */
  SLACK_MAX_RETRIES: 3,
});

/** スクリプト プロパティのキー。 */
const PROP = Object.freeze({
  /** Slack Incoming Webhook URL（手動で設定する）。 */
  SLACK_WEBHOOK_URL: 'SLACK_WEBHOOK_URL',
  /** 最終取得時刻（ISO 8601）。 */
  CURSOR: 'STATE_CURSOR',
  /** 持ち越し中の取得ジョブ（JSON）。 */
  PENDING: 'STATE_PENDING',
  /** 処理済み ID（分割保存。STATE_SEEN_0, STATE_SEEN_1, ...）。 */
  SEEN_PREFIX: 'STATE_SEEN_',
  /** 最後にエラー通知を送った時刻（エポックミリ秒）。 */
  LAST_ERROR_NOTIFIED_AT: 'STATE_LAST_ERROR_NOTIFIED_AT',
});
