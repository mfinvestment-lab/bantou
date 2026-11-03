// 過去のBeds24スレッドから「ゲストの質問 → スタッフの返信」のペアを学習例に取り込む
import { getToken, getBookings, fetchThread, fetchPropertyMap } from "./beds24.js";
import { examples, props, normalizeProperty } from "./store.js";

const NO_REPLY = /^(thank you|thanks|thx|ok|okay|great|perfect|got it|noted|ありがとう|ありがとうございます|了解|承知|わかりました|감사합니다|謝謝|谢谢|ขอบคุณ)[!.。！\s]*$/i;
// Beds24の自動送信・定型文らしきホスト発言は学習しない
const AUTO_LIKE = /\{\{|zoho|notion\.site|forms\.|guest registration|宿泊者名簿|チェックイン当日|check-in day|business hours|営業時間|Review|レビュー/i;
const MAX_BOOKINGS = 80;
const WINDOW_MS = 48 * 60 * 60 * 1000;

function ymd(d) { return d.toISOString().slice(0, 10); }

export async function importHistory(env, property, days = 90) {
  const token = await getToken(env);
  let map = await props.get(env.KV);
  if (!map) { map = await fetchPropertyMap(token); await props.set(env.KV, map); }
  const propId = Object.keys(map).find(id => normalizeProperty(map[id]) === property);
  if (!propId) return { error: `Beds24に「${property}」が見つかりません。「物件一覧」で名前を確認してください。` };

  const now = new Date();
  const from = ymd(new Date(now.getTime() - days * 86400000));
  const to = ymd(now);
  const bookings = (await getBookings(token, `propertyId=${propId}&arrivalFrom=${from}&arrivalTo=${to}`))
    .filter(b => b.status !== "cancelled")
    .sort((a, b) => String(a.arrival).localeCompare(String(b.arrival)))
    .slice(-MAX_BOOKINGS);

  const existing = await examples.list(env.KV, property);
  const seenQ = new Set(existing.map(e => e.q.trim()));
  const pairs = [];
  let threads = 0;

  for (const b of bookings) {
    let thread;
    try { thread = await fetchThread(token, b.id, days + 30); } catch { continue; }
    threads++;
    const msgs = (thread || [])
      .map(t => ({ src: t.source === "guest" ? "guest" : "host", text: String(t.message || "").trim(), t: Date.parse(t.time) || 0 }))
      .filter(m => m.text)
      .sort((a, b) => a.t - b.t);
    for (let i = 0; i < msgs.length; i++) {
      const g = msgs[i];
      if (g.src !== "guest" || g.text.length < 8 || NO_REPLY.test(g.text)) continue;
      const h = msgs.slice(i + 1).find(m => m.t > g.t);
      if (!h || h.src !== "host") continue;                // 次の発言がゲスト→未返信だったもの
      if (h.t - g.t > WINDOW_MS) continue;                 // 48時間以上あいた返信は別件の可能性
      if (h.text.length > 600 || AUTO_LIKE.test(h.text)) continue;
      if (seenQ.has(g.text)) continue;
      seenQ.add(g.text);
      pairs.push({ q: g.text, a: h.text, t: h.t, channel: b.channel || b.referer || "" });
    }
  }
  // 古い順に add（unshift されるので最終的に新しいものが先頭になる）
  pairs.sort((a, b) => a.t - b.t);
  for (const p of pairs) await examples.add(env.KV, property, p.q, p.a, { channel: p.channel, imported: true });
  const total = (await examples.list(env.KV, property)).length;
  return { property, days, bookings: bookings.length, threads, added: pairs.length, total };
}
