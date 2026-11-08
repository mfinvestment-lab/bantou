// 過去のBeds24スレッドから「ゲストの質問 → スタッフの返信」のペアを学習例に取り込む
import { getToken, getBookings, fetchThread, fetchPropertyMap } from "./beds24.js";
import { examples, props, faq, rules, normalizeProperty } from "./store.js";
import { call, extractJson, MODELS } from "./claude.js";

const NO_REPLY = /^(thank you|thanks|thx|ok|okay|great|perfect|got it|noted|ありがとう|ありがとうございます|了解|承知|わかりました|감사합니다|謝謝|谢谢|ขอบคุณ)[!.。！\s]*$/i;
// Beds24の自動送信・定型文らしきホスト発言は学習しない
const AUTO_LIKE = /\{\{|zoho|notion\.site|forms\.|guest registration|宿泊者名簿|チェックイン当日|check-in day|business hours|営業時間|Review|レビュー/i;
const MAX_BOOKINGS = 80;
const WINDOW_MS = 48 * 60 * 60 * 1000;

function ymd(d) { return d.toISOString().slice(0, 10); }

/** Beds24 API の利用枠（429 Credit limit）に当たったら少し待って1回だけやり直す */
async function withRetry(fn, waitMs = 65000) {
  try { return await fn(); }
  catch (e) {
    if (!/429|Credit limit/i.test(e.message)) throw e;
    console.warn("Beds24 429 → wait", waitMs);
    await new Promise(r => setTimeout(r, waitMs));
    return fn();
  }
}

/** Beds24の過去スレッドから「ゲストの質問 → スタッフ返信」のペアを集める（共通処理）。結果は24時間キャッシュ */
async function collectPairs(env, property, days, { maxBookings = MAX_BOOKINGS } = {}) {
  const cacheKey = `pairs:${property}:${days}:${maxBookings}`;
  const cached = await env.KV.get(cacheKey, "json");
  if (cached) return { ...cached, cached: true };

  const token = await getToken(env);
  let map = await props.get(env.KV);
  if (!map) { map = await fetchPropertyMap(token); await props.set(env.KV, map); }
  const propId = Object.keys(map).find(id => normalizeProperty(map[id]) === property);
  if (!propId) return { error: `Beds24に「${property}」が見つかりません。「物件一覧」で名前を確認してください。` };

  const now = new Date();
  const from = ymd(new Date(now.getTime() - days * 86400000));
  const to = ymd(now);
  const bookings = (await withRetry(() => getBookings(token, `propertyId=${propId}&arrivalFrom=${from}&arrivalTo=${to}`)))
    .filter(b => b.status !== "cancelled")
    .sort((a, b) => String(a.arrival).localeCompare(String(b.arrival)))
    .slice(-maxBookings);

  const pairs = [];
  const unanswered = [];
  let threads = 0;
  const threadsOf = [];
  for (let i = 0; i < bookings.length; i += 4) {
    const chunk = bookings.slice(i, i + 4);
    const rs = await Promise.all(chunk.map(b => withRetry(() => fetchThread(token, b.id, days + 30)).then(t => ({ b, t })).catch(e => { console.warn("thread fetch failed", b.id, e.message.slice(0, 80)); return null; })));
    for (const r of rs) if (r) threadsOf.push(r);
  }
  for (const { b, t: thread } of threadsOf) {
    threads++;
    const msgs = (thread || [])
      .map(t => ({ src: t.source === "guest" ? "guest" : "host", text: String(t.message || "").trim(), t: Date.parse(t.time) || 0 }))
      .filter(m => m.text)
      .sort((a, b) => a.t - b.t);
    for (let i = 0; i < msgs.length; i++) {
      const g = msgs[i];
      if (g.src !== "guest" || g.text.length < 8 || NO_REPLY.test(g.text)) continue;
      const h = msgs.slice(i + 1).find(m => m.t > g.t);
      if (!h || h.src !== "host") { if (/[?？]/.test(g.text)) unanswered.push({ q: g.text, t: g.t }); continue; }
      if (h.t - g.t > WINDOW_MS) continue;                 // 48時間以上あいた返信は別件の可能性
      if (h.text.length > 600 || AUTO_LIKE.test(h.text)) continue;
      pairs.push({ q: g.text, a: h.text, t: h.t, channel: b.channel || b.referer || "" });
    }
  }
  const result = { bookings: bookings.length, threads, pairs, unanswered };
  if (threads > 0) await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 });
  return result;
}

export async function importHistory(env, property, days = 90) {
  const c = await collectPairs(env, property, days);
  if (c.error) return c;
  const existing = await examples.list(env.KV, property);
  const seenQ = new Set(existing.map(e => e.q.trim()));
  const pairs = [];
  for (const p of c.pairs) { if (seenQ.has(p.q)) continue; seenQ.add(p.q); pairs.push(p); }
  const { bookings, threads } = c;
  // 古い順に add（unshift されるので最終的に新しいものが先頭になる）
  pairs.sort((a, b) => a.t - b.t);
  for (const p of pairs) await examples.add(env.KV, property, p.q, p.a, { channel: p.channel, imported: true });
  const total = (await examples.list(env.KV, property)).length;
  return { property, days, bookings, threads, added: pairs.length, total };
}

// ---- FAQ案：過去のやり取りをまとめて「よくある質問」の候補を作る ----
const CAND_TTL = 60 * 60 * 24 * 3;
export const faqCandidates = {
  get: (kv, p) => kv.get(`faqcand:${p}`, "json"),
  set: (kv, p, list) => kv.put(`faqcand:${p}`, JSON.stringify(list), { expirationTtl: CAND_TTL }),
  clear: (kv, p) => kv.delete(`faqcand:${p}`)
};


/** FAQ案のプロンプトを組み立てる（切り分けテストからも使う） */
export async function buildFaqPrompt(env, property, c) {
  const existing = await faq.list(env.KV, property);
  const rulesText = (await rules.get(env.KV, property)) || "";
  const pairsText = c.pairs.slice(-80).map((p, i) => `${i + 1}. ゲスト: ${p.q.slice(0, 200)}\n   返信: ${p.a.slice(0, 250)}`).join("\n");
  const unText = c.unanswered.slice(-30).map(u => `- ${u.q.slice(0, 200)}`).join("\n");
  const system = `あなたは日本の宿泊施設「${property}」の運営マネージャーです。過去のゲストとのやり取りから、FAQ（よくある質問と回答）の候補を作ります。

## ルール
- 同じ趣旨の質問はひとつにまとめ、よく聞かれる順に最大10件
- Q は一般化した日本語の質問文（固有名詞や日付を外す）。A はスタッフが実際に送った返信の内容に基づく日本語の回答（2〜4文、丁寧・簡潔）。スタッフが答えていない内容を創作しない
- 鍵の暗証番号・Wi-Fiパスワード・返金/補償/値引きの可否・名簿の免除 に関する内容はFAQにしない（候補から除く）
- 既存FAQと重複するものは出さない。既存FAQの回答が過去の返信と食い違う場合は "conflict" に既存FAQ番号を入れて指摘する
- 未返信の質問で、返信例が無く答えが分からないものは "needsAnswer": true とし、A は空文字にする
- count は、その質問に該当した過去のやり取りの件数

## この施設の返信ルール
${rulesText || "（未設定）"}

## 既存FAQ
${existing.length ? existing.map((f, i) => `${i + 1}. Q: ${f.q}\n   A: ${f.a}`).join("\n") : "（なし）"}

## 出力形式（JSONのみ）
{"candidates":[{"q":"…","a":"…","count":3,"needsAnswer":false,"conflict":null,"sourceIds":[1,5]}]}`;
  const user = `## 過去のやり取り（ゲスト→スタッフ返信、古い順）\n${pairsText || "（なし）"}\n\n## 返信が無かったゲストの質問\n${unText || "（なし）"}`;
  return { system, user };
}

export async function suggestFaq(env, property, days = 180) {
  const c = await collectPairs(env, property, days, { maxBookings: 80 });
  if (c.error) return c;
  if (!c.pairs.length && !c.unanswered.length) return { property, days, bookings: c.bookings, threads: c.threads, candidates: [] };
  const { system, user } = await buildFaqPrompt(env, property, c);
  const out = await call(env, { model: MODELS.careful, system, messages: [{ role: "user", content: user }], maxTokens: 8000 });
  if (!out.text) throw new Error(`Claudeの応答が空でした（stop=${out.stopReason}, blocks=${(out.types || []).join(",")}, in=${out.usage?.input_tokens}, out=${out.usage?.output_tokens}）`);
  const r = extractJson(out.text, { truncated: out.stopReason === "max_tokens" });
  const candidates = (r.candidates || []).filter(x => x && x.q).map(x => ({ q: String(x.q).trim(), a: String(x.a || "").trim(), count: Number(x.count) || 1, needsAnswer: !!x.needsAnswer || !x.a, conflict: x.conflict || null }));
  await faqCandidates.set(env.KV, property, candidates);
  return { property, days, bookings: c.bookings, threads: c.threads, pairs: c.pairs.length, unanswered: c.unanswered.length, candidates, usage: out.usage };
}
