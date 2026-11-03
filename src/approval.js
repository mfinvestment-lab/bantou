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

  const rawThread = (await fetchThread(token, m.bookingId))
    .filter(t => t.id !== m.id)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));

  // OTA側で既に返信済み（このメッセージより後にホストの発言がある）なら何もしない
  if (rawThread.some(t => t.source === "host" && String(t.time) > String(m.time))) {
    await markMessageRead(token, m.id);
    return { id: m.id, skipped: "OTAで返信済み" };
  }
  const thread = rawThread.map(t => ({ from: t.source === "guest" ? "guest" : "host", text: t.message }));

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

  // 一言返しで済むもの（お礼・到着報告など）。同じ予約には48時間に1回まで（ラリー防止）
  // AUTO_ACK=on なら自動送信、それ以外は「一言返し」カードを出して人が［送信］を押す
  if (draft.needsReply === false && !draft.needsHuman) {
    const ackKey = `ack:${m.bookingId}`;
    const already = await env.KV.get(ackKey);
    if (already || !draft.reply) {
      await markMessageRead(token, m.id);
      return { id: m.id, skipped: "一言返し済み（48h以内）", category: draft.category };
    }
    if (env.AUTO_ACK === "on") {
      await sendGuestMessage(token, m.bookingId, draft.reply);
      await env.KV.put(ackKey, new Date().toISOString(), { expirationTtl: 60 * 60 * 48 });
      await markMessageRead(token, m.id);
      return { id: m.id, auto: `一言返し: ${draft.reply}`, category: draft.category, model: draft.model };
    }
    draft.ack = true; // カードに「一言返し案」と表示
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
  const row = (...btns) => ({ type: "box", layout: "horizontal", spacing: "sm", contents: btns });
  const buttons = d.needsHuman
    ? [row(postback("自分で書く", "write", "primary"), postback("対応済み", "done", "secondary"))]
    : [row(postback("送信", "approve", "primary"), postback("修正", "edit", "secondary")), row(postback("自分で書く", "write", "secondary"), postback("対応済み", "done", "secondary"))];

  const body = [
    txt(`${d.needsHuman ? "⚠️ " : d.ack ? "💬 " : ""}${card.property}｜${card.guest}様${d.ack ? "（一言返し案）" : ""}`, { weight: "bold", size: "md", color: d.needsHuman ? "#c0392b" : "#111111" }),
    txt(card.guestMessage, { color: "#555555" }),
    sep,
    txt(d.needsHuman ? `要確認：${d.reason}` : d.reply, { margin: "md" })
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
      ? `修正した文面を送ってください（日本語でOK）。\n\n${card.draft.reply}\n\n「キャンセル」で中止`
      : `${card.guest}様への返信を日本語で入力してください。\n「キャンセル」で中止`;
    await line.reply(event.replyToken, hint);
    return;
  }
  if (action === "dismiss" || action === "done") {
    card.status = "done";
    await cards.put(env.KV, cardId, card);
    const token = await getToken(env);
    await markMessageRead(token, card.messageId);
    await line.reply(event.replyToken, `対応済みにしました（${card.property} ${card.guest}様）`);
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
  await line.reply(event.replyToken, `✅ 送信しました（${card.property} ${card.guest}様）`);
  return true;
}

async function sendAndRecord(env, card, replyText, meta) {
  const token = await getToken(env);
  await sendGuestMessage(token, card.bookingId, replyText);
  await markMessageRead(token, card.messageId);
  card.status = "sent";
  card.sent = { text: replyText, at: new Date().toISOString(), ...meta };
  if (card.draft?.ack) await env.KV.put(`ack:${card.bookingId}`, new Date().toISOString(), { expirationTtl: 60 * 60 * 48 });
  await cards.put(env.KV, card.id, card);
  // 人が書いた／直した返信だけを学習例にする（AI案をそのまま送った場合は重複になるので保存しない）
  if (meta.how === "manual") await examples.add(env.KV, card.property, card.guestMessage, replyText, { channel: card.channel });
}
