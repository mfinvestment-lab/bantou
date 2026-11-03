// 清掃の開始・終了ボタン（HARU）と、終了時の当日インゲストへのアーリーチェックイン案内
import { BEDS24_PROPERTIES, getToken, getBookings, sendGuestMessage, formatDateYMD } from "./beds24.js";
import { haru, sora } from "./line.js";

// 物件ごとの設定：通常チェックイン時刻、どのグループから押せるか
const FACILITY = {
  "サクヤ":       { checkin: "16:00", groups: ["LINE_GROUP_FUJINOMIYA_WEEKDAY", "LINE_GROUP_FUJINOMIYA_HOLIDAY"] },
  "桜ハウス":     { checkin: "16:00", groups: ["LINE_GROUP_FUJINOMIYA_WEEKDAY", "LINE_GROUP_FUJINOMIYA_HOLIDAY"] },
  "nel.shizuoka": { checkin: "16:00", groups: ["LINE_GROUP_SHIZUOKA"] }
};
const EARLY_CUTOFF = "15:00";   // これより前に清掃が終わったときだけアーリーイン案内
const EARLY_OFFSET_MIN = 30;    // 終了から何分後に入れるか

const hhmm = d => d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
const key = (date, f) => `clean:${date}:${f}`;
const rec = {
  get: (kv, date, f) => kv.get(key(date, f), "json"),
  put: (kv, date, f, v) => kv.put(key(date, f), JSON.stringify(v), { expirationTtl: 60 * 60 * 24 * 90 })
};
const pb = (label, data, style = "secondary") => ({ type: "button", style, height: "sm", action: { type: "postback", label, data, displayText: label } });

/** 清掃通知に付けるボタン（物件ごとに1枚） */
export function cleaningButtonsMessage(date, facilities, { test = false } = {}) {
  const tq = test ? "&t=1" : "";
  const bubbles = facilities.map(({ name, text }) => ({
    type: "bubble", size: "kilo",
    body: { type: "box", layout: "vertical", spacing: "sm", contents: [
      { type: "text", text: name, weight: "bold", size: "md" },
      { type: "text", text, size: "sm", color: "#555555", wrap: true }
    ] },
    footer: { type: "box", layout: "horizontal", spacing: "sm", contents: [
      pb("清掃開始", `act=cstart&f=${encodeURIComponent(name)}&d=${date}${tq}`, "primary"),
      pb("清掃終了", `act=cend&f=${encodeURIComponent(name)}&d=${date}${tq}`)
    ] }
  }));
  return { type: "flex", altText: "清掃の開始・終了ボタン", contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles } };
}

function allowedGroup(env, facility, groupId) {
  const f = FACILITY[facility];
  if (!f) return false;
  if (!groupId) return true; // 個人チャット（管理者のテスト）は許可
  return f.groups.some(k => env[k] === groupId);
}

/** HARU の postback を処理。清掃ボタン以外なら false */
export async function handleCleaningPostback(env, event) {
  const params = new URLSearchParams(event.postback?.data || "");
  const act = params.get("act");
  if (!["cstart", "cend", "cendok", "cendno"].includes(act)) return false;
  const line = haru(env);
  const facility = decodeURIComponent(params.get("f") || "");
  const test = params.get("t") === "1";
  const date = (params.get("d") || formatDateYMD(new Date())) + (test ? ":test" : "");
  const groupId = event.source.groupId || null;
  const userId = event.source.userId;
  if (!allowedGroup(env, facility, groupId)) { await line.reply(event.replyToken, `${facility} のボタンはこのグループでは使えません。`); return true; }
  const now = new Date(); // 実時刻。表示は hhmm/formatDateYMD が日本時間に直す
  const who = (await line.memberName(groupId, userId)) || "スタッフ";
  const cur = (await rec.get(env.KV, date, facility)) || { facility, date };

  if (act === "cstart") {
    if (cur.endAt) { await line.reply(event.replyToken, `${facility} は本日 ${hhmm(new Date(cur.endAt))} に清掃終了済みです。`); return true; }
    if (cur.startAt) { await line.reply(event.replyToken, `${facility} は ${hhmm(new Date(cur.startAt))} に${cur.startBy}さんが開始済みです。`); return true; }
    cur.startAt = now.toISOString(); cur.startBy = who; cur.startUser = userId;
    await rec.put(env.KV, date, facility, cur);
    await line.reply(event.replyToken, `🧹 ${facility} 清掃開始 ${hhmm(now)}（${who}さん）`);
    return true;
  }
  if (act === "cend") {
    if (cur.endAt) { await line.reply(event.replyToken, `${facility} は ${hhmm(new Date(cur.endAt))} に終了済みです。`); return true; }
    await line.replyRaw(event.replyToken, [{
      type: "flex", altText: `${facility} 清掃終了の確認`,
      contents: { type: "bubble", size: "kilo",
        body: { type: "box", layout: "vertical", contents: [{ type: "text", text: `${facility} の清掃を終了にしますか？`, wrap: true, weight: "bold" }, { type: "text", text: "当日チェックインのゲストがいる場合、ゲストに「準備ができました」の案内が自動で送られます。", size: "xs", color: "#888888", wrap: true, margin: "sm" }] },
        footer: { type: "box", layout: "horizontal", spacing: "sm", contents: [
          pb("はい、終了", `act=cendok&f=${encodeURIComponent(facility)}&d=${params.get("d")}${test ? "&t=1" : ""}`, "primary"),
          pb("いいえ", `act=cendno&f=${encodeURIComponent(facility)}&d=${params.get("d")}${test ? "&t=1" : ""}`)
        ] } }
    }]);
    return true;
  }
  if (act === "cendno") { await line.reply(event.replyToken, "取り消しました。"); return true; }

  // cendok: 終了確定
  if (cur.endAt) { await line.reply(event.replyToken, `${facility} は ${hhmm(new Date(cur.endAt))} に終了済みです。`); return true; }
  cur.endAt = now.toISOString(); cur.endBy = who; cur.endUser = userId;
  if (!cur.startAt) cur.noStart = true;
  const dur = cur.startAt ? Math.round((now - new Date(cur.startAt)) / 60000) : null;
  await rec.put(env.KV, date, facility, cur);

  const early = await notifySameDayGuest(env, facility, params.get("d") || formatDateYMD(new Date()), now, cur, { test, recDate: date });
  const staffMsg = `${test ? "【テスト】" : ""}✅ ${facility} 清掃終了 ${hhmm(now)}（${who}さん${dur != null ? `・${dur}分` : ""}）` + (early.sent ? (test ? `\n（テストなので送信せず）当日イン ${early.guest}様 に送る文面：\n${early.results[0].preview}` : `\n当日インのゲストに「${early.time}からチェックインOK」を案内しました。`) : early.reason ? `\n（${early.reason}）` : "");
  await line.reply(event.replyToken, staffMsg);

  // 管理者（SORA）にも1行
  try {
    const target = env.SORA_TARGET_ID || env.OWNER_USER_ID;
    if (test) return true;
    const text = `🧹 ${facility} 清掃終了 ${hhmm(now)} ${who}さん${dur != null ? `（${dur}分）` : ""}` + (early.sent ? `\n→ ${early.guest}様（${early.channel}）にアーリーイン案内（${early.time}〜）を送信` : early.reason ? `\n→ ${early.reason}` : "");
    await sora(env).push(target, text);
  } catch (e) { console.error("SORA通知失敗", e.message); }
  return true;
}

/** 当日チェックインのゲストに「準備できました」を送る。15:00より前の終了のみ */
async function notifySameDayGuest(env, facility, date, now, cur, { test = false, recDate = date } = {}) {
  const f = FACILITY[facility];
  const p = BEDS24_PROPERTIES[facility];
  if (!f || !p) return { sent: false, reason: "物件設定なし" };
  const nowHm = hhmm(now);
  let arrivals;
  try {
    const token = await getToken(env);
    arrivals = (await getBookings(token, `propertyId=${p.propId}&arrivalFrom=${date}&arrivalTo=${date}&includeInfoItems=true`)).filter(b => b.status !== "cancelled");
    if (!arrivals.length) return { sent: false, reason: "当日インなし" };
    if (nowHm >= EARLY_CUTOFF) return { sent: false, reason: `${EARLY_CUTOFF}以降の終了のため案内なし（通常${f.checkin}〜）` };
    const t = new Date(now.getTime() + EARLY_OFFSET_MIN * 60000);
    t.setMinutes(Math.ceil(t.getMinutes() / 5) * 5, 0, 0);
    const time = hhmm(t);
    const results = [];
    for (const b of arrivals) {
      const done = (b.infoItems || []).some(i => /GUESTDONE/i.test(i.code || ""));
      const name = `${b.firstName || ""} ${b.lastName || ""}`.trim() || "ゲスト";
      const msg = done
        ? `${name} 様\n\nお部屋の清掃が完了しました。本日は ${time} からチェックインいただけます（通常は${f.checkin}〜）。\n入室方法は既にお送りしている当日のご案内をご確認ください。お気をつけてお越しください。`
        : `${name} 様\n\nお部屋の清掃が完了しました。本日は ${time} からチェックインいただけます（通常は${f.checkin}〜）。\n宿泊者名簿のご登録がまだのため、ご登録完了後に入室方法をお送りします。お気をつけてお越しください。`;
      const r = test ? null : await sendGuestMessage(token, b.id, msg);
      results.push({ bookingId: b.id, name, channel: b.channel || b.referer || "直予約", done, test, status: r?.[0]?.success ?? true, preview: test ? msg : undefined });
    }
    cur.early = { time, results, at: now.toISOString() };
    await rec.put(env.KV, recDate, facility, cur);
    const g = results[0];
    return { sent: true, time, guest: g.name, channel: g.channel, results, test };
  } catch (e) {
    console.error("early checkin notify error", e.message);
    return { sent: false, reason: `案内送信エラー: ${e.message.slice(0, 80)}` };
  }
}

/** 本日の清掃状況（ダッシュボード用） */
export async function todayCleaningStatus(env, date = formatDateYMD(new Date())) {
  const out = {};
  for (const f of Object.keys(FACILITY)) out[f] = (await rec.get(env.KV, date, f)) || null;
  return out;
}
