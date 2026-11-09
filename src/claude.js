// Claude API（返信案の生成）。トークン節約のため Haiku を既定にし、自信がないときだけ Sonnet。
const API = "https://api.anthropic.com/v1/messages";
export const MODELS = { fast: "claude-haiku-5-5", careful: "claude-sonnet-5-5" };

export async function call(env, { model, system, messages, maxTokens = 1500, thinking = "off", _retry = 0 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    // system はキャッシュ対象（物件ルール・FAQ・学習例は毎回ほぼ同じ）
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages
  };
  // 既定で「考える」トークンをオフ（JSON出力だけが欲しいので、思考に出力枠を食われないように）
  if (thinking === "off") body.thinking = { type: "disabled" };
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  // thinking パラメータを受け付けないモデルなら外して1回だけやり直す
  if (res.status === 400 && thinking === "off" && /thinking/i.test(JSON.stringify(data))) return call(env, { model, system, messages, maxTokens, thinking: "default", _retry });
  // 一時的な拒否・混雑は少し待って最大2回やり直す
  if ([403, 429, 500, 502, 503, 529].includes(res.status) && _retry < 2) { await new Promise(r => setTimeout(r, 4000 * (_retry + 1))); return call(env, { model, system, messages, maxTokens, thinking, _retry: _retry + 1 }); }
  // このAPIキーで使えないモデル（403）なら Haiku に切り替えて1回だけやり直す
  if (res.status === 403 && model !== MODELS.fast) { console.warn("Claude 403 → fallback to", MODELS.fast); return call(env, { model: MODELS.fast, system, messages, maxTokens }); }
  if (!res.ok) throw new Error(`Claude API エラー (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  if (!text) console.warn("Claude empty text", model, data.stop_reason, JSON.stringify((data.content || []).map(c => c.type)), JSON.stringify(data.usage));
  return { text, usage: data.usage, stopReason: data.stop_reason, types: (data.content || []).map(c => c.type) };
}

export function extractJson(text, { truncated = false } = {}) {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  // 途中で切れた出力の救済：文字列を閉じて "}" を足してみる
  const start = text.indexOf("{");
  if (start >= 0) {
    const body = text.slice(start);
    for (const tail of ['"}', '"]}', '}', ']}']) { try { return JSON.parse(body + tail); } catch {} }
  }
  throw new Error((truncated ? "出力が長すぎて途中で切れました: " : "JSONが見つかりません: ") + (text ? text.slice(0, 200) : "（本文が空）"));
}

/**
 * 返信案を作る。
 * ctx: { property, rules, faqs:[{q,a}], examples:[{q,a}], booking:{...}, thread:[{from,text}], guestMessage }
 * 返り: { category, confidence, reply, replyJa, reason, needsHuman }
 */
export async function draftReply(env, ctx) {
  const system = buildSystem(ctx);
  const user = buildUser(ctx);
  const msgs = [{ role: "user", content: user }];
  let out = await call(env, { model: MODELS.fast, system, messages: msgs });
  let model = MODELS.fast;
  let r;
  try { r = extractJson(out.text, { truncated: out.stopReason === "max_tokens" }); }
  catch (e) {
    // Haiku が壊れたJSONを返したら Sonnet で1回だけ作り直す
    out = await call(env, { model: MODELS.careful, system, messages: msgs, maxTokens: 2000 });
    r = extractJson(out.text, { truncated: out.stopReason === "max_tokens" });
    model = MODELS.careful;
  }
  // Haiku が自信なしのときだけ Sonnet で作り直す
  if (model === MODELS.fast && r.needsReply !== false && (r.confidence ?? 0) < 0.6 && !r.needsHuman) {
    out = await call(env, { model: MODELS.careful, system, messages: msgs });
    r = extractJson(out.text, { truncated: out.stopReason === "max_tokens" });
    model = MODELS.careful;
  }
  return { ...r, model, usage: out.usage };
}

function buildSystem({ property, rules, faqs, examples }) {
  const faqText = (faqs || []).length
    ? faqs.map((f, i) => `${i + 1}. Q: ${f.q}\n   A: ${f.a}${f.auto ? "（自動返信可）" : ""}`).join("\n")
    : "（登録なし）";
  const exText = (examples || []).length
    ? examples.map((e, i) => `${i + 1}. ゲスト: ${e.q}\n   返信: ${e.a}`).join("\n")
    : "（登録なし）";
  return `あなたは日本の宿泊施設「${property}」の運営スタッフです。ゲストからのメッセージに対する返信案を作ります。

## 絶対に守ること
- 返金・補償・値引き・鍵の暗証番号・法令（名簿など）に関わる内容は自分で判断せず needsHuman を true にする。暗証番号は絶対に書かない
- 分からないことは推測で答えず、needsHuman を true にして理由を書く
- 返信は必ず日本語で書く（翻訳はOTAが行う）。簡潔・丁寧に、2〜4文まで。宛名・署名は不要
- FAQ・過去の返信例と矛盾しない。過去の返信例の口調と長さに合わせる

## この施設の返信ルール
${rules || "（未設定）"}

## 登録FAQ
${faqText}

## 過去にスタッフが実際に送った返信例（新しい順）
${exText}

## 一言返しで済むもの（needsReply を false にし、reply には1文の短い返事を入れる）
- お礼だけ、「チェックインしました」「着きました」などの報告だけ、「後で送ります」などこちらの返事を待っていないもの
- 例：「ご連絡ありがとうございます。ごゆっくりお過ごしください。」「承知しました。お待ちしております。」
- ただし質問・要望・不満・トラブルが1つでも含まれていれば needsReply は true

## 出力形式（JSONのみ、前後に文章を付けない。reason は60字以内）
{"category":"question|request|complaint|thanks|info|other","needsReply":true|false,"confidence":0.0〜1.0,"needsHuman":true|false,"usedFaq":[根拠にした登録FAQの番号。使っていなければ空配列],"guestJa":"ゲストのメッセージの日本語訳（原文が日本語なら空文字）","reply":"日本語の返信本文","reason":"根拠にしたFAQ/返信例の番号と判断理由（日本語・60字以内）"}`;
}

function buildUser({ booking, thread, guestMessage }) {
  const b = booking || {};
  const info = [
    `予約: ${b.channel || "-"} / ${b.firstName || ""} ${b.lastName || ""} / ${b.arrival || "?"}〜${b.departure || "?"} / 大人${b.numAdult ?? "?"} 子供${b.numChild ?? 0}`,
    b.status ? `ステータス: ${b.status}` : null
  ].filter(Boolean).join("\n");
  const recent = (thread || []).slice(-3).map(m => `${m.from === "guest" ? "ゲスト" : "スタッフ"}: ${m.text}`).join("\n");
  return `${info}

## 直近のやり取り
${recent || "（なし）"}

## 今回のゲストのメッセージ
${guestMessage}`;
}
