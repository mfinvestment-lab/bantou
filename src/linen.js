// リネン発注案（ゆーかさん宛て）
// 火・金 9:00（祝日なら前の平日）に、Beds24の予約と在庫シートから発注数を計算し、SORAに案を出す。
// ［ゆーかさんに送る］でLINEの共有画面を開き、同時に発注を記録する。9:20までに送られていなければ再通知。
//
// 在庫の考え方
//   静岡（nel.）  : 施設内に納品。在庫シートへの加算は「納品日の翌日」（GASのsaveOrderに翌日の日付で登録）
//   富士宮       : 物置小屋に納品 → スタッフが各施設へ運んで「補充」したときに在庫シートへ加算。
//                  発注〜補充までの分は KV の「小屋」に物件別で持ち、計算では在庫として数える。
//                  HARUの「補充」で小屋から差し引く（inventory.js から shedTake を呼ぶ）。
import { BEDS24_PROPERTIES, getToken, getBookings } from "./beds24.js";
import { sora, haru } from "./line.js";

export const ITEMS = ["シングルシーツ", "シングルカバー", "ダブルシーツ", "ダブルカバー", "枕カバー", "バスタオル", "フェイスタオル", "バスマット"];
const UNIT = { "シングルシーツ": 10, "シングルカバー": 10, "ダブルシーツ": 10, "ダブルカバー": 10, "枕カバー": 20, "バスタオル": 20, "フェイスタオル": 20, "バスマット": 10 };

// 物件設定。beds＝1回の清掃で使うベッドまわりの最大数（「最大使用で引く」方針）。タオルは人数×泊数
export const FAC = {
  "サクヤ": {
    label: "サクヤ", area: "富士宮",
    par: { "シングルシーツ": 25, "シングルカバー": 25, "ダブルシーツ": 8, "ダブルカバー": 8, "枕カバー": 40, "バスタオル": 40, "フェイスタオル": 40, "バスマット": 8 },
    beds: { "シングルシーツ": 6, "シングルカバー": 6, "ダブルシーツ": 2, "ダブルカバー": 2, "枕カバー": 10 },
    mat: () => 1
  },
  "桜ハウス": {
    label: "桜ハウス", area: "富士宮", small: true, // リネン庫が小さい → 常備数を超えないよう切り捨て
    par: { "シングルシーツ": 25, "シングルカバー": 25, "ダブルシーツ": 8, "ダブルカバー": 8, "枕カバー": 40, "バスタオル": 40, "フェイスタオル": 40, "バスマット": 8 },
    beds: { "シングルシーツ": 4, "シングルカバー": 4, "ダブルシーツ": 2, "ダブルカバー": 2, "枕カバー": 12 },
    mat: () => 1
  },
  "nel.shizuoka": {
    label: "nel.", area: "静岡",
    par: { "シングルシーツ": 30, "シングルカバー": 30, "枕カバー": 40, "バスタオル": 40, "フェイスタオル": 40, "バスマット": 10 },
    beds: { "シングルシーツ": 7, "シングルカバー": 7, "枕カバー": 14 },
    mat: nights => (nights >= 4 ? 3 : nights >= 2 ? 2 : 1) // 連泊は2〜3枚
  }
};
const AREAS = { "富士宮": ["サクヤ", "桜ハウス"], "静岡": ["nel.shizuoka"] };
const DELIVERY_DOW = { "富士宮": [3, 6], "静岡": [1, 4] };       // 水・土 ／ 月・木
const ORDER_DOW = { 2: { "富士宮": 1, "静岡": 2 }, 5: { "富士宮": 1, "静岡": 3 } }; // 火→水・木、金→土・月（発注予定日からの日数）
const REMIND_AT = "09:20";
const BASE_URL = env => env.PUBLIC_URL || "https://bantou.goichiros516.workers.dev";

// ---- 日付（"YYYY-MM-DD" 文字列で扱う） ----
const toD = s => new Date(s + "T00:00:00Z");
const ymd = d => d.toISOString().slice(0, 10);
const add = (s, n) => { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const dow = s => toD(s).getUTCDay();
const md = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
const DOWJ = ["日", "月", "火", "水", "木", "金", "土"];
const mdw = s => `${md(s)}（${DOWJ[dow(s)]}）`;
export const todayJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const hmJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16);

async function holidays(env) {
  const k = "linen:holidays";
  const c = env.KV && await env.KV.get(k, "json");
  if (c) return c;
  try {
    const r = await fetch("https://holidays-jp.github.io/api/v1/date.json");
    const h = r.ok ? await r.json() : {};
    if (env.KV && r.ok) await env.KV.put(k, JSON.stringify(h), { expirationTtl: 86400 });
    return h;
  } catch { return {}; }
}
const isOff = (s, hol) => dow(s) === 0 || dow(s) === 6 || Object.prototype.hasOwnProperty.call(hol, s);

/** 今日が発注日なら、本来の発注予定日（火 or 金）を返す。祝日なら前の平日に前倒し */
export async function orderNominalFor(env, today = todayJST()) {
  const hol = await holidays(env);
  for (let i = 0; i <= 7; i++) {
    const t = add(today, i);
    if (!ORDER_DOW[dow(t)]) continue;
    let eff = t;
    while (isOff(eff, hol)) eff = add(eff, -1);
    if (eff === today) return t;
  }
  return null;
}
const nextDelivery = (area, after) => { for (let i = 1; i <= 7; i++) { const s = add(after, i); if (DELIVERY_DOW[area].includes(dow(s))) return s; } };

// ---- 予約 → 清掃ごとの使用数 ----
function usage(f, n, nights) {
  const cfg = FAC[f], u = {};
  for (const it of ITEMS) u[it] = 0;
  for (const [it, q] of Object.entries(cfg.beds)) u[it] = q;
  u["バスタオル"] = n * nights;
  u["フェイスタオル"] = n * nights;
  u["バスマット"] = cfg.mat(nights);
  return u;
}
const guestsOf = b => (b.numAdult || 0) + (b.numChild || 0);
const nightsOf = b => Math.max(1, Math.round((toD(b.departure) - toD(b.arrival)) / 86400e3));

/** 清掃（＝出発日）ごとに、次のゲスト用にセットする数。清掃通知（cleaning.js）と同じ考え方 */
function cleanings(f, bookings, from, to) {
  const max = BEDS24_PROPERTIES[f]?.maxGuests || 1;
  const list = bookings.filter(b => b.departure >= from && b.departure <= to);
  return list.map(b => {
    const next = bookings.filter(x => x.id !== b.id && x.arrival >= b.departure).sort((a, c) => a.arrival.localeCompare(c.arrival))[0];
    let n = max, k = 1, basis = "次の予約なし→定員";
    if (next) {
      const nn = guestsOf(next) || max, nk = nightsOf(next);
      if (next.arrival <= add(b.departure, 1) || nn * nk >= max) { n = nn; k = nk; basis = `次 ${md(next.arrival)} ${nn}名${nk}泊`; }
      else basis = `次 ${md(next.arrival)}（${nn}名${nk}泊）まで間あり→定員`;
    }
    return { date: b.departure, n, k, basis, use: usage(f, n, k) };
  });
}
const sumUse = (cl, from, to) => {
  const s = Object.fromEntries(ITEMS.map(i => [i, 0]));
  for (const c of cl) if (c.date >= from && c.date <= to) for (const i of ITEMS) s[i] += c.use[i];
  return s;
};
const occupied = (bookings, date) => bookings.some(b => b.arrival < date && date < b.departure);

// ---- 小屋（富士宮）・入荷待ち（静岡）の記録 ----
const SHED = "linen:shed";
export async function shedGet(env) { return (await env.KV.get(SHED, "json")) || {}; }
async function shedAdd(env, f, items) {
  const s = await shedGet(env); s[f] ||= {};
  for (const [it, q] of Object.entries(items)) if (q > 0) s[f][it] = (s[f][it] || 0) + q;
  await env.KV.put(SHED, JSON.stringify(s));
}
/** HARUの「補充」から呼ぶ：補充した分を小屋から差し引く（0未満にはしない） */
export async function shedTake(env, f, items) {
  if (!env.KV || !FAC[f] || FAC[f].area !== "富士宮") return;
  const s = await shedGet(env);
  if (!s[f]) return;
  for (const { name, qty } of items) if (s[f][name]) s[f][name] = Math.max(0, s[f][name] - (qty || 0));
  await env.KV.put(SHED, JSON.stringify(s));
}
export async function shedClear(env) { await env.KV.delete(SHED); }
const PENDING = "linen:pending"; // [{ apply: "YYYY-MM-DD", f, items }]

// ---- 計算 ----
const gasAll = env => fetch(`${env.GAS_URL}?action=getAll`).then(r => r.json());

/**
 * nominal（火 or 金）の発注案を計算する。today は計算の起点（発注を出す日）
 */
export async function computeOrder(env, { today = todayJST(), nominal } = {}) {
  nominal ||= (await orderNominalFor(env, today)) || today;
  const offsets = ORDER_DOW[dow(nominal)];
  if (!offsets) throw new Error(`${nominal} は火曜・金曜ではありません`);
  const token = await getToken(env);
  const all = await gasAll(env);
  if (!all.success) throw new Error(`在庫シート取得エラー: ${all.error || "不明"}`);
  const sheet = Object.fromEntries(all.facilities.map(f => [f.name, Object.fromEntries(f.items.map(i => [i.name, Number(i.current) || 0]))]));
  const shed = await shedGet(env);
  const pending = ((await env.KV.get(PENDING, "json")) || []).filter(p => p.apply > today);
  const out = { today, nominal, areas: [] };

  for (const [area, facs] of Object.entries(AREAS)) {
    const delivery = add(nominal, offsets[area]);
    let next = nextDelivery(area, delivery);
    const a = { area, delivery, next, facilities: [] };
    const fetchTo = add(next, 10);
    const bk = {};
    for (const f of facs) {
      bk[f] = (await getBookings(token, `propertyId=${BEDS24_PROPERTIES[f].propId}&departureFrom=${today}&arrivalTo=${add(fetchTo, 30)}`))
        .filter(b => b.status !== "cancelled" && b.status !== "black");
    }
    if (area === "静岡") {
      const f = facs[0];
      a.skip = occupied(bk[f], delivery);
      if (!a.skip && occupied(bk[f], next)) { a.extendedFrom = next; next = nextDelivery(area, next); a.next = next; }
      if (a.skip) { a.next = delivery; a.nextReal = occupied(bk[f], next) ? nextDelivery(area, next) : next; }
    }
    for (const f of facs) {
      const cfg = FAC[f];
      const coverEnd = a.skip ? a.nextReal : a.next;
      const cl = cleanings(f, bk[f], today, coverEnd);
      const before = sumUse(cl, today, delivery);          // 納品日の清掃までは手元の在庫で回す（納品当日分は使えない）
      const need = sumUse(cl, add(delivery, 1), coverEnd);  // 次の納品日までに使う分
      const rows = [];
      for (const it of Object.keys(cfg.par)) {
        const inSheet = sheet[f]?.[it] ?? 0;
        const inShed = cfg.area === "富士宮" ? (shed[f]?.[it] || 0) : 0;
        const inPend = pending.filter(p => p.f === f).reduce((s, p) => s + (p.items[it] || 0), 0);
        const projected = inSheet + inShed + inPend - before[it];
        let qty = 0;
        if (!a.skip) {
          const target = a.extendedFrom ? Math.max(cfg.par[it], need[it]) : cfg.par[it];
          const short = target - projected;
          if (short > 0) {
            const u = UNIT[it];
            const units = cfg.small ? Math.floor(short / u) : a.extendedFrom && need[it] > cfg.par[it] ? Math.ceil(short / u) : Math.round(short / u);
            qty = Math.max(0, units) * u;
          }
        }
        const after = projected + qty;
        rows.push({ item: it, sheet: inSheet, shed: inShed, pending: inPend, before: before[it], projected, qty, after, par: cfg.par[it], need: need[it], short: after < need[it] });
      }
      a.facilities.push({ f, label: cfg.label, rows, cleanings: cl.map(c => ({ date: c.date, n: c.n, k: c.k, basis: c.basis })) });
    }
    out.areas.push(a);
  }
  out.text = orderText(out);
  return out;
}

/** ゆーかさんに送る本文（いつもの書式） */
export function orderText(o) {
  const parts = [];
  for (const a of o.areas) {
    if (a.skip) { parts.push(`${a.area}は連泊中\n納品＆回収なし`); continue; }
    let s = `📋 ${a.area} ${md(a.delivery)}\n`;
    for (const f of a.facilities) {
      s += `\n【${f.label}】\n` + f.rows.map(r => `${r.item}　${r.qty}`).join("\n") + "\n";
    }
    parts.push(s.trim());
  }
  return parts.join("\n\n") + "\n\nよろしくお願いします。";
}

// ---- SORA カード ----
const T = (text, o = {}) => ({ type: "text", text: String(text), wrap: true, size: "xs", ...o });
function card(o, id) {
  const body = [];
  for (const a of o.areas) {
    body.push(T(a.skip ? `${a.area}：${mdw(a.delivery)} 連泊中のため納品なし` : `${a.area}：${mdw(a.delivery)} 納品 → ${mdw(a.next)}まで${a.extendedFrom ? `（${md(a.extendedFrom)}は連泊でスキップ見込み）` : ""}`, { weight: "bold", size: "sm", margin: body.length ? "lg" : "none" }));
    for (const f of a.facilities) {
      const cl = f.cleanings.map(c => `${md(c.date)} ${c.n}名${c.k}泊`).join("・") || "清掃なし";
      body.push(T(`【${f.label}】清掃 ${cl}`, { color: "#555555", margin: "sm" }));
      for (const r of f.rows) {
        if (!r.qty && !r.short) continue;
        const stock = `${r.sheet}${r.shed ? `+小屋${r.shed}` : ""}${r.pending ? `+入荷待${r.pending}` : ""}`;
        body.push(T(`${r.short ? "⚠️" : "・"}${r.item} 在庫${stock}−使用${r.before}=${r.projected} → +${r.qty}＝${r.after}（常備${r.par}${r.short ? `／次回まで${r.need}必要` : ""}）`, { color: r.short ? "#c0392b" : "#333333" }));
      }
    }
  }
  const btn = (label, action, style = "secondary") => ({ type: "button", style, height: "sm", action: { ...action, label } });
  return {
    type: "flex", altText: `リネン発注案 ${md(o.today)}`,
    contents: { type: "bubble", size: "giga",
      header: { type: "box", layout: "vertical", backgroundColor: "#1a1a1a", paddingAll: "12px", contents: [T(`🧺 リネン発注案 ${mdw(o.today)}`, { color: "#ffffff", weight: "bold", size: "md" }), T("9:30までにゆーかさんへ", { color: "#cccccc" })] },
      body: { type: "box", layout: "vertical", spacing: "xs", contents: body },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
        o.group
          ? btn("ゆーかさんのグループに送る", { type: "postback", data: `linen=${id}&a=send`, displayText: "ゆーかさんのグループに送る" }, "primary")
          : btn("ゆーかさんに送る", { type: "uri", uri: `${o.baseUrl}/linen/share?id=${id}` }, "primary"),
        { type: "box", layout: "horizontal", spacing: "sm", contents: [
          btn("数量を直す", { type: "postback", data: `linen=${id}&a=edit`, displayText: "数量を直す" }),
          btn("今回は送らない", { type: "postback", data: `linen=${id}&a=skip`, displayText: "今回は送らない" })
        ] }
      ] }
    }
  };
}
const target = env => env.SORA_TARGET_ID || env.OWNER_USER_ID;
const draftKey = id => `linen:draft:${id}`;
const todayKey = d => `linen:today:${d}`;

async function pushDraft(env, o, { reply } = {}) {
  const id = o.id || crypto.randomUUID().replace(/-/g, "");
  o.id = id; o.baseUrl = BASE_URL(env); o.group = !!env.LINE_GROUP_LINEN; // グループIDがあれば HARU から直接投稿
  await env.KV.put(draftKey(id), JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 14 });
  await env.KV.put(todayKey(o.today), id, { expirationTtl: 60 * 60 * 24 * 2 });
  const msgs = [card(o, id), { type: "text", text: o.text }];
  if (reply) await sora(env).replyRaw(reply, msgs); else await sora(env).pushMessages(target(env), msgs);
  return id;
}

/** cron（毎朝9:00）：今日が発注日なら案を出す */
export async function runLinenOrder(env, { force = false, nominal } = {}) {
  if (env.LINEN_ORDER !== "on" && !force) return { skipped: "LINEN_ORDER が on ではありません" };
  const today = todayJST();
  nominal ||= await orderNominalFor(env, today);
  if (!nominal) return { skipped: "発注日ではありません", today };
  if (!force && await env.KV.get(todayKey(today))) return { skipped: "本日分は送信済み", today };
  const o = await computeOrder(env, { today, nominal });
  const id = await pushDraft(env, o);
  return { ok: true, id, nominal, text: o.text };
}

/** 5分ごと：9:20を過ぎても送っていなければ1回だけ再通知 */
export async function remindLinen(env) {
  if (env.LINEN_ORDER !== "on" || hmJST() < REMIND_AT || hmJST() > "12:00") return;
  const id = await env.KV.get(todayKey(todayJST()));
  if (!id || !(await orderNominalFor(env))) return; // 発注日以外（手動で出した案）は再通知しない
  const o = await env.KV.get(draftKey(id), "json");
  if (!o || o.sentAt || o.skippedAt || o.remindedAt) return;
  o.remindedAt = new Date().toISOString();
  await env.KV.put(draftKey(id), JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 14 });
  await sora(env).pushMessages(target(env), [card(o, id)]).catch(e => console.error("linen remind", e.message));
}

/** ［ゆーかさんに送る］：記録してから LINE の共有画面へ転送 */
export async function handleShare(env, url) {
  const id = url.searchParams.get("id") || "";
  const o = /^[0-9a-f]{32}$/.test(id) && await env.KV.get(draftKey(id), "json");
  if (!o) return new Response("この発注案は見つかりません（期限切れの可能性があります）", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!o.sentAt && !o.skippedAt) {
    o.sentAt = new Date().toISOString();
    await env.KV.put(draftKey(id), JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 60 });
    await recordOrder(env, o).catch(e => console.error("linen record", e.message));
  }
  return Response.redirect(`https://line.me/R/share?text=${encodeURIComponent(o.text)}`, 302);
}

/** 発注の記録：富士宮は小屋へ、静岡は在庫シート（翌日加算）と入荷待ちへ */
async function recordOrder(env, o) {
  const pend = ((await env.KV.get(PENDING, "json")) || []).filter(p => p.apply > todayJST());
  for (const a of o.areas) {
    if (a.skip) continue;
    for (const f of a.facilities) {
      const items = Object.fromEntries(f.rows.filter(r => r.qty > 0).map(r => [r.item, r.qty]));
      if (!Object.keys(items).length) continue;
      if (a.area === "富士宮") { await shedAdd(env, f.f, items); continue; }
      const apply = add(a.delivery, 1);
      pend.push({ apply, f: f.f, items, id: o.id });
      await fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: "saveOrder", deliveryDate: apply.replace(/-/g, "/"),
        orders: Object.entries(items).map(([name, qty]) => ({ facility: f.f, name, qty, deliveryDate: apply.replace(/-/g, "/") }))
      }) });
    }
  }
  await env.KV.put(PENDING, JSON.stringify(pend));
}

// ---- SORA の操作 ----
const editMode = { key: u => `linen:edit:${u}` };
const NAME_MAP = { "サクヤ": "サクヤ", "さくや": "サクヤ", "桜ハウス": "桜ハウス", "SAKURA": "桜ハウス", "nel": "nel.shizuoka", "ネル": "nel.shizuoka", "ねる": "nel.shizuoka" };

/** postback linen=… */
export async function handleLinenPostback(env, event, pp) {
  const line = sora(env), id = pp.get("linen"), a = pp.get("a");
  const o = await env.KV.get(draftKey(id), "json");
  if (!o) { await line.reply(event.replyToken, "この発注案は期限切れです。「リネン発注案」で作り直せます。"); return; }
  if (o.sentAt) { await line.reply(event.replyToken, `この発注は ${new Date(o.sentAt).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" })} に送信・記録済みです。`); return; }
  if (a === "send") {
    if (!env.LINE_GROUP_LINEN) { await line.reply(event.replyToken, "リネン業者グループが未設定です。"); return; }
    o.sentAt = new Date().toISOString();
    await env.KV.put(draftKey(id), JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 60 });
    try { await haru(env).push(env.LINE_GROUP_LINEN, o.text); }
    catch (e) { o.sentAt = null; await env.KV.put(draftKey(id), JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 14 }); await line.reply(event.replyToken, `⚠️ 送信できませんでした：${e.message.slice(0, 120)}`); return; }
    await recordOrder(env, o).catch(e => console.error("linen record", e.message));
    await line.reply(event.replyToken, "✅ ゆーかさんのグループに送信し、発注を記録しました。");
    return;
  }
  if (a === "skip") {
    o.skippedAt = new Date().toISOString();
    await env.KV.put(draftKey(id), JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 14 });
    await line.reply(event.replyToken, "今回は送らない扱いにしました（記録もしません）。");
    return;
  }
  if (a === "edit") {
    await env.KV.put(editMode.key(event.source.userId), id, { expirationTtl: 1800 });
    await line.reply(event.replyToken, "直したい品目だけ、次の形で送ってください（30分以内）。\n\nサクヤ\nバスタオル 40\nフェイスタオル 20\n\n「やめる」で中止");
  }
}

/** 数量修正の入力待ち。処理したら true */
export async function handleLinenEditText(env, event) {
  const u = event.source.userId;
  const id = u && await env.KV.get(editMode.key(u));
  if (!id) return false;
  const line = sora(env), text = event.message.text.trim();
  if (text === "やめる" || text === "キャンセル") { await env.KV.delete(editMode.key(u)); await line.reply(event.replyToken, "修正を中止しました。"); return true; }
  const o = await env.KV.get(draftKey(id), "json");
  if (!o || o.sentAt) { await env.KV.delete(editMode.key(u)); return false; }
  let cur = null, changed = 0;
  const z = text.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
  for (const raw of z.split("\n")) {
    const l = raw.trim(); if (!l) continue;
    const it = ITEMS.find(i => l.includes(i));
    const fk = Object.keys(NAME_MAP).find(k => l.includes(k));
    if (fk && !it) { cur = NAME_MAP[fk]; continue; }
    const m = l.match(/(\d+)/);
    if (!it || !m) continue;
    const f = fk ? NAME_MAP[fk] : cur;
    for (const a of o.areas) for (const fa of a.facilities) if (fa.f === f) {
      const r = fa.rows.find(r => r.item === it);
      if (r) { r.qty = Number(m[1]); r.after = r.projected + r.qty; r.short = r.after < r.need; changed++; }
    }
  }
  if (!changed) { await line.reply(event.replyToken, "読み取れませんでした。物件名の行のあとに「品目 数量」を1行ずつ書いてください。「やめる」で中止。"); return true; }
  await env.KV.delete(editMode.key(u));
  o.text = orderText(o);
  await pushDraft(env, o, { reply: event.replyToken });
  return true;
}

/** SORAのテキストコマンド。処理したら true */
export async function handleLinenCommand(env, event, text) {
  const line = sora(env);
  if (text === "リネン発注案") {
    const today = todayJST();
    let nominal = await orderNominalFor(env, today);
    if (!nominal) for (let i = 1; i <= 7 && !nominal; i++) if (ORDER_DOW[dow(add(today, i))]) nominal = add(today, i);
    const o = await computeOrder(env, { today, nominal });
    await pushDraft(env, o, { reply: event.replyToken });
    return true;
  }
  if (text === "小屋" || text === "小屋在庫") {
    const s = await shedGet(env);
    const lines = Object.entries(s).map(([f, it]) => `【${FAC[f]?.label || f}】\n` + (Object.entries(it).filter(([, q]) => q > 0).map(([n, q]) => `${n}　${q}`).join("\n") || "なし"));
    await line.reply(event.replyToken, `🛖 物置小屋（発注済み・未補充）\n${lines.join("\n") || "なし"}\n\nスタッフが「補充」すると自動で減ります。合わないときは「小屋クリア」。`);
    return true;
  }
  if (text.startsWith("小屋登録")) {
    // 手で送った発注（いつもの書式をそのまま貼る）を小屋に加える。富士宮の物件だけ対象
    const add = {}; let cur = null;
    for (const raw of text.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).split("\n").slice(1)) {
      const l = raw.trim(); if (!l) continue;
      const it = ITEMS.find(i => l.includes(i));
      const fk = Object.keys(NAME_MAP).find(k => l.includes(k));
      if (fk && !it) { cur = NAME_MAP[fk]; continue; }
      const m = l.match(/(\d+)\s*$/);
      if (it && m && cur && FAC[cur].area === "富士宮" && Number(m[1]) > 0) (add[cur] ||= {})[it] = (add[cur]?.[it] || 0) + Number(m[1]);
    }
    if (!Object.keys(add).length) { await line.reply(event.replyToken, "読み取れませんでした。1行目に「小屋登録」、続けて発注文（【サクヤ】の行と「品目 数量」の行）を貼ってください。"); return true; }
    for (const [f, items] of Object.entries(add)) await shedAdd(env, f, items);
    await line.reply(event.replyToken, "🛖 小屋に登録しました\n" + Object.entries(add).map(([f, it]) => `【${FAC[f].label}】\n` + Object.entries(it).map(([n, q]) => `${n}　+${q}`).join("\n")).join("\n"));
    return true;
  }
  if (text === "小屋クリア") { await shedClear(env); await line.reply(event.replyToken, "物置小屋の記録を0にしました。"); return true; }
  return false;
}
