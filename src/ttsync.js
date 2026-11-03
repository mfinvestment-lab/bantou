// Beds24 の予約 → TimeTree 清掃カレンダーの差分同期（機能1）
// 番頭が作った予定は note に "#B<予約ID> <種別>" を持つ。それ以外（手入力）には触らない。
import { getToken, getBookings, BEDS24_PROPERTIES, nowJST, formatDateYMD, addDays } from "./beds24.js";
import { CALENDARS, ttListEvents, ttCreateAllDay, ttDeleteEvent } from "./timetree.js";
import { sora } from "./line.js";

// 物件ごとのカレンダー・タイトル・色ラベル（手入力の書き方に合わせる）
export const TT_PROPS = {
  "サクヤ":       { propId: BEDS24_PROPERTIES["サクヤ"].propId,       cal: CALENDARS.fujinomiya, clean: "SAKUYA",  sameDay: "SAKUYA当日イン",  stay: "サクヤ連泊中", labelClean: 9, labelStay: 10 },
  "桜ハウス":     { propId: BEDS24_PROPERTIES["桜ハウス"].propId,     cal: CALENDARS.fujinomiya, clean: "桜ハウス", sameDay: "桜ハウス当日イン", stay: "ハウス連泊中", labelClean: 7, labelStay: 4 },
  "nel.shizuoka": { propId: BEDS24_PROPERTIES["nel.shizuoka"].propId, cal: CALENDARS.shizuoka,   clean: "nel.",    sameDay: "nel.当日イン",    stay: "nel連泊中",   labelClean: 1, labelStay: 3 }
};
const TAG = /#B(\d+)\s+(clean|stay)\b/;
const HORIZON_DAYS = 120;      // 何日先まで同期するか
const PAST_GRACE_DAYS = 1;     // 過去は昨日まで見る（今日の削除漏れ対策）
const ymdOf = ms => new Date(ms).toISOString().slice(0, 10);
const shiftYmd = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** Beds24 の予約から「あるべき予定」を作る */
export async function buildDesired(env, token, propNames) {
  const today = nowJST();
  const from = formatDateYMD(addDays(today, -PAST_GRACE_DAYS));
  const to = formatDateYMD(addDays(today, HORIZON_DAYS));
  const desired = {}; // key -> {cal, title, startYmd, endYmd, labelId, note}
  const stats = {};
  for (const name of propNames) {
    const p = TT_PROPS[name];
    if (!p) continue;
    // 出発が from〜to の予約（到着が範囲内の予約も出発はそれ以降なので含まれる）
    const list = (await getBookings(token, `propertyId=${p.propId}&departureFrom=${from}&departureTo=${to}`))
      .filter(b => b.status !== "cancelled" && b.arrival && b.departure);
    const arrivals = new Set(list.map(b => b.arrival));
    stats[name] = list.length;
    for (const b of list) {
      const nights = Math.round((Date.parse(b.departure) - Date.parse(b.arrival)) / 86400000);
      const sameDay = arrivals.has(b.departure);
      desired[`${b.id}:clean`] = { cal: p.cal, title: sameDay ? p.sameDay : p.clean, startYmd: b.departure, endYmd: b.departure, labelId: p.labelClean, note: `#B${b.id} clean` };
      if (nights >= 2) {
        const s = shiftYmd(b.arrival, 1);
        const e = shiftYmd(b.departure, -1);
        desired[`${b.id}:stay`] = { cal: p.cal, title: p.stay, startYmd: s, endYmd: e, labelId: p.labelStay, note: `#B${b.id} stay` };
      }
    }
  }
  return { desired, stats, from, to };
}

/** 差分を計算して（apply なら）反映する。mode: "add"（追加のみ）| "full"（削除・変更も） */
export async function syncTimeTree(env, { props, mode = "add", apply = false } = {}) {
  const propNames = props || (env.TIMETREE_PROPS || "nel.shizuoka").split(",").map(s => s.trim()).filter(Boolean);
  const token = await getToken(env);
  const { desired, stats, from, to } = await buildDesired(env, token, propNames);
  const cals = [...new Set(propNames.map(n => TT_PROPS[n]?.cal).filter(Boolean))];

  const existing = {}; // key -> event
  for (const cal of cals) {
    for (const ev of await ttListEvents(env, cal)) {
      const m = TAG.exec(ev.note || "");
      if (!m) continue;
      if (ymdOf(ev.start_at) < from && ymdOf(ev.end_at) < from) continue; // 過去は触らない
      existing[`${m[1]}:${m[2]}`] = ev;
    }
  }
  // 対象物件の予定だけに絞る（別物件の予約IDは desired に無いので、削除対象から外す必要がある）
  const propCalOf = {}; for (const n of propNames) propCalOf[TT_PROPS[n].cal] = true;

  const plan = { create: [], delete: [], update: [], keep: 0 };
  for (const [key, d] of Object.entries(desired)) {
    const ev = existing[key];
    if (!ev) { plan.create.push({ key, ...d }); continue; }
    const same = ev.title === d.title && ymdOf(ev.start_at) === d.startYmd && ymdOf(ev.end_at) === d.endYmd && ev.label_id === d.labelId;
    if (same) plan.keep++;
    else plan.update.push({ key, old: { title: ev.title, start: ymdOf(ev.start_at), end: ymdOf(ev.end_at) }, ...d, eventId: ev.id });
  }
  for (const [key, ev] of Object.entries(existing)) {
    if (desired[key]) continue;
    // 対象物件のカレンダーにある番頭予定で、今回のあるべき予定に無い → 予約が消えた（キャンセル等）
    if (propCalOf[ev.calendar_id]) plan.delete.push({ key, cal: ev.calendar_id, title: ev.title, start: ymdOf(ev.start_at), eventId: ev.id });
  }
  // 「追加のみ」モードでは削除・変更をしない（並走期間）
  if (mode !== "full") { plan.skippedDelete = plan.delete.length; plan.skippedUpdate = plan.update.length; plan.delete = []; plan.update = []; }

  const result = { props: propNames, mode, apply, range: { from, to }, bookings: stats, counts: { create: plan.create.length, update: plan.update.length, delete: plan.delete.length, keep: plan.keep, skippedDelete: plan.skippedDelete || 0, skippedUpdate: plan.skippedUpdate || 0 }, errors: [] };
  if (!apply) { result.plan = plan; return result; }

  for (const d of plan.delete) {
    const r = await ttDeleteEvent(env, d.cal, d.eventId);
    if (r.status !== 200) result.errors.push({ op: "delete", key: d.key, status: r.status });
  }
  for (const u of plan.update) {
    const r1 = await ttDeleteEvent(env, u.cal, u.eventId);
    if (r1.status !== 200) { result.errors.push({ op: "update-delete", key: u.key, status: r1.status }); continue; }
    const r2 = await ttCreateAllDay(env, u.cal, u);
    if (r2.status !== 200) result.errors.push({ op: "update-create", key: u.key, status: r2.status });
  }
  for (const c of plan.create) {
    const r = await ttCreateAllDay(env, c.cal, c);
    if (r.status !== 200) result.errors.push({ op: "create", key: c.key, status: r.status, data: JSON.stringify(r.data).slice(0, 200) });
  }
  result.applied = { create: plan.create.map(c => `${c.title} ${c.startYmd}${c.endYmd !== c.startYmd ? "〜" + c.endYmd : ""}`), delete: plan.delete.map(d => `${d.title} ${d.start}`), update: plan.update.map(u => `${u.old.title} ${u.old.start} → ${u.title} ${u.startYmd}`) };
  return result;
}

/** 定期実行用：設定に従って同期し、失敗や変更をSORAに通知 */
export async function runTimeTreeSync(env) {
  const setting = (env.TIMETREE_SYNC || "off").toLowerCase(); // off | dry | add | full
  if (setting === "off") return { skipped: "TIMETREE_SYNC=off" };
  const line = sora(env);
  const target = env.SORA_TARGET_ID || env.OWNER_USER_ID;
  try {
    const r = await syncTimeTree(env, { mode: setting === "full" ? "full" : "add", apply: setting !== "dry" });
    const c = r.counts;
    const changed = c.create + c.update + c.delete;
    if (r.errors.length) {
      await line.push(target, `⚠️ TimeTree同期で${r.errors.length}件失敗しました（${setting}）。手動で確認してください。\n` + r.errors.slice(0, 5).map(e => `${e.op} ${e.key} ${e.status}`).join("\n"));
    } else if (changed > 0 && setting !== "dry") {
      const lines = [...(r.applied.create.map(s => "＋ " + s)), ...(r.applied.delete.map(s => "－ " + s)), ...(r.applied.update.map(s => "〜 " + s))].slice(0, 15).join("\n");
      await line.push(target, `📅 TimeTree同期：追加${c.create}・変更${c.update}・削除${c.delete}${c.skippedDelete ? `（削除候補${c.skippedDelete}件は追加のみモードのため未反映）` : ""}\n${lines}`);
    }
    return r;
  } catch (e) {
    console.error("TimeTree sync error", e.message);
    await line.push(target, `⚠️ TimeTree同期が失敗しました：${e.message.slice(0, 200)}\n今日の清掃予定は手動で確認してください。`);
    return { error: e.message };
  }
}
