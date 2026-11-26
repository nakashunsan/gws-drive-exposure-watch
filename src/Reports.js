/**
 * Admin SDK Reports API（applicationName=drive）から監査ログを 1 ページ取得する。
 */
function fetchActivitiesPage_(eventName, startIso, endIso, pageToken) {
  const args = {
    eventName: eventName,
    startTime: startIso,
    endTime: endIso,
    maxResults: CONFIG.PAGE_SIZE,
  };
  if (pageToken) args.pageToken = pageToken;
  return AdminReports.Activities.list('all', 'drive', args);
}

/**
 * 1 件のアクティビティから、通知対象のイベントを取り出す。
 * 条件: type=acl_change、対象イベント名、primary_event=true、
 *       visibility が対象値、かつ old_visibility から変化している。
 */
function extractExposures_(activity) {
  const id = activity.id || {};
  const timeMs = parseActivityTime_(id.time);
  const results = [];
  const docsInActivity = {};

  for (const ev of activity.events || []) {
    if (ev.type !== 'acl_change') continue;
    if (CONFIG.EVENT_NAMES.indexOf(ev.name) === -1) continue;

    const p = paramsToMap_(ev.parameters);
    if (p.primary_event !== true && p.primary_event !== 'true') continue;
    if (CONFIG.TARGET_VISIBILITIES.indexOf(p.visibility) === -1) continue;
    // old_visibility が無い場合は「変化した」とみなす（見逃しより誤検知を許容）。
    if (p.old_visibility === p.visibility) continue;

    // 1 回の操作で同じファイルに複数のイベントが出ても、通知は 1 件にまとめる。
    const docId = p.doc_id || '';
    if (docsInActivity[docId]) continue;
    docsInActivity[docId] = true;

    results.push({
      key: hashKey_([id.time, id.uniqueQualifier, docId].join('|')),
      timeMs: timeMs,
      eventName: ev.name,
      actor: (activity.actor && activity.actor.email) || '',
      docId: docId,
      docTitle: p.doc_title || '',
      docType: p.doc_type || '',
      owner: p.owner || '',
      ownerIsSharedDrive: p.owner_is_shared_drive === true || p.owner_is_shared_drive === 'true' || Boolean(p.shared_drive_id),
      oldVisibility: p.old_visibility || '',
      newVisibility: p.visibility,
      // target_domain は変更前の共有範囲のドメインが入ることがあり紛らわしいため、共有相手（target_user）だけを使う。
      target: p.target_user || '',
    });
  }
  return results;
}

/** events[].parameters[] を { name: 値 } に変換する。 */
function paramsToMap_(parameters) {
  const map = {};
  for (const p of parameters || []) {
    if (p.value !== undefined) map[p.name] = p.value;
    else if (p.boolValue !== undefined) map[p.name] = p.boolValue;
    else if (p.multiValue !== undefined) map[p.name] = p.multiValue;
    else if (p.intValue !== undefined) map[p.name] = p.intValue;
  }
  return map;
}

/** id.time（RFC 3339 文字列、またはエポック秒）をエポックミリ秒にする。 */
function parseActivityTime_(time) {
  const parsed = new Date(time).getTime();
  if (!isNaN(parsed)) return parsed;
  const seconds = Number(time);
  return isNaN(seconds) ? Date.now() : seconds * 1000;
}

/** 重複判定用のキーを短いハッシュにする（PropertiesService の容量節約）。 */
function hashKey_(raw) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return Utilities.base64EncodeWebSafe(digest).slice(0, 16);
}
