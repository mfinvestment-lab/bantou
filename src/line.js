// LINE Messaging API の薄いラッパー。チャネルごとに token / secret を持つ。

export function createLineClient(accessToken, channelSecret) {
  if (!accessToken) throw new Error("LINE access token が未設定です");

  async function call(path, body) {
    const res = await fetch(`https://api.line.me/v2/bot${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LINE API ${path} 失敗 (status=${res.status}): ${text}`);
    }
  }

  return {
    reply: (replyToken, text) => call("/message/reply", { replyToken, messages: [{ type: "text", text }] }),
    replyMany: (replyToken, texts) =>
      call("/message/reply", { replyToken, messages: texts.slice(0, 5).map(text => ({ type: "text", text })) }),
    replyRaw: (replyToken, messages) => call("/message/reply", { replyToken, messages: messages.slice(0, 5) }),
    push: (to, text) => call("/message/push", { to, messages: [{ type: "text", text }] }),
    pushMessages: (to, messages) => call("/message/push", { to, messages: messages.slice(0, 5) }),

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

export function haru(env) {
  return createLineClient(env.HARU_CHANNEL_ACCESS_TOKEN, env.HARU_CHANNEL_SECRET);
}

export function sora(env) {
  return createLineClient(env.SORA_CHANNEL_ACCESS_TOKEN, env.SORA_CHANNEL_SECRET);
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
