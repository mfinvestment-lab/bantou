// LINE Messaging API の薄いラッパー。チャネルごとに token / secret を持つ。

// 返信トークンごとに付けるクイックリプライ（清掃グループでの返信すべてに、キーボード上のボタンを出す）
const QR = new Map();
export function setQuickReply(replyToken, items) { if (!replyToken || !items?.length) return; if (QR.size > 300) QR.clear(); QR.set(replyToken, items); }
function withQR(body) {
  const items = body.replyToken && QR.get(body.replyToken);
  if (!items) return body;
  QR.delete(body.replyToken);
  const msgs = body.messages.slice();
  const last = msgs[msgs.length - 1];
  if (last && !last.quickReply) msgs[msgs.length - 1] = { ...last, quickReply: { items } };
  return { ...body, messages: msgs };
}

export function createLineClient(accessToken, channelSecret, { onPush } = {}) {
  if (!accessToken) throw new Error("LINE access token が未設定です");

  async function call(path, body) {
    if (path === "/message/reply") body = withQR(body);
    const res = await fetch(`https://api.line.me/v2/bot${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LINE API ${path} 失敗 (status=${res.status}): ${text}`);
    }
    if (path === "/message/push" && onPush) { try { await onPush(body); } catch {} }
  }

  return {
    reply: (replyToken, text) => call("/message/reply", { replyToken, messages: [{ type: "text", text }] }),
    replyMany: (replyToken, texts) =>
      call("/message/reply", { replyToken, messages: texts.slice(0, 5).map(text => ({ type: "text", text })) }),
    replyRaw: (replyToken, messages) => call("/message/reply", { replyToken, messages: messages.slice(0, 5) }),
    push: (to, text) => call("/message/push", { to, messages: [{ type: "text", text }] }),
    pushMessages: (to, messages) => call("/message/push", { to, messages: messages.slice(0, 5) }),
    // グループ内の発言者の表示名（取れなければ null）
    async memberName(groupId, userId) {
      try {
        const path = groupId ? `/group/${groupId}/member/${userId}` : `/profile/${userId}`;
        const res = await fetch(`https://api.line.me/v2/bot${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!res.ok) return null;
        return (await res.json()).displayName || null;
      } catch { return null; }
    },

    async verifySignature(body, signature) {
      if (!signature || !channelSecret) return false;
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", enc.encode(channelSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signed = await crypto.subtle.sign("HMAC", key, enc.encode(body));
      const expected = btoa(String.fromCharCode(...new Uint8Array(signed)));
      return expected === signature;
    }
  };
}

// push の記録（月ごと・用途ごとの通数を数える）。用途はメッセージ先頭から推定
const pushLabel = m => {
  const t = String(m?.altText || m?.text || m?.contents?.header?.contents?.[0]?.text || m?.type || "").replace(/\s+/g, " ").trim();
  const u = t.replace(/^[0-9０-９\/()（）月火水木金土日 ]+/, "");
  return u.replace(/[0-9０-９\/:：（）()]+.*$/, "").trim().slice(0, 14) || u.slice(0, 14) || "その他";
};
const pushLogger = (env, ch) => async body => {
  if (!env.KV) return;
  const ym = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
  const key = `pushlog:${ym}:${ch}`;
  const log = (await env.KV.get(key, "json")) || {};
  const to = String(body.to || "");
  const kind = to.startsWith("C") || to.startsWith("R") ? "グループ" : "1対1";
  const label = `${pushLabel(body.messages?.[0])}（${kind}）`;
  const n = (body.messages || []).length || 1;
  const e = log[label] ||= { pushes: 0, msgs: 0 };
  e.pushes++; e.msgs += n;
  await env.KV.put(key, JSON.stringify(log), { expirationTtl: 60 * 60 * 24 * 120 });
};

export function haru(env) {
  return createLineClient(env.HARU_CHANNEL_ACCESS_TOKEN, env.HARU_CHANNEL_SECRET, { onPush: pushLogger(env, "HARU") });
}

export function sora(env) {
  return createLineClient(env.SORA_CHANNEL_ACCESS_TOKEN, env.SORA_CHANNEL_SECRET, { onPush: pushLogger(env, "SORA") });
}

// Webhook共通: 署名検証 → 200即返し → 裏で処理
export async function handleWebhook(request, ctx, client, onEvent) {
  const body = await request.text();
  const signature = request.headers.get("x-line-signature");
  if (!(await client.verifySignature(body, signature))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const data = JSON.parse(body);
  ctx.waitUntil((async () => {
    for (const event of data.events || []) {
      try {
        await onEvent(event);
      } catch (err) {
        console.error("event処理エラー:", err.message, err.stack);
      }
    }
  })());
  return new Response("OK", { status: 200 });
}

export function sourceIdOf(event) {
  return event.source.groupId || event.source.roomId || event.source.userId;
}
