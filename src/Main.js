/**
 * 時間主導トリガーから呼ばれるエントリポイント。
 * 失敗したときは Slack にエラーを通知したうえで例外を投げ直す（GAS の実行ログにも失敗として残す）。
 */
function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.warn('前回の実行がまだ終わっていないため、今回はスキップします。');
    return;
  }
  try {
    runInternal_();
    clearErrorMark_();
  } catch (e) {
    notifyError_(e);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function runInternal_() {
  const startedAt = Date.now();
  const timeUp = () => Date.now() - startedAt > CONFIG.MAX_RUNTIME_MS;
  const webhookUrl = getWebhookUrl_();
  const overlapMs = CONFIG.OVERLAP_MINUTES * 60 * 1000;

  // 持ち越しがあればその続きから、なければ新しい時間幅で取得する。
  let job = loadPending_();
  let tokenIsSaved = Boolean(job && job.token);
  if (!job) {
    const cursor = loadCursor_();
    const end = new Date(startedAt);
    const start = cursor
      ? new Date(cursor.getTime() - overlapMs)
      : new Date(end.getTime() - CONFIG.INITIAL_LOOKBACK_MINUTES * 60 * 1000);
    job = { start: start.toISOString(), end: end.toISOString(), idx: 0, token: null };
  }

  const seen = loadSeen_();
  let notified = 0;

  while (job.idx < CONFIG.EVENT_NAMES.length) {
    if (timeUp()) {
      savePending_(job);
      console.warn(`実行時間の上限が近いため打ち切りました。続きは次回に持ち越します（通知 ${notified} 件）。`);
      return;
    }

    let page;
    try {
      page = fetchActivitiesPage_(CONFIG.EVENT_NAMES[job.idx], job.start, job.end, job.token);
    } catch (e) {
      // 持ち越したページトークンが失効している場合に備え、そのイベント名の先頭から取り直す。
      // 通知済みのものは処理済み ID で除外される。
      if (tokenIsSaved) {
        console.warn(`保存済みページトークンでの取得に失敗したため先頭から取り直します: ${e}`);
        job.token = null;
        tokenIsSaved = false;
        continue;
      }
      throw e;
    }
    tokenIsSaved = false;

    let interrupted = false;
    try {
      outer: for (const activity of page.items || []) {
        for (const exposure of extractExposures_(activity)) {
          if (seen[exposure.key] !== undefined) continue;
          if (timeUp()) {
            interrupted = true;
            break outer;
          }
          postExposure_(webhookUrl, exposure);
          seen[exposure.key] = exposure.timeMs;
          notified++;
        }
      }
    } finally {
      // 途中で失敗しても、通知済みの分は必ず記録して二重通知を防ぐ。
      saveSeen_(seen);
    }

    if (interrupted) {
      // 同じページを次回もう一度取得する（通知済みは処理済み ID で除外）。
      savePending_(job);
      console.warn(`実行時間の上限が近いため打ち切りました。続きは次回に持ち越します（通知 ${notified} 件）。`);
      return;
    }

    if (page.nextPageToken) {
      job.token = page.nextPageToken;
    } else {
      job.idx++;
      job.token = null;
    }
    savePending_(job);
  }

  // 完了: 最終取得時刻を進め、次回の取得範囲より古い処理済み ID を捨てる。
  const newCursor = new Date(job.end);
  saveCursor_(newCursor);
  clearPending_();
  saveSeen_(pruneSeen_(seen, newCursor.getTime() - overlapMs));
  console.log(`完了: ${job.start} 〜 ${job.end}（通知 ${notified} 件）`);
}

/**
 * 状態（最終取得時刻・持ち越し・処理済み ID）をすべて消す。
 * 次回の実行は初回実行と同じ扱いになる。Slack Webhook URL は消さない。
 */
function resetState() {
  // 実行中の run が状態を書き戻さないよう、終わるのを待ってから消す。
  const lock = LockService.getScriptLock();
  lock.waitLock(6 * 60 * 1000);
  try {
    const props = PropertiesService.getScriptProperties();
    props.getKeys()
      .filter((k) => k.indexOf('STATE_') === 0)
      .forEach((k) => props.deleteProperty(k));
    console.log('状態をリセットしました。');
  } finally {
    lock.releaseLock();
  }
}

/** Slack への疎通確認用。ダミーの検知通知を 1 件送る。 */
function sendTestNotification() {
  postToSlack_(getWebhookUrl_(), buildExposureMessage_({
    key: 'test',
    timeMs: Date.now(),
    eventName: 'change_document_visibility',
    actor: 'tester@example.com',
    docId: 'TEST_DOC_ID',
    docTitle: '【テスト通知】これはテストです',
    docType: 'document',
    owner: 'owner@example.com',
    ownerIsSharedDrive: false,
    oldVisibility: 'private',
    newVisibility: 'people_with_link',
    target: '',
  }));
}
