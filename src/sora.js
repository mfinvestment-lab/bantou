// SORA（管理用）: 承認カードのボタン処理と、FAQ・ルール・学習例の登録コマンド
import { sora, sourceIdOf } from "./line.js";
import { rules, faq, examples, normalizeProperty } from "./store.js";
import { handlePostback, handleAwaitingText, pollGuestMessages } from "./approval.js";

const PROPERTIES = ["サクヤ", "桜ハウス", "nel.shizuoka"];
const qr = (label, text) => ({ type: "action", action: { type: "message", label, text } });
const MENU = {
  type: "text",
  text: "ボタンを押すか、コマンドを送ってください。\n入力が必要なもの：\nFAQ追加 物件名（改行）Q: 質問（改行）A: 答え\nルール設定 物件名（改行）ルール本文\nFAQ削除 物件名 番号 ／ 学習削除 物件名 番号",
  quickReply: { items: [
    qr("新着確認", "新着確認"),
    ...PROPERTIES.map(p => qr(`FAQ ${p}`, `FAQ一覧 ${p}`)),
    ...PROPERTIES.map(p => qr(`学習 ${p}`, `学習一覧 ${p}`)),
    ...PROPERTIES.map(p => qr(`ルール ${p}`, `ルール表示 ${p}`))
  ].slice(0, 13) }
};
const withMenu = text => ({ type: "text", text, quickReply: MENU.quickReply });
const pickProperty = (cmd, label) => ({
  type: "text", text: `${label}する物件を選んでください`,
  quickReply: { items: PROPERTIES.map(p => qr(p, `${cmd} ${p}`)) }
});
// FAQ追加の対話状態（userId → 物件名）
const faqMode = {
  get: (kv, u) => kv.get(`mode:faqadd:${u}`),
  set: (kv, u, p) => kv.put(`mode:faqadd:${u}`, p, { expirationTtl: 600 }),
  clear: (kv, u) => kv.delete(`mode:faqadd:${u}`)
};

export async function handleSoraEvent(env, event) {
  const line = sora(env);
  const sourceId = sourceIdOf(event);
  const sourceType = event.source.groupId ? "group" : event.source.roomId ? "room" : "user";

  console.log("SORA event", JSON.stringify({ type: event.type, sourceType, sourceId, userId: event.source.userId || null, messageType: event.message?.type || null, text: event.message?.type === "text" ? event.message.text : null }));

  if (event.type === "join") {
    await line.push(sourceId, "SORAです。このグループでゲスト対応の承認カードをお届けします。「ヘルプ」でコマンド一覧。");
    return;
  }
  if (event.type === "postback") { await handlePostback(env, event); return; }
  if (event.type !== "message" || event.message.type !== "text") return;

  // 修正・自分で書く の入力待ちなら、それを優先
  if (env.KV && (await handleAwaitingText(env, event))) return;

  const text = event.message.text.trim();
  const [head, ...restLines] = text.split("\n");
  const [cmd, ...args] = head.trim().split(/\s+/);
  const userId = event.source.userId;

  try {
    // FAQ追加の入力待ち
    if (env.KV && userId) {
      const p = await faqMode.get(env.KV, userId);
      if (p && !/^(FAQ|ルール|学習|新着|ヘルプ|メニュー|ID|ping|キャンセル)/i.test(text)) {
        const q = (text.match(/Q[:：]\s*([\s\S]*?)(?=\nA[:：]|$)/) || [])[1]?.trim();
        const a = (text.match(/A[:：]\s*([\s\S]*)$/) || [])[1]?.trim();
        if (!q || !a) { await line.reply(event.replyToken, `${p} のFAQを追加します。次の形で送ってください：\nQ: 質問\nA: 答え\n\n「キャンセル」で中止`); return; }
        await faqMode.clear(env.KV, userId);
        const n = await faq.add(env.KV, p, q, a);
        await line.replyRaw(event.replyToken, [withMenu(`✅ ${p} のFAQに追加しました（${n}件目）\nQ: ${q}\nA: ${a}`)]);
        return;
      }
      if (p && text === "キャンセル") { await faqMode.clear(env.KV, userId); await line.reply(event.replyToken, "FAQ追加を中止しました。"); return; }
    }

    // 物件名なしのコマンドは物件選択ボタンを出す
    if (["FAQ一覧", "FAQ追加", "ルール表示", "学習一覧"].includes(cmd) && args.length === 0 && restLines.length === 0) {
      await line.replyRaw(event.replyToken, [pickProperty(cmd, cmd)]);
      return;
    }
    if (cmd === "FAQ追加" && args[0] && restLines.length === 0) {
      const p = normalizeProperty(args[0]);
      await faqMode.set(env.KV, userId, p);
      await line.reply(event.replyToken, `${p} のFAQを追加します。次の形で送ってください：\nQ: 質問\nA: 答え\n\n「キャンセル」で中止`);
      return;
    }
    if (text === "ID教えて" || text === "グループID教えて") {
      await line.reply(event.replyToken, `${sourceType} ID：\n${sourceId}\n\nあなたのuserId：\n${event.source.userId || "（取得不可）"}`);
      return;
    }
    if (text === "ping") { await line.reply(event.replyToken, "pong（SORA稼働中）"); return; }
    if (text === "ヘルプ" || text === "help" || text === "メニュー") { await line.replyRaw(event.replyToken, [MENU]); return; }
    if (!env.KV) { if (/^(FAQ|ルール|学習|新着)/.test(cmd)) await line.reply(event.replyToken, "KVが未設定のため、登録機能はまだ使えません。"); return; }

    if (cmd === "新着確認") {
      const r = await pollGuestMessages(env);
      const rs = r.results || [];
      const n = { card: rs.filter(x => x.cardId).length, auto: rs.filter(x => x.auto).length, skip: rs.filter(x => x.skipped).length, err: rs.filter(x => x.error).length };
      const lines = rs.map(x => x.cardId ? `📩 カード: ${x.category}` : x.auto ? `💬 ${x.auto}` : x.skipped ? `✔ ${x.skipped}` : `⚠️ ${x.error}`).slice(0, 10).join("\n");
      await line.replyRaw(event.replyToken, [withMenu(`未読 ${r.checked ?? 0} 件（カード${n.card}・一言返し${n.auto}・不要${n.skip}${n.err ? `・エラー${n.err}` : ""}）${lines ? "\n" + lines : ""}`)]);
      return;
    }

    if (cmd === "FAQ追加") {
      const p = normalizeProperty(args[0]);
      const body = restLines.join("\n");
      const q = (body.match(/Q[:：]\s*([\s\S]*?)(?=\nA[:：]|$)/) || [])[1]?.trim();
      const a = (body.match(/A[:：]\s*([\s\S]*)$/) || [])[1]?.trim();
      if (!p || !q || !a) { await line.reply(event.replyToken, "形式：\nFAQ追加 物件名\nQ: 質問\nA: 答え"); return; }
      const n = await faq.add(env.KV, p, q, a);
      await line.reply(event.replyToken, `✅ ${p} のFAQに追加しました（${n}件目）\nQ: ${q}\nA: ${a}`);
      return;
    }
    if (cmd === "FAQ一覧") {
      const p = normalizeProperty(args[0]);
      const list = await faq.list(env.KV, p);
      await line.reply(event.replyToken, list.length ? `📋 ${p} のFAQ（${list.length}件）\n` + list.map((f, i) => `${i + 1}. Q: ${f.q}\n   A: ${f.a}`).join("\n").slice(0, 4500) : `${p} のFAQはまだありません。`);
      return;
    }
    if (cmd === "FAQ削除") {
      const p = normalizeProperty(args[0]); const n = parseInt(args[1]);
      if (!p || !n) { await line.reply(event.replyToken, "形式：FAQ削除 物件名 番号"); return; }
      const r = await faq.remove(env.KV, p, n);
      await line.reply(event.replyToken, r ? `🗑 削除しました\nQ: ${r.q}` : "その番号はありません。");
      return;
    }
    if (cmd === "ルール設定") {
      const p = normalizeProperty(args[0]); const body = restLines.join("\n").trim();
      if (!p || !body) { await line.reply(event.replyToken, "形式：\nルール設定 物件名\nルール本文（複数行可）"); return; }
      await rules.set(env.KV, p, body);
      await line.reply(event.replyToken, `✅ ${p} の返信ルールを更新しました（${body.length}文字）`);
      return;
    }
    if (cmd === "ルール表示") {
      const p = normalizeProperty(args[0]);
      const r = await rules.get(env.KV, p);
      await line.reply(event.replyToken, r ? `📄 ${p} の返信ルール\n${r}`.slice(0, 4500) : `${p} のルールは未設定です。`);
      return;
    }
    if (cmd === "学習一覧") {
      const p = normalizeProperty(args[0]);
      const list = await examples.list(env.KV, p);
      await line.reply(event.replyToken, list.length ? `🧠 ${p} の学習例（${list.length}件・新しい順）\n` + list.slice(0, 15).map((e, i) => `${i + 1}. ${e.q.slice(0, 40)}\n   → ${e.a.slice(0, 60)}`).join("\n").slice(0, 4500) : `${p} の学習例はまだありません。`);
      return;
    }
    if (cmd === "学習削除") {
      const p = normalizeProperty(args[0]); const n = parseInt(args[1]);
      if (!p || !n) { await line.reply(event.replyToken, "形式：学習削除 物件名 番号"); return; }
      const r = await examples.remove(env.KV, p, n);
      await line.reply(event.replyToken, r ? `🗑 削除しました\n${r.q.slice(0, 60)}` : "その番号はありません。");
      return;
    }
    // それ以外は無視（ログのみ）
  } catch (e) {
    console.error("SORAコマンドエラー:", e.message, e.stack);
    try { await line.reply(event.replyToken, `エラー: ${e.message}`); } catch {}
  }
}
