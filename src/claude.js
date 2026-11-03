// Claude API（返信案の生成）。トークン節約のため Haiku を既定にし、自信がないときだけ Sonnet。
const API = "https://api.anthropic.com/v1/messages";
export const MODELS = { fast: "claude-haiku-5-5", careful: "claude-sonnet-5-5" };

async function call(env, { model, system, messages, maxTokens = 800 }) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // system はキャッシュ対象（物件ルール・FAQ・学習例は毎回ほぼ同じ）
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API エラー (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  return { text, usage: data.usage };
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSONが見つかりません: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}

/**
 * 返信案を作る。
 * ctx: { property, rules, faqs:[{q,a}], examples:[{q,a}], booking:{...}, thread:[{from,text}], guestMessage }
 * 返り: { category, confidence, reply, replyJa, reason, needsHuman }
 */
export async function draftReply(env, ctx) {
  const system = buildSystem(ctx);
  const user = buildUser(ctx);
  let out = await call(env, { model: MODELS.fast, system, messages: [{ role: "user", content: user }] });
  let r = extractJson(out.text);
  let model = MODELS.fast;
  // Haiku が自信なしのときだけ Sonnet で作り直す
  if ((r.confidence ?? 0) < 0.6 && !r.needsHuman) {
    out = await call(env, { model: MODELS.careful, system, messages: [{ role: "user", content: user }] });
    r = extractJson(out.text);
    model = MODELS.careful;
  }
  return { ...r, model, usage: out.usage };
}

function buildSystem({ property, rules, faqs, examples }) {
  const faqText = (faqs || []).length
    ? faqs.map((f, i) => `${i + 1}. Q: ${f.q}\n   A: ${f.a}`).join("\n")
    : "（登録なし）";
  const exText = (examples || []).length
    ? examples.map((e, i) => `${i + 1}. ゲスト: ${e.q}\n   返信: ${e.a}`).join("\n")
    : "（登録なし）";
  return `あなたは日本の宿泊施設「${property}」の運営スタッフです。ゲストからのメッセージに対する返信案を作ります。

## 絶対に守ること
- 返金・補償・値引き・鍵の暗証番号・法令（名簿など）に関わる内容は自分で判断せず needsHuman を true にする。暗証番号は絶対に書かない
- 分からないことは推測で答えず、needsHuman を true にして理由を書く
- 返信はゲストが書いた言語で、簡潔・丁寧に。宛名は「様」相当の敬称を付け、署名は不要
- FAQ・過去の返信例と矛盾しない。過去の返信例の口調と長さに合わせる

## この施設の返信ルール
${rules || "（未設定）"}

## 登録FAQ
${faqText}

## 過去にスタッフが実際に送った返信例（新しい順）
${exText}

## 出力形式（JSONのみ、前後に文章を付けない）
{"category":"question|request|complaint|thanks|other","confidence":0.0〜1.0,"needsHuman":true|false,"reason":"根拠にしたルール/FAQ/返信例の番号と判断理由（日本語・1〜2文）","reply":"ゲストの言語での返信本文","replyJa":"replyの日本語訳（ゲストが日本語ならreplyと同じ）"}`;
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
