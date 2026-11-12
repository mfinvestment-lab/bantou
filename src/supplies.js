// 消耗品の「足りない物」申告 → 集計 → SORA で Amazon カートへ。
// 品目の正本は運営PJの消耗品リスト（Claude Sheet「消耗品リスト（nel・SAKUYA・桜ハウス）」）。品目を増減したらここも直す。
// 流れ：HARU「足りない物」→ 品目ボタン → タップで発注リストへ（KV）。毎日18時に未通知分があれば SORA へまとめを1通。
//       SORA「発注まとめ」でいつでも表示（返信なので通数を使わない）。［Amazonカートに入れる］で Amazon 品をまとめてカートへ。
//       注文の確定は Amazon 側で本人が行う（番頭は注文しない）。［発注済みにする］でリストを空にする。
import { haru, sora } from "./line.js";

// proc: amazon = Amazon で発注 / own = 個別手配（通知のみ、リンクなし）。only: そのエリアだけに出す
export const ITEMS = [
  { id: "tp", name: "トイレットペーパー", cat: "アメニティ", proc: "amazon", url: "https://amzn.asia/d/02yPyvYA" },
  { id: "tissue", name: "ティッシュ", cat: "アメニティ", proc: "amazon", url: "https://amzn.asia/d/0gC5t6af" },
  { id: "toothbrush", name: "歯ブラシ", cat: "アメニティ", proc: "amazon", url: "https://www.amazon.co.jp/dp/B01563ZN7U" },
  { id: "bottle", name: "シャンプー等のボトル", cat: "アメニティ", proc: "amazon", url: "https://www.amazon.co.jp/dp/B0FCBFLWLC" },
  { id: "shampoo", name: "シャンプー", cat: "アメニティ", proc: "own" },
  { id: "conditioner", name: "コンディショナー", cat: "アメニティ", proc: "own" },
  { id: "bodysoap", name: "ボディソープ", cat: "アメニティ", proc: "own" },
  { id: "handsoap", name: "ハンドソープ", cat: "アメニティ", proc: "own" },
  { id: "bag45", name: "ゴミ袋45L", cat: "ゴミ袋", proc: "amazon", url: "https://www.amazon.co.jp/dp/B00PJFD8E6" },
  { id: "bag10", name: "ゴミ袋10L", cat: "ゴミ袋", proc: "amazon", url: "https://www.amazon.co.jp/dp/B0CM3BG96K" },
  { id: "sanitary", name: "サニタリー袋", cat: "ゴミ袋", proc: "amazon", url: "https://www.amazon.co.jp/dp/B0D8SY1PW9" },
  { id: "dish", name: "食器用洗剤", cat: "キッチン", proc: "amazon", url: "https://www.amazon.co.jp/dp/B0H99H9QB3" },
  { id: "sponge", name: "食器用スポンジ", cat: "キッチン", proc: "amazon", url: "https://www.amazon.co.jp/dp/B0CQ22VDL3" },
  { id: "laundry", name: "洗濯洗剤", cat: "キッチン", proc: "amazon", url: "https://www.amazon.co.jp/dp/B0GM6K3VC1" },
  { id: "kpaper", name: "キッチンペーパー", cat: "キッチン", proc: "amazon", url: "https://www.amazon.co.jp/dp/B0FPPXFCD4" },
  { id: "drainnet", name: "排水口ネット", cat: "キッチン", proc: "amazon", url: "https://amzn.asia/d/0apNoTBu" },
  { id: "bathclean", name: "バスタブ洗剤", cat: "清掃用", proc: "amazon", url: "https://www.amazon.co.jp/dp/B086C23MKC" },
  { id: "bathsponge", name: "風呂掃除スポンジ", cat: "清掃用", proc: "amazon", url: "https://amzn.asia/d/0jkyEpTh" },
  { id: "toiletsheet", name: "トイレクリーナー", cat: "清掃用", proc: "amazon", url: "https://amzn.asia/d/0i9SBfue" },
  { id: "sunpole", name: "サンポール", cat: "清掃用", proc: "amazon", url: "https://amzn.asia/d/07KxB9en" },
  { id: "floorsheet", name: "床用ウェットシート", cat: "清掃用", proc: "amazon", url: "https://amzn.asia/d/043rD1D5" },
  { id: "roller", name: "コロコロ替え", cat: "清掃用", proc: "amazon", url: "https://amzn.asia/d/00SKRpuY" },
  { id: "cloth", name: "使い捨て布巾", cat: "清掃用", proc: "amazon", url: "https://www.amazon.co.jp/dp/B0GCHVJ9N2" },
  { id: "bluelet", name: "ブルーレット（サクヤ）", cat: "清掃用", proc: "amazon", url: null, only: ["富士宮"] }
];
const CATS = ["アメニティ", "ゴミ袋", "キッチン", "清掃用"];
export const LOCS = ["富士宮", "静岡"];
const byId = id => ITEMS.find(i => i.id === id);
const itemsFor = loc => ITEMS.filter(i => !i.only || i.only.includes(loc));
const md = iso => new Date(iso).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" });

// --- 発注リスト（KV） sup:pending:<loc> = { [id]: { at, by, n } } ---
const pkey = loc => `sup:pending:${loc}`;
export const pending = {
  get: async (kv, loc) => (await kv.get(pkey(loc), "json")) || {},
  put: (kv, loc, v) => kv.put(pkey(loc), JSON.stringify(v))
};

/** HARU：品目ボタン（スタッフのエリア分）。発注リストに入っている品目は ✓ */
export async function supplyMenu(env, loc) {
  const p = await pending.get(env.KV, loc);
  const list = itemsFor(loc);
  const btn = i => ({ type: "button", style: p[i.id] ? "primary" : "secondary", height: "sm", flex: 1,
    color: p[i.id] ? "#7f8c8d" : undefined,
    action: { type: "postback", label: `${p[i.id] ? "✓ " : ""}${i.name}`.slice(0, 40), data: `sup=add&i=${i.id}&loc=${encodeURIComponent(loc)}`, displayText: `足りない：${i.name}` } });
  const body = [];
  for (const c of CATS) {
    const its = list.filter(i => i.cat === c);
    if (!its.length) continue;
    body.push({ type: "text", text: c, size: "xs", color: "#888888", margin: body.length ? "md" : "none" });
    for (let k = 0; k < its.length; k += 2) body.push({ type: "box", layout: "horizontal", spacing: "sm", margin: "sm", contents: its.slice(k, k + 2).map(btn).concat(its.length - k === 1 ? [{ type: "filler" }] : []) });
  }
  body.push({ type: "text", text: "少ない・なくなった物を押してください（複数OK）。✓は発注リストに入っている物です。", size: "xxs", color: "#888888", wrap: true, margin: "md" });
  return { type: "flex", altText: `足りない物（${loc}）`, contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: "#1a1a1a", paddingAll: "10px", contents: [{ type: "text", text: `🧴 足りない物（${loc}）`, color: "#ffffff", weight: "bold" }] },
    body: { type: "box", layout: "vertical", contents: body } } };
}

/** HARU のテキスト「足りない物」。loc が決まらない（オーナーの1対1）ときはエリアを選ばせる */
export async function replySupplyMenu(env, replyToken, loc) {
  const line = haru(env);
  if (!loc) {
    await line.replyRaw(replyToken, [{ type: "text", text: "どちらのエリアですか？", quickReply: { items: LOCS.map(l => ({ type: "action", action: { type: "message", label: l, text: `足りない物 ${l}` } })) } }]);
    return;
  }
  await line.replyRaw(replyToken, [await supplyMenu(env, loc)]);
}

/** HARU の postback（sup=add） */
export async function handleSupplyHaruPostback(env, event, pp, allowedLoc) {
  const line = haru(env);
  const loc = pp.get("loc");
  const it = byId(pp.get("i"));
  if (!it || !LOCS.includes(loc)) { await line.reply(event.replyToken, "このボタンは古くなっています。「足りない物」をもう一度押してください。"); return; }
  if (allowedLoc && allowedLoc !== loc) { await line.reply(event.replyToken, `${loc} はあなたの担当エリアではありません。`); return; }
  const who = (await line.memberName(event.source.groupId || null, event.source.userId)) || "スタッフ";
  const p = await pending.get(env.KV, loc);
  if (p[it.id]) {
    p[it.id].n = (p[it.id].n || 1) + 1;
    await pending.put(env.KV, loc, p);
    await line.reply(event.replyToken, `「${it.name}」は ${md(p[it.id].at)} に${p[it.id].by}さんが入れています（発注リストに入っています）。`);
    return;
  }
  p[it.id] = { at: new Date().toISOString(), by: who, n: 1 };
  await pending.put(env.KV, loc, p);
  await line.reply(event.replyToken, `✅ 「${it.name}」を${loc}の発注リストに入れました。ほかにもあれば続けて押してください。`);
}

// --- ASIN（短縮リンクは Worker から辿って解決し、KV に30日保存） ---
async function asinOf(env, it) {
  if (!it.url) return null;
  const direct = it.url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
  if (direct) return direct[1];
  const ck = `sup:asin:${it.id}`;
  const cached = await env.KV.get(ck);
  if (cached) return cached === "-" ? null : cached;
  let url = it.url, asin = null;
  try {
    for (let hop = 0; hop < 4 && !asin; hop++) {
      const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
      const loc = res.headers.get("location");
      const m = (loc || "").match(/\/(?:dp|gp\/product|d)\/([A-Z0-9]{10})/);
      if (m && /^[A-Z0-9]{10}$/.test(m[1]) && /^B0|^\d/.test(m[1])) asin = m[1];
      if (!loc) { const html = res.status === 200 ? await res.text() : ""; const h = html.match(/\/dp\/([A-Z0-9]{10})/); if (h) asin = h[1]; break; }
      url = new URL(loc, url).toString();
    }
  } catch (e) { console.error("asin resolve", it.id, e.message); }
  await env.KV.put(ck, asin || "-", { expirationTtl: asin ? 60 * 60 * 24 * 30 : 60 * 60 * 6 });
  return asin;
}

/** Amazon のカート追加URL（Amazon 品で ASIN が分かるものだけ）。Quantity は1個（1箱）ずつ。数量はカートで直す */
export async function cartUrl(env, ids) {
  const its = ids.map(byId).filter(i => i && i.proc === "amazon");
  const q = [], missing = [];
  for (const it of its) {
    const a = await asinOf(env, it);
    if (a) q.push(a); else missing.push(it);
  }
  if (!q.length) return { url: null, missing };
  const params = q.map((a, k) => `ASIN.${k + 1}=${a}&Quantity.${k + 1}=1`).join("&");
  return { url: `https://www.amazon.co.jp/gp/aws/cart/add.html?${params}`, count: q.length, missing };
}

/** SORA：エリアごとのまとめカード（発注リストが空なら null） */
export async function summaryCard(env, loc) {
  const p = await pending.get(env.KV, loc);
  const ids = Object.keys(p).filter(byId);
  if (!ids.length) return null;
  const am = ids.filter(id => byId(id).proc === "amazon");
  const own = ids.filter(id => byId(id).proc === "own");
  const row = id => {
    const it = byId(id), r = p[id];
    const t = { type: "text", text: `・${it.name}${r.n > 1 ? `（${r.n}回）` : ""}　${md(r.at)} ${r.by}`, size: "sm", wrap: true };
    if (it.proc === "amazon" && it.url) { t.color = "#2a6ebb"; t.action = { type: "uri", label: it.name.slice(0, 20), uri: it.url }; }
    if (it.proc === "amazon" && !it.url) t.text += "（リンク未登録）";
    return t;
  };
  const body = [];
  if (am.length) body.push({ type: "text", text: `Amazon（${am.length}品目）`, weight: "bold", size: "sm" }, ...am.map(row));
  if (own.length) body.push({ type: "text", text: `個別手配（${own.length}品目）`, weight: "bold", size: "sm", margin: am.length ? "md" : "none" }, ...own.map(row));
  const token = crypto.randomUUID().slice(0, 8);
  await env.KV.put(`sup:cart:${token}`, JSON.stringify({ loc, ids: am }), { expirationTtl: 60 * 60 * 24 * 14 });
  const base = env.PUBLIC_BASE_URL || "https://bantou.goichiros516.workers.dev";
  const footer = [];
  if (am.length) footer.push({ type: "button", style: "primary", color: "#e67e22", height: "sm", action: { type: "uri", label: "Amazonカートに入れる", uri: `${base}/supplies/cart?t=${token}` } });
  footer.push({ type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "発注済みにする", data: `sup=done&loc=${encodeURIComponent(loc)}&ids=${ids.join(",")}`, displayText: `${loc} 消耗品を発注済みにする` } });
  body.push({ type: "text", text: "品名を押すと商品ページ。カートの数量を確認してから注文してください。", size: "xxs", color: "#888888", wrap: true, margin: "md" });
  return { type: "flex", altText: `🛒 消耗品の発注（${loc}）${ids.length}品目`, contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: "#1a1a1a", paddingAll: "10px", contents: [{ type: "text", text: `🛒 消耗品の発注（${loc}）`, color: "#ffffff", weight: "bold" }] },
    body: { type: "box", layout: "vertical", spacing: "xs", contents: body },
    footer: { type: "box", layout: "vertical", spacing: "sm", contents: footer } } };
}

export async function allSummaryCards(env) {
  const out = [];
  for (const loc of LOCS) { const c = await summaryCard(env, loc); if (c) out.push(c); }
  return out;
}

/** SORA の postback（sup=done）：押した時点のカードに載っていた品目だけ外す（後から入った分は残す） */
export async function handleSupplySoraPostback(env, event, pp) {
  const line = sora(env);
  const loc = pp.get("loc");
  const ids = (pp.get("ids") || "").split(",").filter(Boolean);
  const p = await pending.get(env.KV, loc);
  const done = ids.filter(id => p[id]);
  for (const id of done) delete p[id];
  await pending.put(env.KV, loc, p);
  const left = Object.keys(p).length;
  await line.reply(event.replyToken, done.length
    ? `✅ ${loc} の${done.length}品目を発注済みにしました。${left ? `\nまだ${left}品目残っています（「発注まとめ」で表示）。` : ""}`
    : `${loc} のその品目はすでに発注済みです。`);
}

/** /supplies/cart?t=… → Amazon のカート追加画面へ転送 */
export async function handleCartRedirect(env, url) {
  const t = url.searchParams.get("t") || "";
  const v = t && (await env.KV.get(`sup:cart:${t}`, "json"));
  if (!v) return new Response("リンクの期限が切れています。SORAで「発注まとめ」を押して出し直してください。", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const r = await cartUrl(env, v.ids);
  if (!r.url) return new Response("Amazonの商品IDが取れませんでした。カードの品名から個別に開いてください。", { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return Response.redirect(r.url, 302);
}

/** 毎日18時：前回の通知から増えた品目があるエリアだけ SORA にまとめを1通 */
export async function runSupplyDigest(env) {
  const to = env.SORA_TARGET_ID || env.OWNER_USER_ID;
  const cards = [];
  for (const loc of LOCS) {
    const p = await pending.get(env.KV, loc);
    const sig = Object.keys(p).sort().join(",");
    if (!sig) continue;
    const last = await env.KV.get(`sup:notified:${loc}`);
    if (last === sig) continue;
    const c = await summaryCard(env, loc);
    if (c) { cards.push(c); await env.KV.put(`sup:notified:${loc}`, sig); }
  }
  if (cards.length) await sora(env).pushMessages(to, cards);
  return { sent: cards.length };
}
