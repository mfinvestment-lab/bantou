// SORA（管理用）: 今は「受け取った内容をログに出す」だけ。
// ここに承認カード（機能2）・名簿通知・ダッシュボードを足していく。
import { sora, sourceIdOf } from "./line.js";

export async function handleSoraEvent(env, event) {
  const line = sora(env);
  const sourceId = sourceIdOf(event);
  const sourceType = event.source.groupId ? "group" : event.source.roomId ? "room" : "user";

  // 受信ログ（Observability → Logs で確認できる）
  console.log("SORA event", JSON.stringify({
    type: event.type,
    sourceType,
    sourceId,
    userId: event.source.userId || null,
    messageType: event.message?.type || null,
    text: event.message?.type === "text" ? event.message.text : null,
    timestamp: event.timestamp
  }));

  // グループに招待されたとき
  if (event.type === "join") {
    await line.push(sourceId, "SORAです。このグループでゲスト対応の承認カードをお届けします。\n（まだ準備中です）");
    return;
  }

  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();

  // 設定用コマンド
  if (text === "グループID教えて" || text === "ID教えて") {
    await line.reply(event.replyToken, `${sourceType} ID：\n${sourceId}\n\nあなたのuserId：\n${event.source.userId || "（取得不可）"}`);
    return;
  }
  if (text === "ping") {
    await line.reply(event.replyToken, "pong（SORA稼働中）");
    return;
  }
  // それ以外は何もしない（ログだけ）
}
