/**
 * PropertiesService に保存する状態の読み書き。
 * 保存するのは「最終取得時刻」「持ち越し中のジョブ」「重なり幅の期間内の処理済み ID」のみ。
 */

/** 1 プロパティあたりの文字数の目安（値の上限 9KB に対して余裕を持たせる）。 */
const SEEN_CHUNK_CHARS = 8000;

function props_() {
  return PropertiesService.getScriptProperties();
}

function loadCursor_() {
  const v = props_().getProperty(PROP.CURSOR);
  return v ? new Date(v) : null;
}

function saveCursor_(date) {
  props_().setProperty(PROP.CURSOR, date.toISOString());
}

function loadPending_() {
  const v = props_().getProperty(PROP.PENDING);
  return v ? JSON.parse(v) : null;
}

function savePending_(job) {
  props_().setProperty(PROP.PENDING, JSON.stringify(job));
}

function clearPending_() {
  props_().deleteProperty(PROP.PENDING);
}

/** 処理済み ID を { ハッシュ: イベント発生時刻(ms) } で返す。 */
function loadSeen_() {
  const all = props_().getProperties();
  const seen = {};
  Object.keys(all)
    .filter((k) => k.indexOf(PROP.SEEN_PREFIX) === 0)
    .forEach((k) => {
      all[k].split(',').forEach((entry) => {
        if (!entry) return;
        const parts = entry.split(':');
        seen[parts[0]] = parseInt(parts[1], 36);
      });
    });
  return seen;
}

/** 処理済み ID を複数のプロパティに分割して保存し、余った古い分割は削除する。 */
function saveSeen_(seen) {
  const props = props_();
  const chunks = [];
  let current = '';
  Object.keys(seen).forEach((key) => {
    const entry = key + ':' + seen[key].toString(36);
    if (current && current.length + entry.length + 1 > SEEN_CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    current += (current ? ',' : '') + entry;
  });
  if (current) chunks.push(current);

  const toSet = {};
  chunks.forEach((chunk, i) => {
    toSet[PROP.SEEN_PREFIX + i] = chunk;
  });
  if (chunks.length) props.setProperties(toSet);

  props.getKeys()
    .filter((k) => k.indexOf(PROP.SEEN_PREFIX) === 0 && !(k in toSet))
    .forEach((k) => props.deleteProperty(k));
}

/** 発生時刻が keepFromMs より古い処理済み ID を捨てる（次回の取得範囲に入らないため不要）。 */
function pruneSeen_(seen, keepFromMs) {
  const kept = {};
  Object.keys(seen).forEach((key) => {
    if (seen[key] >= keepFromMs) kept[key] = seen[key];
  });
  return kept;
}
