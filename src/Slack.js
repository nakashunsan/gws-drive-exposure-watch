const VISIBILITY_LABELS = Object.freeze({
  people_with_link: 'リンクを知っている全員',
  public_on_the_web: 'ウェブ上で一般公開',
  shared_externally: '外部ユーザー・グループと共有',
  shared_internally: '組織内のユーザー・グループと共有',
  people_within_domain_with_link: '組織内でリンクを知っている全員',
  public_in_the_domain: '組織内で公開',
  private: '非公開',
  unknown: '不明',
});

function getWebhookUrl_() {
  const url = PropertiesService.getScriptProperties().getProperty(PROP.SLACK_WEBHOOK_URL);
  if (!url) {
    throw new Error(`スクリプト プロパティ ${PROP.SLACK_WEBHOOK_URL} が設定されていません。`);
  }
  return url;
}

/** Slack Incoming Webhook に送信する。429 のときは Retry-After に従って再試行する。 */
function postToSlack_(webhookUrl, message) {
  for (let attempt = 0; ; attempt++) {
    const res = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(message),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) return;
    if (code === 429 && attempt < CONFIG.SLACK_MAX_RETRIES) {
      const headers = res.getHeaders();
      const retryAfter = Number(headers['Retry-After'] || headers['retry-after']) || 1;
      Utilities.sleep(Math.min(retryAfter, 30) * 1000);
      continue;
    }
    const error = new Error(`Slack への送信に失敗しました（HTTP ${code}）: ${res.getContentText().slice(0, 200)}`);
    error.httpStatus = code;
    throw error;
  }
}

/**
 * 検知イベントを通知する。
 * Slack がメッセージの形式を理由に拒否した場合（HTTP 400）は、装飾なしのテキストで送り直す。
 * 1 件の表示崩れで以降の検知がすべて止まるのを防ぐため。
 */
function postExposure_(webhookUrl, x) {
  const message = buildExposureMessage_(x);
  try {
    postToSlack_(webhookUrl, message);
  } catch (e) {
    if (e.httpStatus !== 400) throw e;
    console.warn(`Block Kit での送信が拒否されたため、テキストのみで送り直します: ${e}`);
    postToSlack_(webhookUrl, {
      text: [
        message.text,
        'https://drive.google.com/open?id=' + encodeURIComponent(x.docId),
        `操作したユーザー: ${escapeMrkdwn_(x.actor || '不明')} ／ オーナー: ${escapeMrkdwn_(x.owner || '不明')}`,
        `変更前: ${x.oldVisibility || '不明'} → 変更後: ${x.newVisibility} ／ 発生時刻: ${formatTime_(x.timeMs)}`,
      ].join('\n'),
    });
  }
}

/** 検知イベントの通知メッセージ（Block Kit）を組み立てる。 */
function buildExposureMessage_(x) {
  const emoji = x.newVisibility === 'public_on_the_web' ? ':rotating_light:' : ':warning:';
  const kind = x.docType === 'folder' ? 'フォルダ' : 'ファイル';
  const title = truncate_(x.docTitle || '(名称不明)', 200);
  const url = 'https://drive.google.com/open?id=' + encodeURIComponent(x.docId);
  const summary = `Drive の${kind}が「${visibilityLabel_(x.newVisibility)}」に変更されました: ${escapeMrkdwn_(title)}`;

  const fields = [
    field_('種別', x.docType === 'folder' ? 'フォルダ' : `ファイル（${x.docType || '種類不明'}）`),
    field_('保存場所', x.ownerIsSharedDrive ? '共有ドライブ' : 'マイドライブ'),
    field_(x.ownerIsSharedDrive ? 'オーナー（共有ドライブ名）' : 'オーナー', x.owner || '不明'),
    field_('操作したユーザー', x.actor || '不明'),
    field_('変更前の公開範囲', x.oldVisibility ? visibilityLabel_(x.oldVisibility) : '不明'),
    field_('変更後の公開範囲', visibilityLabel_(x.newVisibility)),
    field_('発生時刻', formatTime_(x.timeMs)),
  ];
  if (x.target) fields.push(field_('共有先', x.target));

  return {
    text: summary,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: truncate_(`${emoji} Drive の公開範囲の変更を検知しました`, 150), emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*<${url}|${escapeMrkdwn_(title)}>*` },
      },
      { type: 'section', fields: fields },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `イベント: \`${x.eventName}\` ／ ファイル ID: \`${escapeMrkdwn_(x.docId)}\`` }],
      },
    ],
  };
}

/**
 * スクリプトのエラーを Slack に通知する。
 * エラーが続いている間は ERROR_NOTIFY_INTERVAL_MINUTES に 1 回だけ送る。
 * 通知自体の失敗は握りつぶしてログに残す（元のエラーを優先して投げ直すため）。
 */
function notifyError_(error) {
  try {
    const props = PropertiesService.getScriptProperties();
    const last = Number(props.getProperty(PROP.LAST_ERROR_NOTIFIED_AT)) || 0;
    if (Date.now() - last < CONFIG.ERROR_NOTIFY_INTERVAL_MINUTES * 60 * 1000) return;

    const detail = truncate_(String((error && error.stack) || error), 2500);
    postToSlack_(getWebhookUrl_(), {
      text: `gws-drive-exposure-watch でエラーが発生しました: ${escapeMrkdwn_(truncate_(String(error), 300))}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: ':x: gws-drive-exposure-watch でエラーが発生しました', emoji: true },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '```' + escapeMrkdwn_(detail) + '```' },
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `発生時刻: ${formatTime_(Date.now())} ／ 解消するまで検知は止まっています。` +
              `エラーが続く間、この通知は ${CONFIG.ERROR_NOTIFY_INTERVAL_MINUTES} 分に 1 回だけ送られます。`,
          }],
        },
      ],
    });
    props.setProperty(PROP.LAST_ERROR_NOTIFIED_AT, String(Date.now()));
  } catch (e) {
    console.error(`エラー通知の送信に失敗しました: ${e}`);
  }
}

/** 正常終了時にエラー通知の抑止を解除する（次のエラーはすぐ通知される）。 */
function clearErrorMark_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP.LAST_ERROR_NOTIFIED_AT)) {
    props.deleteProperty(PROP.LAST_ERROR_NOTIFIED_AT);
  }
}

function field_(label, value) {
  return { type: 'mrkdwn', text: `*${label}*\n${escapeMrkdwn_(truncate_(String(value), 300))}` };
}

function visibilityLabel_(v) {
  return VISIBILITY_LABELS[v] ? `${VISIBILITY_LABELS[v]}（${v}）` : v;
}

function escapeMrkdwn_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate_(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatTime_(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss (z)');
}
