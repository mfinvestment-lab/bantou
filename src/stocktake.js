// 棚卸の依頼：前回の棚卸から14日たったら、朝の清掃通知に「棚卸のお願い」を付けて送る（同じpushに入れるので通数は増えない）
// 富士宮は平日チームと休日チームが交互に担当する：前回が平日チームなら、次は休日チームの日にだけ依頼を出す（12日目から）。
// サクヤと桜ハウスは担当チームを互い違いにする（毎回入れ替わるので、どちらのチームも両方の物件を同じ回数ずつ担当する）。
// 依頼はその物件の清掃がある日だけ出す。
//   ただし21日たっても済んでいなければ、どちらのチームの日でも依頼する。
import { formatDateYMD } from "./beds24.js";

export const STOCKTAKE_DAYS = 14, STOCKTAKE_FORCE_DAYS = 21;
// 富士宮は担当チームの日を待つので、12日目から依頼を出せるようにして平均14日前後にする
const FUJI_FROM = 12;
// 記録がない物件の起点。サクヤと桜ハウスは前回の担当チームを逆にしておく → 次の担当がいつも別チームになり、同じ日に依頼が重ならない
// 11/20：しばらく棚卸していないので今週から依頼を始める（起点を11/6に前倒し）。
//   桜ハウス→平日チーム（11/20・11/24の清掃）、サクヤ→休日チーム（11/22の清掃）、nel.→11/21以降の清掃
const SEED = { "サクヤ": { date: "2026-11-06", team: "weekday" }, "桜ハウス": { date: "2026-11-06", team: "holiday" }, "nel.shizuoka": { date: "2026-11-06", team: "weekday" } };
const AREA = { "サクヤ": "富士宮", "桜ハウス": "富士宮", "nel.shizuoka": "静岡" };
const KEY = f => `tana:last:${f}`;
const days = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
const md = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

export async function isOffDay(env, date) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6) return true;
  try {
    let h = env.KV && (await env.KV.get("linen:holidays", "json"));
    if (!h) { const r = await fetch("https://holidays-jp.github.io/api/v1/date.json"); h = r.ok ? await r.json() : {}; }
    return Object.prototype.hasOwnProperty.call(h, date);
  } catch { return false; }
}
const teamOf = async (env, date) => ((await isOffDay(env, date)) ? "holiday" : "weekday");
export const TEAM_LABEL = { weekday: "平日チーム", holiday: "休日チーム" };

/** 前回の棚卸（日付・チーム） */
export async function lastStocktake(env, f) {
  const v = await env.KV.get(KEY(f), "json");
  if (v) return v;
  // 以前の記録（tana:日付:物件）から探す
  const l = await env.KV.list({ prefix: "tana:20" });
  const dates = l.keys.map(k => k.name.split(":")).filter(p => p[2] === f).map(p => p[1]).sort();
  if (dates.length) { const date = dates.at(-1); return { date, team: await teamOf(env, date) }; }
  return { ...SEED[f], seed: true };
}

/** 棚卸を記録（liff.js の applyStockCount から呼ぶ） */
export async function recordStocktake(env, f, date = formatDateYMD(new Date())) {
  const team = await teamOf(env, date);
  const prev = (await env.KV.get(KEY(f), "json")) || {};
  const count = { weekday: 0, holiday: 0, ...(prev.count || {}) };
  if (prev.date !== date) count[team]++;
  await env.KV.put(KEY(f), JSON.stringify({ date, team, count }));
}

/** 今日このグループに棚卸を依頼する物件 */
export async function dueStocktakes(env, facilities, today, teamToday) {
  const out = [];
  for (const f of facilities) {
    const last = await lastStocktake(env, f);
    const d = days(last.date, today);
    if (AREA[f] === "富士宮") {
      if (d < FUJI_FROM) continue;
      if (last.team === teamToday && d < STOCKTAKE_FORCE_DAYS) continue; // 前回と同じチームの日は見送る（交互に担当）
    } else if (d < STOCKTAKE_DAYS) continue;
    out.push({ f, last: last.date, days: d });
  }
  return out;
}

/** 依頼カード（リネン入力の「棚卸」タブを開く） */
export function stocktakeRequestMessage(env, due, groupId) {
  const names = due.map(x => x.f).join("・");
  const q = new URLSearchParams({ m: "count" });
  if (groupId) q.set("g", groupId);
  if (due.length === 1) q.set("f", due[0].f);
  const detail = due.map(x => `${x.f}：前回 ${md(x.last)}（${x.days}日前）`).join("\n");
  return { type: "flex", altText: `棚卸のお願い：${names}`, contents: { type: "bubble", size: "kilo",
    header: { type: "box", layout: "vertical", backgroundColor: "#e67e22", paddingAll: "10px", contents: [{ type: "text", text: "📋 棚卸のお願い", color: "#ffffff", weight: "bold" }] },
    body: { type: "box", layout: "vertical", spacing: "sm", contents: [
      { type: "text", text: `今日の清掃のときに、${names}のリネンの枚数を数えて入力してください。`, wrap: true, size: "sm" },
      { type: "text", text: detail, wrap: true, size: "xs", color: "#888888" }
    ] },
    footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#e67e22", height: "sm", action: { type: "uri", label: "棚卸を入力", uri: `https://liff.line.me/${env.LIFF_ID}?${q}` } }] } } };
}

/** 状況（管理用） */
export async function stocktakeStatus(env, today = formatDateYMD(new Date())) {
  const out = {};
  for (const f of Object.keys(AREA)) { const l = await lastStocktake(env, f); out[f] = { ...l, teamLabel: TEAM_LABEL[l.team], daysAgo: days(l.date, today) }; }
  return out;
}

/**
 * SORAの「棚卸依頼」：今すぐ清掃グループに棚卸の依頼カードを送る（朝の通知を待たない）。
 * 物件を指定しなければ、今日清掃があって棚卸の時期が来ている物件。富士宮は今日のチーム（平日／休日）のグループへ。
 */
export async function sendStocktakeNow(env, names = []) {
  const { collectFacilityInfo } = await import("./cleaning.js");
  const { haru } = await import("./line.js");
  const today = formatDateYMD(new Date());
  const team = (await isOffDay(env, today)) ? "holiday" : "weekday";
  const { info } = await collectFacilityInfo(env);
  const pick = names.length ? names : Object.keys(AREA).filter(f => info[f]?.cleaning);
  const due = names.length
    ? await Promise.all(pick.map(async f => { const l = await lastStocktake(env, f); return { f, last: l.date, days: days(l.date, today) }; }))
    : await dueStocktakes(env, pick, today, team);
  const groups = { "富士宮": team === "holiday" ? env.LINE_GROUP_FUJINOMIYA_HOLIDAY : env.LINE_GROUP_FUJINOMIYA_WEEKDAY, "静岡": env.LINE_GROUP_SHIZUOKA };
  const sent = [];
  for (const area of ["富士宮", "静岡"]) {
    const d = due.filter(x => AREA[x.f] === area);
    if (!d.length) continue;
    await haru(env).pushMessages(groups[area], [stocktakeRequestMessage(env, d, groups[area])]);
    sent.push(`${area === "富士宮" ? `富士宮${TEAM_LABEL[team]}` : "静岡"}：${d.map(x => x.f).join("・")}`);
  }
  return sent;
}
