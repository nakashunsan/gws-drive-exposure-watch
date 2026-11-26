const TRIGGER_HANDLER = 'run';

/**
 * 定期実行トリガーを作成する。既存の同じトリガーは先に削除するので、何度実行しても 1 つだけになる。
 * 間隔（CONFIG.TRIGGER_INTERVAL_MINUTES）を変えたときも、これを再実行すればよい。
 */
function setupTrigger() {
  const allowed = [1, 5, 10, 15, 30];
  if (allowed.indexOf(CONFIG.TRIGGER_INTERVAL_MINUTES) === -1) {
    throw new Error(`TRIGGER_INTERVAL_MINUTES は ${allowed.join(' / ')} のいずれかにしてください。`);
  }
  getWebhookUrl_(); // 未設定のまま動かし始めないよう、ここで確認する。
  removeTrigger();
  ScriptApp.newTrigger(TRIGGER_HANDLER)
    .timeBased()
    .everyMinutes(CONFIG.TRIGGER_INTERVAL_MINUTES)
    .create();
  console.log(`${CONFIG.TRIGGER_INTERVAL_MINUTES} 分間隔のトリガーを作成しました。`);
}

/** このスクリプトの定期実行トリガーをすべて削除する。 */
function removeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === TRIGGER_HANDLER)
    .forEach((t) => ScriptApp.deleteTrigger(t));
}
