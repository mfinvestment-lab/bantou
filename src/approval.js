// 承認カード：Beds24の新着ゲストメッセージ → AIが返信案 → SORAでボタン承認 → Beds24経由でOTAへ返信
import { getToken, fetchUnreadGuestMessages, fetchThread, fetchBooking, sendGuestMessage, markMessageRead, fetchPropertyMap } from "./beds24.js";
import { draftReply } from "./claude.js";
import { sora } from "./line.js";
import { rules, faq, examples, cards, seen, props, normalizeProperty } from "./store.js";

// 返信不要の定型（AIに渡す前に落としてトークンを節約）
const NO_REPLY = /^(thank you|thanks|thx|ok|okay|great|perfect|got it|noted|ありがとう|ありがとうございます|了解|承知|わかりました|감사합니다|謝謝|谢谢|ขอบคุณ)[!.。！\s]*$/i;

function channelName(b) {
  const s = `${b.channel || b.referer || ""}`.toLowerCase();
  if (s.includes("airbnb")) return "Airbnb";
  if (s.includes("booking")) return "Booking.com";
  if (s.includes("vrbo") || s.includes("homeaway")) return "Vrbo";
  return b.channel || b.referer || "直予約";
}

async function propertyName(env, token, propertyId) {
  let map = await props.get(env.KV);
  if (!map || !map[String(propertyId)]) {
    map = await fetchPropertyMap(token);
    await props.set(env.KV, map);
  }
  return normalizeProperty(map[String(propertyId)] || String(propertyId));
}

// ---- 5分ごと：新着を取りに行く ----
export async function pollGuestMessages(env) {
  if (!env.KV) return { error: "KV未設定" };
  const token = await getToken(env);
  const msgs = await fetchUnreadGuestMessages(token);
  const results = [];
  for (const m of msgs) {
    if (await seen.has(env.KV, m.id)) continue;
    await seen.mark(env.KV, m.id);
    try {
      results.push(await handleGuestMessage(env, token, m));
    } catch (e) {
      console.error("承認カード作成エラー:", e.message, e.stack);
      results.push({ id: m.id, error: e.message });
      try { await sora(env).push(env.SORA_TARGET_ID || env.OWNER_USER_ID, `⚠️ 返信案の作成に失敗\n予約 ${m.bookingId}\n${e.message}`); } catch {}
    }
  }
  return { checked: msgs.length, results };
}

async function handleGuestMessage(env, token, m) {
  const text = (m.message || "").trim();
  const booking = await fetchBooking(token, m.bookingId);
  const property = booking ? await propertyName(env, token, booking.propertyId) : "不明";

  if (!text || NO_REPLY.test(text)) {
    await markMessageRead(token, m.id);
    return { id: m.id, skipped: "返信不要" };
  }

  const thread = (await fetchThread(token, m.bookingId))
    .filter(t => t.id !== m.id)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .map(t => ({ from: t.source === "guest" ? "guest" : "host", text: t.message }));

  const ctx = {
    property,
    rules: await rules.get(env.KV, property),
    faqs: await faq.list(env.KV, property),
    examples: (await examples.list(env.KV, property)).slice(0, 20),
    booking: booking ? { channel: channelName(booking), firstName: booking.firstName, lastName: booking.lastName, arrival: booking.arrival, departure: booking.departure, numAdult: booking.numAdult, numChild: booking.numChild, status: booking.status } : null,
    thread,
    guestMessage: text
  };
  const draft = await draftReply(env, ctx);

  // 返信不要（お礼・到着報告など）はカードを出さず既読にする
  if (draft.needsReply === false && !draft.needsHuman) {
    await markMessageRead(token, m.id);
    return { id: m.id, skipped: `返信不要(${draft.category})`, model: draft.model };
  }

  const cardId = `${m.bookingId}-${m.id}`;
  const card = {
    id: cardId, messageId: m.id, bookingId: m.bookingId, property,
    guest: `${booking?.firstName || ""} ${booking?.lastName || ""}`.trim() || "ゲスト",
    channel: ctx.booking?.channel || "-", stay: `${booking?.arrival || "?"}〜${booking?.departure || "?"}`,
    guestMessage: text, draft, status: "pending", createdAt: new Date().toISOString()
  };
  await cards.put(env.KV, cardId, card);
  await sora(env).pushMessages(env.SORA_TARGET_ID || env.OWNER_USER_ID, [buildCardMessage(card)]);
  return { id: m.id, cardId, category: draft.category, needsHuman: draft.needsHuman, model: draft.model };
}

// ---- LINE Flex カード ----
export function buildCardMessage(card) {
  const d = card.draft;
  const title = d.needsHuman ? "⚠️ 要確認（人が返信）" : (d.category === "complaint" ? "⚠️ クレーム" : "新着メッセージ");
  const txt = (t, opt = {}) => ({ type: "text", text: t || "-", wrap: true, size: "sm", ...opt });
  const sep = { type: "separator", margin: "md" };
  const postback = (label, action, style) => ({
    type: "button", style, height: "sm",
    action: { type: "postback", label, data: `card=${card.id}&action=${action}`, displayText: `${label}（${card.property} ${card.guest}様）` }
  });
  const buttons = d.needsHuman
    ? [postback("自分で書く", "write", "primary"), postback("対応しない", "dismiss", "secondary")]
    : [postback("このまま送信", "approve", "primary"), postback("修正して送信", "edit", "secondary"), postback("自分で書く", "write", "secondary")];

  const sameLang = d.reply && d.replyJa && d.reply.trim() === d.replyJa.trim();
  const body = [
    txt(title, { weight: "bold", size: "md", color: d.needsHuman ? "#c0392b" : "#111111" }),
    txt(`${card.property}｜${card.guest}様（${card.channel}）`, { weight: "bold" }),
    txt(`${card.stay}`, { size: "xs", color: "#888888" }),
    sep,
    txt("ゲストの原文", { size: "xs", color: "#888888", margin: "md" }),
    txt(card.guestMessage),
    sep,
    txt(d.needsHuman ? "AIの判断" : "返信案", { size: "xs", color: "#888888", margin: "md" }),
    txt(d.needsHuman ? d.reason : d.reply),
    ...(!d.needsHuman && !sameLang ? [txt(`（日本語訳）${d.replyJa}`, { size: "xs", color: "#555555" })] : []),
    ...(!d.needsHuman ? [txt(`根拠：${d.reason}`, { size: "xs", color: "#888888" })] : [])
  ];
  return {
    type: "flex",
    altText: `${title}: ${card.property} ${card.guest}様「${card.guestMessage.slice(0, 40)}」`,
    contents: {
      type: "bubble", size: "mega",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: buttons }
    }
  };
}

// ---- ボタン（postback）処理 ----
export async function handlePostback(env, event) {
  const line = sora(env);
  const params = new URLSearchParams(event.postback.data);
  const cardId = params.get("card");
  const action = params.get("action");
  const userId = event.source.userId;
  const card = await cards.get(env.KV, cardId);
  if (!card) { await line.reply(event.replyToken, "このカードは期限切れか、見つかりません。"); return; }
  if (card.status !== "pending") { await line.reply(event.replyToken, `このメッセージは対応済みです（${card.status}）。`); return; }

  if (action === "approve") {
    await sendAndRecord(env, card, card.draft.reply, { by: userId, how: "approve" });
    await line.reply(event.replyToken, `✅ 送信しました（${card.property} ${card.guest}様）`);
    return;
  }
  if (action === "edit" || action === "write") {
    await cards.awaiting.set(env.KV, userId, cardId);
    const hint = action === "edit"
      ? `返信案を修正して、そのまま送ってください。\n\n${card.draft.reply}\n\n（「キャンセル」で中止）`
      : `${card.guest}様への返信を入力してください。ゲストの言語（${card.channel}）で書くか、日本語で書けばAIが翻訳します。\n（「キャンセル」で中止）`;
    await line.reply(event.replyToken, hint);
    return;
  }
  if (action === "dismiss") {
    card.status = "dismissed";
    await cards.put(env.KV, cardId, card);
    const token = await getToken(env);
    await markMessageRead(token, card.messageId);
    await line.reply(event.replyToken, "対応しないとして閉じました。");
    return;
  }
}

// 「修正して送信」「自分で書く」のあとのテキスト入力
export async function handleAwaitingText(env, event) {
  const line = sora(env);
  const userId = event.source.userId;
  const cardId = await cards.awaiting.get(env.KV, userId);
  if (!cardId) return false;
  const text = event.message.text.trim();
  if (text === "キャンセル") {
    await cards.awaiting.clear(env.KV, userId);
    await line.reply(event.replyToken, "中止しました。カードのボタンからやり直せます。");
    return true;
  }
  const card = await cards.get(env.KV, cardId);
  if (!card || card.status !== "pending") {
    await cards.awaiting.clear(env.KV, userId);
    await line.reply(event.replyToken, "対象のカードが見つかりません。");
    return true;
  }
  await cards.awaiting.clear(env.KV, userId);
  await sendAndRecord(env, card, text, { by: userId, how: "manual" });
  await line.reply(event.replyToken, `✅ 送信し、学習例として保存しました（${card.property} ${card.guest}様）`);
  return true;
}

async function sendAndRecord(env, card, replyText, meta) {
  const token = await getToken(env);
  await sendGuestMessage(token, card.bookingId, replyText);
  await markMessageRead(token, card.messageId);
  card.status = "sent";
  card.sent = { text: replyText, at: new Date().toISOString(), ...meta };
  await cards.put(env.KV, card.id, card);
  // 人が書いた／直した返信だけを学習例にする（AI案をそのまま送った場合は重複になるので保存しない）
  if (meta.how === "manual") await examples.add(env.KV, card.property, card.guestMessage, replyText, { channel: card.channel });
}
