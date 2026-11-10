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
const EARLY_FROM = "09:00";     // 早朝・深夜の誤操作で案内しない
const EARLY_OFFSET_MIN = 30;    // 終了から何分後に入れるか

const hhmm = d => d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
const key = (date, f) => `clean:${date}:${f}`;
const rec = {
  get: (kv, date, f) => kv.get(key(date, f), "json"),
  put: (kv, date, f, v) => kv.put(key(date, f), JSON.stringify(v), { expirationTtl: 60 * 60 * 24 * 90 })
};
const pb = (label, data, style = "secondary") => ({ type: "button", style, height: "sm", action: { type: "postback", label, data, displayText: label } });

/** 清掃通知（画面案③）：1枚のカードに「本日の清掃」＋物件ごとの行（アウト→次の到着、人数、リネン目安）＋開始/終了ボタン */
export function cleaningButtonsMessage(date, facilities, { test = false, liffId = null, groupId = null } = {}) {
  const tq = test ? "&t=1" : "";
  const DOW = ["日", "月", "火", "水", "木", "金", "土"];
  const [y, m, d] = date.split("-").map(Number);
  const title = `本日の清掃 ${m}/${d}（${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
  const txt = (t, opt = {}) => ({ type: "text", text: t || "-", wrap: true, size: "sm", ...opt });
  const sections = [];
  facilities.forEach((f, i) => {
    if (i > 0) sections.push({ type: "separator", margin: "md" });
    const lines = [txt(f.name, { weight: "bold", size: "md", margin: i > 0 ? "md" : "none" })];
    if (f.text) lines.push(txt(f.text, { color: "#6b6b6b" }));
    if (f.linen) lines.push(txt(f.linen, { color: "#6b6b6b", size: "xs" }));
    // ①開始 → ②リネン入力 → ③終了 の順に押す。すべてボタンへの返信なので通数を使わない
    const q = new URLSearchParams({ f: f.name }); if (groupId) q.set("g", groupId);
    // 3つ横並びだと文字が切れるため、真ん中を広くし、はみ出すときは文字を縮める
    const fit = b => ({ ...b, adjustMode: "shrink-to-fit" });
    const linenBtn = liffId ? [fit({ type: "button", style: "secondary", height: "sm", flex: 4, action: { type: "uri", label: "②リネン入力", uri: `https://liff.line.me/${liffId}?${q}` } })] : [];
    lines.push({ type: "box", layout: "horizontal", spacing: "xs", margin: "sm", contents: [
      fit({ ...pb(liffId ? "①開始" : "清掃開始", `act=cstart&f=${encodeURIComponent(f.name)}&d=${date}${tq}`, "primary"), flex: 3 }),
      ...linenBtn,
      fit({ ...pb(liffId ? "③終了" : "清掃終了", `act=cend&f=${encodeURIComponent(f.name)}&d=${date}${tq}`), flex: 3 })
    ] });
    sections.push(...lines);
  });
  return { type: "flex", altText: `${title}：${facilities.map(f => f.name).join("・")}`, contents: {
    type: "bubble", size: "giga",
    header: { type: "box", layout: "vertical", backgroundColor: "#1a1a1a", paddingAll: "12px", contents: [{ type: "text", text: title, color: "#ffffff", weight: "bold", size: "md" }] },
    body: { type: "box", layout: "vertical", spacing: "xs", contents: sections }
  } };
}

async function allowedGroup(env, facility, groupId, userId) {
  const f = FACILITY[facility];
  if (!f) return false;
  if (!groupId) { const { staffAllowed } = await import("./harucmd.js"); return staffAllowed(env, userId, facility); } // 個人チャットは担当エリアで判定
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
  if (!(await allowedGroup(env, facility, groupId, userId))) { await line.reply(event.replyToken, groupId ? `${facility} のボタンはこのグループでは使えません。` : `${facility} はあなたの担当エリアではありません。担当を変えるには「登録」と送ってください。`); return true; }
  const now = new Date(); // 実時刻。表示は hhmm/formatDateYMD が日本時間に直す
  const who = (await line.memberName(groupId, userId)) || "スタッフ";
  const cur = (await rec.get(env.KV, date, facility)) || { facility, date };

  if (act === "cstart") {
    if (cur.endAt) { await line.reply(event.replyToken, `${facility} は本日 ${hhmm(new Date(cur.endAt))} に清掃終了済みです。`); return true; }
    if (cur.startAt) { await line.reply(event.replyToken, `${facility} は ${hhmm(new Date(cur.startAt))} に${cur.startBy}さんが開始済みです。`); return true; }
    cur.startAt = now.toISOString(); cur.startBy = who; cur.startUser = userId;
    await rec.put(env.KV, date, facility, cur);
    // 1時間後の通知は LINEN_PROMPT_PUSH=on のときだけ（グループ宛ては人数分の通数になるため）
    await line.reply(event.replyToken, `🧹 ${facility} 清掃開始 ${hhmm(now)}（${who}さん）\n終わりに近づいたら「②リネン入力」で使った枚数を入力してください。`);
    if (env.LINEN_PROMPT_PUSH === "on" && !test && groupId) {
      await env.KV.put(`linenprompt:${params.get("d")}:${facility}`, JSON.stringify({ groupId, due: now.getTime() + 60 * 60000 }), { expirationTtl: 60 * 60 * 12 });
    }
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
    if (nowHm < EARLY_FROM) return { sent: false, reason: `${EARLY_FROM}より前の終了のため案内なし` };
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

/** リネン入力画面を開くボタン（g＝グループIDで表示する物件を絞る、f＝最初に選ぶ物件） */
export function linenInputButton(env, facility, groupId, note) {
  // facility を渡すと画面がその物件に固定される。null なら画面で物件を選ぶ
  const q = new URLSearchParams(); if (facility) q.set("f", facility); if (groupId) q.set("g", groupId);
  return { type: "flex", altText: `${facility || ""} リネン入力`, contents: { type: "bubble", size: "kilo",
    body: { type: "box", layout: "vertical", contents: [{ type: "text", text: `${facility ? facility + " " : ""}リネン入力`, weight: "bold" }, { type: "text", text: note, size: "sm", color: "#666666", wrap: true, margin: "sm" }] },
    footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", height: "sm", action: { type: "uri", label: "リネン入力を開く", uri: `https://liff.line.me/${env.LIFF_ID}?${q}` } }] } } };
}
/** 清掃終了ボタンだけのカード（リネン入力のあとに出す） */
export function cleanEndButton(facility, date, note = "清掃が終わったら押してください。") {
  return { type: "flex", altText: `${facility} 清掃終了`, contents: { type: "bubble", size: "kilo",
    body: { type: "box", layout: "vertical", contents: [{ type: "text", text: note, size: "sm", wrap: true }] },
    footer: { type: "box", layout: "vertical", contents: [pb("清掃終了", `act=cend&f=${encodeURIComponent(facility)}&d=${date}`, "primary")] } } };
}
/** 5分ごと：清掃開始から1時間たって、まだリネン入力も終了もしていなければリネン入力ボタンを送る（LINEN_PROMPT_PUSH=on のとき） */
export async function runLinenPrompts(env) {
  if (env.LINEN_PROMPT_PUSH !== "on" || !env.KV) return;
  const l = await env.KV.list({ prefix: "linenprompt:" });
  for (const k of l.keys) {
    const v = await env.KV.get(k.name, "json"); if (!v || v.due > Date.now()) continue;
    await env.KV.delete(k.name);
    const [, date, facility] = k.name.split(":");
    const cur = await rec.get(env.KV, date, facility);
    if (cur?.endAt) continue;
    if (await env.KV.get(`linenuse:${date}:${facility}`)) continue;
    try { await haru(env).pushMessages(v.groupId, [linenInputButton(env, facility, v.groupId, "清掃開始から1時間たちました。使ったリネンの枚数を入力してください。")]); } catch (e) { console.error("linen prompt", e.message); }
  }
}
