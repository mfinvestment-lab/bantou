// HARU の1対1チャット（リッチメニュー）用コマンド。清掃スタッフは個人チャットから物件を選んで開始・終了を押せる。
import { haru, sora } from "./line.js";
import { collectFacilityInfo } from "./cleaning.js";
import { todayCleaningStatus } from "./cleanlog.js";
import { formatDateYMD } from "./beds24.js";

const LOCATIONS = ["富士宮", "静岡"];
const FACILITY_LOC = { "サクヤ": "富士宮", "桜ハウス": "富士宮", "nel.shizuoka": "静岡" };
const qr = (label, text) => ({ type: "action", action: { type: "message", label: label.slice(0, 20), text } });
const qpb = (label, data) => ({ type: "action", action: { type: "postback", label: label.slice(0, 20), data, displayText: label } });
const hhmm = iso => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });

export const staff = {
  get: (kv, userId) => kv.get(`staff:${userId}`, "json"),
  set: (kv, userId, v) => kv.put(`staff:${userId}`, JSON.stringify(v)),
  async list(kv) {
    const l = await kv.list({ prefix: "staff:" });
    const out = [];
    for (const k of l.keys) { const v = await kv.get(k.name, "json"); if (v) out.push({ userId: k.name.slice(6), ...v }); }
    return out;
  }
};

const HELP = `HARU（清掃用）の使い方
・清掃開始／清掃終了：下のメニューから。物件を選ぶだけ
・清掃終了を押すと、当日チェックインのゲストがいる場合は「準備ができました」の案内が自動で送られます（15時より前の終了のみ）
・今日の予定：担当エリアの本日の清掃（人数・泊数）
・足りない物／棚卸：準備中
・在庫の発言（「サクヤ バスタオル 残り10」など）は今までどおり使えます
・担当エリアを変えるときは「登録」`;

/** 1対1の HARU テキストコマンド。処理したら true */
export async function handleHaruDirect(env, event) {
  if (event.source.groupId || event.source.roomId) return false; // グループは従来どおり（在庫BOT）
  const line = haru(env);
  const text = event.message.text.trim();
  const userId = event.source.userId;
  const me = await staff.get(env.KV, userId);
  const isOwner = userId === env.OWNER_USER_ID;

  if (text === "登録" || text === "担当登録") {
    await line.replyRaw(event.replyToken, [{ type: "text", text: "担当エリアを選んでください", quickReply: { items: LOCATIONS.map(l => qr(l, `登録 ${l}`)) } }]);
    return true;
  }
  if (/^登録\s+(富士宮|静岡)$/.test(text)) {
    const loc = text.split(/\s+/)[1];
    const name = (await line.memberName(null, userId)) || "スタッフ";
    await staff.set(env.KV, userId, { loc, name, at: new Date().toISOString() });
    await line.reply(event.replyToken, `✅ ${name}さんを「${loc}」担当で登録しました。下のメニューから清掃開始・終了を押せます。`);
    try { await sora(env).push(env.SORA_TARGET_ID || env.OWNER_USER_ID, `👤 HARU登録：${name}さん → ${loc}`); } catch {}
    return true;
  }
  if (text === "ヘルプ" || text === "help") { await line.reply(event.replyToken, HELP); return true; }

  const needReg = async () => { await line.replyRaw(event.replyToken, [{ type: "text", text: "はじめに担当エリアを登録してください。", quickReply: { items: LOCATIONS.map(l => qr(l, `登録 ${l}`)) } }]); };

  if (text === "清掃開始" || text === "清掃終了") {
    if (!me && !isOwner) { await needReg(); return true; }
    const act = text === "清掃開始" ? "cstart" : "cend";
    const today = formatDateYMD(new Date());
    const { info } = await collectFacilityInfo(env);
    const status = await todayCleaningStatus(env, today);
    const mine = Object.keys(FACILITY_LOC).filter(f => isOwner || FACILITY_LOC[f] === me.loc);
    const withCleaning = mine.filter(f => info[f]?.cleaning);
    const list = withCleaning.length ? withCleaning : mine; // 清掃予定が無い日でも押せるようにする（臨時清掃）
    const items = list.map(f => {
      const c = info[f]?.cleaning; const s = status[f];
      const label = `${f}${c ? ` ${c.count}名${c.nights}泊` : ""}${s?.endAt ? "（終了済）" : s?.startAt ? "（清掃中）" : ""}`;
      return qpb(label, `act=${act}&f=${encodeURIComponent(f)}&d=${today}`);
    });
    await line.replyRaw(event.replyToken, [{ type: "text", text: `${text}する物件を選んでください${withCleaning.length ? "" : "\n（本日の清掃予定はありません）"}`, quickReply: { items } }]);
    return true;
  }
  if (text === "今日の予定") {
    if (!me && !isOwner) { await needReg(); return true; }
    const today = formatDateYMD(new Date());
    const { info } = await collectFacilityInfo(env);
    const status = await todayCleaningStatus(env, today);
    const mine = Object.keys(FACILITY_LOC).filter(f => isOwner || FACILITY_LOC[f] === me.loc);
    const lines = mine.map(f => {
      const c = info[f]?.cleaning; const s = status[f];
      const st = s?.endAt ? `✅ ${hhmm(s.endAt)} 終了（${s.endBy}）` : s?.startAt ? `🧹 ${hhmm(s.startAt)}〜 清掃中（${s.startBy}）` : "";
      const sameDay = info[f]?.raw?.checkinsToday?.length ? "・当日イン" : "";
      return `${f}：${c ? `${c.count}名${c.nights}泊${sameDay}` : "清掃なし"}${st ? "\n　" + st : ""}`;
    });
    await line.reply(event.replyToken, `📅 ${today} の清掃\n${lines.join("\n")}`);
    return true;
  }
  if (text === "足りない物" || text === "棚卸") {
    await line.reply(event.replyToken, `「${text}」は準備中です。当面は今までどおりグループで知らせてください。`);
    return true;
  }
  return false;
}

/** 1対1での清掃ボタンは、登録済み担当エリアの物件だけ許可 */
export async function staffAllowed(env, userId, facility) {
  if (userId === env.OWNER_USER_ID) return true;
  const me = await staff.get(env.KV, userId);
  return !!me && FACILITY_LOC[facility] === me.loc;
}
