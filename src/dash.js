// ダッシュボード（LIFF）: 画面案④に沿った「今日」（KPI・要対応・物件ごとの動き）、明日、今週、売上（許可ユーザーのみ）
import { BEDS24_PROPERTIES, getToken, getBookings, formatDateYMD, addDays, fetchPropertyMap, sendGuestMessage, fetchThread } from "./beds24.js";
import { props as propsCache, normalizeProperty, pricelog } from "./store.js";
import { todayCleaningStatus } from "./cleanlog.js";
import { sora } from "./line.js";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });

async function verifyIdToken(env, idToken) {
  if (!idToken || !env.LINE_LOGIN_CHANNEL_ID) return null;
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: env.LINE_LOGIN_CHANNEL_ID })
  });
  if (!res.ok) return null;
  const d = await res.json();
  return { userId: d.sub, name: d.name || "" };
}
const allow = (env, key, userId) => userId === env.OWNER_USER_ID || (env[key] || "").split(",").map(s => s.trim()).includes(userId);

const guestName = b => `${b.firstName || ""} ${b.lastName || ""}`.trim() || "ゲスト";
const pax = b => (b.numAdult || 0) + (b.numChild || 0);
const nights = b => Math.round((Date.parse(b.departure) - Date.parse(b.arrival)) / 86400000);
const CHECKIN = { "サクヤ": "16:00", "桜ハウス": "16:00", "nel.shizuoka": "16:00" };
const CHECKOUT = "10:00";
const hhmm = iso => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const label = ymd => { const [y, m, d] = ymd.split("-").map(Number); return `${m}/${d}（${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`; };

// 全物件（Beds24）。先頭は清掃ボタンのある3物件、残りは名前順。New Property は除外
async function allProperties(env, token) {
  let map = await propsCache.get(env.KV);
  if (!map) { map = await fetchPropertyMap(token); await propsCache.set(env.KV, map); }
  const main = Object.keys(BEDS24_PROPERTIES);
  const names = {};
  for (const [id, n] of Object.entries(map)) { if (/new property/i.test(n)) continue; names[String(id)] = normalizeProperty(n); }
  const order = [...main.map(n => Object.keys(names).find(id => names[id] === n)).filter(Boolean), ...Object.keys(names).filter(id => !main.includes(names[id])).sort((a, b) => names[a].localeCompare(names[b]))];
  return { names, order };
}
const DISPLAY = { "The Bunkhouse Nagoya": "Bunkhouse", "SimpleStayShibuyaShinjyuku": "SimpleStay", "SimpleStay Shibuya Shinjyuku": "SimpleStay", "アパートメントねね": "ねね" };
const disp = n => DISPLAY[n] || n;
const groupBy = (list, names) => { const g = {}; for (const b of list) (g[names[String(b.propertyId)] || String(b.propertyId)] ||= []).push(b); return g; };
const monthRange = (d) => { const y = d.getFullYear(), m = d.getMonth(); const s = new Date(Date.UTC(y, m, 1)), e = new Date(Date.UTC(y, m + 1, 0)); return { from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10), label: `${y}年${m + 1}月`, days: e.getUTCDate() }; };

// 名簿：Beds24名簿を使う予約（GUESTLINKあり）だけ判定。GUESTDONE があれば済
function registry(b) {
  const items = b.infoItems || [];
  const uses = items.some(i => /GUESTLINK|GUESTREGISTRATIONID/i.test(i.code || ""));
  if (!uses) return "n/a";
  return items.some(i => /GUESTDONE/i.test(i.code || "")) ? "done" : "missing";
}
const fmtBooking = b => ({ id: b.id, name: guestName(b), pax: pax(b), nights: nights(b), channel: b.channel || b.referer || "直", registry: registry(b), arrival: b.arrival, departure: b.departure });

/** 1日分（今日／明日） */
export async function dayData(env, date) {
  const token = await getToken(env);
  const cleaning = await todayCleaningStatus(env, date);
  const { names, order } = await allProperties(env, token);
  const ok = b => b.status !== "cancelled";
  const [arr, dep] = await Promise.all([
    getBookings(token, `arrivalFrom=${date}&arrivalTo=${date}&includeInfoItems=true`),
    getBookings(token, `departureFrom=${date}&departureTo=${date}`)
  ]);
  const gA = groupBy(arr.filter(ok), names), gD = groupBy(dep.filter(ok), names);
  const rows = [];
  const kpi = { in: 0, out: 0, clean: 0, registryMissing: 0, reply: 0, cleanPending: 0 };
  const todo = [];
  for (const id of order) {
    const name = names[id];
    const ins = (gA[name] || []).map(fmtBooking), outs = (gD[name] || []).map(fmtBooking);
    kpi.in += ins.length; kpi.out += outs.length;
    const c = cleaning[name];
    const hasButtons = !!BEDS24_PROPERTIES[name];
    let clean = { state: "none", text: "—" };
    if (outs.length) {
      kpi.clean++;
      if (!hasButtons) clean = { state: "unknown", text: "記録外" };
      else if (c?.endAt) clean = { state: "done", text: `完了 ${hhmm(c.endAt)}`, by: c.endBy };
      else if (c?.startAt) clean = { state: "working", text: `作業中 ${hhmm(c.startAt)}〜`, by: c.startBy };
      else clean = { state: "pending", text: "未着手" };
      if (clean.state === "pending" || clean.state === "working") kpi.cleanPending++;
    }
    const inText = ins.length ? (c?.early?.time && c.early.results?.some(r => !r.test) ? `${c.early.time}〜` : (CHECKIN[name] || "—")) : (outs.length ? "—" : "—");
    const stay = !ins.length && !outs.length;
    rows.push({ property: disp(name), out: outs.length ? CHECKOUT : (stay ? "" : "—"), clean: clean.text, cleanState: clean.state, in: ins.length ? inText : "—", inMissing: ins.some(x => x.registry === "missing"), stay, ins, outs });
    for (const x of ins) {
      if (x.registry === "missing") { kpi.registryMissing++; todo.push({ kind: "registry", property: disp(name), bookingId: x.id, guest: x.name, text: `名簿未提出　IN ${CHECKIN[name] || ""}`.trim() }); }
    }
  }
  // 未返信カード
  try {
    const l = await env.KV.list({ prefix: "card:" });
    const cardsAll = await Promise.all(l.keys.slice(0, 100).map(k => env.KV.get(k.name, "json")));
    for (const card of cardsAll) {
      if (card?.status === "pending" && !card.test) kpi.reply++; // 一覧には出さない（返信はSORAで行う）
    }
  } catch {}
  const ttLast = await env.KV.get("tt:last", "json");
  return { date, label: label(date), kpi, todo, rows, timetree: ttLast };
}

/** 今週（今日から7日）：日ごと・物件ごとの IN/OUT */
export async function weekData(env) {
  const token = await getToken(env);
  const from = formatDateYMD(new Date()), to = formatDateYMD(addDays(new Date(), 6));
  const { names, order } = await allProperties(env, token);
  const ok = b => b.status !== "cancelled";
  const [arr, dep] = await Promise.all([
    getBookings(token, `arrivalFrom=${from}&arrivalTo=${to}`),
    getBookings(token, `departureFrom=${from}&departureTo=${to}`)
  ]);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = formatDateYMD(addDays(new Date(), i));
    const row = { date: d, label: label(d), props: [] };
    for (const id of order) {
      const name = names[id];
      const ins = arr.filter(b => ok(b) && String(b.propertyId) === id && b.arrival === d);
      const outs = dep.filter(b => ok(b) && String(b.propertyId) === id && b.departure === d);
      if (ins.length || outs.length) row.props.push({ property: disp(name), in: ins.length ? `${pax(ins[0])}名${nights(ins[0])}泊` : "", out: outs.length ? "OUT" : "" });
    }
    days.push(row);
  }
  return { from, to, days };
}

/** 売上タブ（当月〜5か月先、物件別、ADR） */
export async function salesData(env) {
  const token = await getToken(env);
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const months = [0, 1, 2, 3, 4, 5].map(k => monthRange(new Date(now.getFullYear(), now.getMonth() + k, 1))); // 当月〜5か月先
  const { names, order } = await allProperties(env, token);
  const lists = await Promise.all(months.map(m => getBookings(token, `arrivalFrom=${m.from}&arrivalTo=${m.to}`)));
  const out = [];
  for (const [idx, m] of months.entries()) {
    const row = { month: m.label, props: {}, total: 0, nightsTotal: 0 };
    const all = lists[idx].filter(b => b.status !== "cancelled");
    const g = groupBy(all, names);
    for (const id of order) {
      const name = names[id];
      const list = g[name] || [];
      const revenue = list.reduce((s, b) => s + (Number(b.price) || 0), 0);
      const n = list.reduce((s, b) => s + nights(b), 0);
      row.props[disp(name)] = { bookings: list.length, nights: n, occupancy: Math.round((n / m.days) * 100), revenue: Math.round(revenue), adr: n ? Math.round(revenue / n) : 0 };
      row.total += revenue; row.nightsTotal += n;
    }
    row.total = Math.round(row.total);
    row.adr = row.nightsTotal ? Math.round(row.total / row.nightsTotal) : 0;
    out.push(row);
  }
  return { months: out, at: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) };
}

/** カレンダー（ガント）：start から days 日分、全物件の予約バー */
export async function calendarData(env, start, days = 28) {
  const token = await getToken(env);
  const { names, order } = await allProperties(env, token);
  const end = formatDateYMD(addDays(new Date(Date.parse(start + "T00:00:00Z")), days - 1));
  // 期間に少しでも重なる予約：到着 ≤ 終了日 かつ 出発 ≥ 開始日
  const list = (await getBookings(token, `arrivalTo=${end}&departureFrom=${start}&includeInfoItems=true`)).filter(b => b.status !== "cancelled" && b.arrival && b.departure);
  const dayList = [];
  for (let i = 0; i < days; i++) { const d = formatDateYMD(addDays(new Date(Date.parse(start + "T00:00:00Z")), i)); const [y, m, dd] = d.split("-").map(Number); dayList.push({ d, m, dd, dow: new Date(Date.UTC(y, m - 1, dd)).getUTCDay() }); }
  const chan = b => { const c = String(b.channel || b.referer || "").toLowerCase(); return /airbnb/.test(c) ? "airbnb" : /booking|agoda|expedia/.test(c) ? "booking" : "direct"; };
  const bookings = list.map(b => ({ ...fmtBooking(b), prop: disp(names[String(b.propertyId)] || String(b.propertyId)), chan: chan(b) }));
  return { start, end, days: dayList, today: formatDateYMD(new Date()), props: order.map(id => disp(names[id])), bookings };
}

/** 予約1件の詳細（カレンダーのタップ用）：基本情報＋直近メッセージ＋開くためのリンク。鍵の番号は含めない */
export async function bookingDetail(env, bookingId) {
  const token = await getToken(env);
  const b = ((await getBookings(token, `id=${bookingId}&includeInfoItems=true`)) || [])[0];
  if (!b) return { error: "予約が見つかりません" };
  const { names } = await allProperties(env, token);
  let thread = [];
  try { thread = (await fetchThread(token, b.id, 120)).map(t => ({ from: t.source === "guest" ? "guest" : "host", text: String(t.message || "").trim(), time: t.time })).filter(m => m.text).sort((x, y) => Date.parse(x.time) - Date.parse(y.time)).slice(-8); } catch {}
  const c = String(b.channel || b.referer || "").toLowerCase();
  const links = [{ label: "Beds24で開く", url: `https://beds24.com/control3.php?pagetype=bookingedit&bookid=${b.id}` }];
  if (/airbnb/.test(c) && b.apiReference) links.unshift({ label: "Airbnbで開く", url: `https://www.airbnb.jp/hosting/reservations/details/${encodeURIComponent(b.apiReference)}` });
  if (/booking/.test(c)) links.unshift({ label: "Booking.comで開く", url: "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/search_reservations.html?term=" + encodeURIComponent(b.apiReference || "") });
  return { ...fmtBooking(b), prop: disp(names[String(b.propertyId)] || String(b.propertyId)), price: Number(b.price) || 0, status: b.status, notes: (b.notes || "").slice(0, 300), comments: (b.comments || "").slice(0, 300), thread, links };
}

// ---- キャッシュ（今日2分・売上30分）。cron でも先回りして計算しておく ----
async function cached(env, key, ttl, fn, force = false) {
  if (!force) { const v = await env.KV.get(key, "json"); if (v) return { ...v, cached: true }; }
  const v = await fn();
  await env.KV.put(key, JSON.stringify(v), { expirationTtl: ttl });
  return v;
}
export const cachedToday = (env, force) => cached(env, "dash:today:" + formatDateYMD(new Date()), 120, () => dayData(env, formatDateYMD(new Date())), force);
export const cachedSales = (env, force) => cached(env, "dash:sales", 1800, () => salesData(env), force);
export const cachedKpi = (env, force) => cached(env, "dash:kpi", 6 * 3600, async () => (await import("./kpi.js")).kpiData(env), force);
/** cron から：ダッシュボードの中身を先に計算しておく */
export async function warmDashboard(env, { sales = false } = {}) {
  try { await cachedToday(env, true); } catch (e) { console.error("warm today", e.message); }
  if (sales) {
    try { await cachedSales(env, true); } catch (e) { console.error("warm sales", e.message); }
    try { await cachedKpi(env, true); } catch (e) { console.error("warm kpi", e.message); }
  }
}

/** 名簿の再催促（Beds24経由でゲストへ。鍵の番号は送らない） */
async function remindRegistry(env, bookingId, by) {
  const token = await getToken(env);
  const b = ((await getBookings(token, `id=${bookingId}&includeInfoItems=true`)) || [])[0];
  if (!b) return { error: "予約が見つかりません" };
  const link = (b.infoItems || []).find(i => /GUESTLINK/i.test(i.code || ""))?.text || "";
  const msg = `${guestName(b)} 様\n\n本日のご宿泊にあたり、宿泊者名簿のご登録がまだ確認できておりません。旅館業法により、宿泊者全員の名簿登録が必要です。\n下記よりご登録をお願いいたします。\n${link}\n\nご登録の確認後、入室方法をお送りします。`;
  await sendGuestMessage(token, b.id, msg);
  try { await env.KV.delete("dash:today:" + formatDateYMD(new Date())); } catch {}
  try { await sora(env).push(env.SORA_TARGET_ID || env.OWNER_USER_ID, `📨 名簿の再催促を送信：${guestName(b)}様（${b.arrival}）${by ? "　by " + by : ""}`); } catch {}
  return { ok: true };
}

export async function todayData(env) { return dayData(env, formatDateYMD(new Date())); }

export async function handleDash(request, env, url) {
  const path = url.pathname;
  if (path === "/liff/dash" && request.method === "GET") {
    const id = env.LIFF_DASH_ID || env.LIFF_ID;
    if (!id) return new Response("LIFF_ID が未設定です", { status: 503 });
    return new Response(PAGE.replace("__LIFF_ID__", id), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path === "/liff/dash/data" && request.method === "POST") {
    const { idToken, tab, force, start, bookingId } = await request.json();
    const u = await verifyIdToken(env, idToken);
    if (!u) return json({ error: "ログイン情報を確認できません" }, 401);
    if (!allow(env, "DASH_ALLOW", u.userId)) return json({ error: "閲覧権限がありません" }, 403);
    const canSales = allow(env, "SALES_ALLOW", u.userId);
    if (tab === "sales") { if (!canSales) return json({ error: "売上の閲覧権限がありません" }, 403); return json({ ...(await cachedSales(env, !!force)), canSales }); }
    if (tab === "kpi") { if (!canSales) return json({ error: "経営指標の閲覧権限がありません" }, 403); const [k, pl, sl] = await Promise.all([cachedKpi(env, !!force), pricelog.list(env.KV, 30), cachedSales(env, !!force).catch(() => null)]); return json({ ...k, pricelog: pl, sales: sl, canSales }); }
    if (tab === "week") return json({ ...(await weekData(env)), canSales });
    if (tab === "cal") { const st = /^\d{4}-\d{2}-\d{2}$/.test(start || "") ? start : formatDateYMD(addDays(new Date(), -2)); return json({ ...(await calendarData(env, st, 28)), canSales }); }
    if (tab === "detail") return json({ ...(await bookingDetail(env, bookingId)), canSales });
    if (tab === "tomorrow") return json({ ...(await dayData(env, formatDateYMD(addDays(new Date(), 1)))), canSales });
    return json({ ...(await cachedToday(env, !!force)), canSales });
  }
  if (path === "/liff/dash/remind" && request.method === "POST") {
    const { idToken, bookingId } = await request.json();
    const u = await verifyIdToken(env, idToken);
    if (!u || !allow(env, "DASH_ALLOW", u.userId)) return json({ error: "権限がありません" }, 403);
    return json(await remindRegistry(env, bookingId, u.name));
  }
  return new Response("Not found", { status: 404 });
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>ダッシュボード</title>
<style>
:root{--red:#2a4d69;--ink:#1a1a1a;--mut:#6b6b6b;--bg:#f3f5f7;--line:#dfe4ea;--acc2:#9fb3c8}
body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;background:var(--bg);color:var(--ink)}
.hdr{background:var(--bg);padding:10px 12px 8px;position:sticky;top:0;z-index:5}
.hdr .brand{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:var(--mut);padding:0 2px 4px;white-space:nowrap}
.hdr .brand b{font-size:15px;color:var(--red);letter-spacing:.02em}
.hdr .brand .upd{font-size:11px;overflow:hidden;text-overflow:ellipsis}
.hdr .top{display:flex;justify-content:space-between;align-items:center;font-size:22px;font-weight:800;padding:0 2px}
.hdr .tabs{display:flex;gap:2px;margin-top:8px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:4px}
.hdr .tabs::-webkit-scrollbar{display:none}
.hdr .tabs button{flex:1 1 0;min-width:0;border:0;background:transparent;border-radius:9px;padding:9px 0;font-size:12.5px;letter-spacing:-.02em;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hdr .tabs button.on{background:var(--red);color:#fff}
#refresh{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 10px;font-size:12px}
.sec{font-size:12px;letter-spacing:.14em;color:var(--red);font-weight:800;margin:10px 0 -8px 2px}
.sec+.h{font-size:20px;font-weight:800;margin:8px 0 0 2px}.h small{font-weight:400;color:var(--mut);font-size:12px;margin-left:6px;display:inline-block}
.cards2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kc{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px}
.kc.hi{border:2px solid var(--red)}
.kc .t{font-size:12px;color:var(--mut)}.kc .v{font-size:30px;font-weight:800;margin:4px 0 2px;letter-spacing:-.01em}.kc .v small{font-size:14px;font-weight:700;margin-left:2px}.kc.hi .v{color:var(--red)}
.kc .d{font-size:12px;color:var(--mut);line-height:1.5}.up{color:#1e7a3c}.dn{color:#c0392b}
.chart{background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px}
.chart svg{width:100%;height:auto;display:block}
.lg{display:flex;gap:12px;font-size:11px;color:var(--mut);padding:0 2px 6px}.lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.tbl{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tbl table{width:100%;border-collapse:collapse;font-size:12px}
.tbl th,.tbl td{padding:8px 6px;border-bottom:1px solid #eee;text-align:right;vertical-align:top}
.tbl th{background:#f6f8fa;color:var(--mut);font-weight:700;font-size:11px}
.tbl td:first-child,.tbl th:first-child{text-align:left;font-weight:700;white-space:nowrap;position:sticky;left:0;background:#fff;z-index:1}
.tbl td .s,.tbl th .s{display:block;font-size:10px;font-weight:400}
.tbl tr.tot td{background:#f9fafb;font-weight:700}
.tbl .cur td{background:#eef3f8}
.seg{display:flex;flex-direction:column;gap:8px;margin:4px 0}.seg button{border:1px solid var(--line);background:#fff;border-radius:10px;padding:12px 10px;font-size:15px;font-weight:700;text-align:left;color:var(--ink)}.seg button.on{background:var(--red);border-color:var(--red);color:#fff}
.kt{max-height:calc(100vh - 215px);overflow:auto}.kt thead th{position:sticky;top:0;z-index:3;background:#f6f8fa}.kt thead th.pc,.kt thead th.mc{z-index:4}.kt table{font-size:15px}.kt th,.kt td{padding:12px 10px;white-space:nowrap}.kt td{font-weight:700;line-height:1.3}.kt td .s{font-size:13px;font-weight:600;margin-top:2px}.kt th .s{font-size:12px}
.kt .pc{position:sticky;left:0;background:#fff;z-index:2;width:84px;min-width:84px;max-width:84px;box-sizing:border-box;white-space:normal;word-break:break-all;font-weight:800;font-size:13px;line-height:1.25;padding:10px 6px !important;border-right:1px solid var(--line)}.kt .pc small{display:block;font-weight:400;color:var(--mut);font-size:12px;margin-top:2px}
.kt .mc{position:sticky;left:84px !important;background:#fff;z-index:2;color:var(--ink);font-weight:700;font-size:13px;text-align:left;border-right:1px solid var(--line);width:62px;min-width:62px;max-width:62px;box-sizing:border-box;padding:10px 6px !important}
.kt tr.grp td{border-top:2px solid var(--line)}.kt tr.tot .pc,.kt tr.tot .mc{background:#f9fafb}.kt th.pc,.kt th.mc{background:#f6f8fa;z-index:3}.kt th.curcol,.kt td.curcol{background:#eef3f8}
.rank{display:inline-block;width:26px;height:26px;line-height:26px;border-radius:6px;color:#fff;font-weight:800;text-align:center;font-size:14px}
.rA{background:#1e7a3c}.rB{background:#2a7a6f}.rC{background:#b36b00}.rD{background:#c0392b}
.hl{display:flex;flex-direction:column;gap:8px}
.hl p{margin:0;background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:15px;line-height:1.65}
.hl .tag{display:inline-block;background:var(--ink);color:#fff;font-size:11px;border-radius:4px;padding:2px 7px;margin-right:8px;vertical-align:2px;font-weight:700}.hl .tag.w{background:#c0392b}
.pace .row2{display:grid;grid-template-columns:70px 1fr 110px;gap:10px;align-items:center;font-size:15px;font-weight:700;padding:12px 0;border-bottom:1px solid #eee}.pace .row2:last-child{border-bottom:0}
.pace .bars{position:relative;height:24px}.pace .bars i{position:absolute;left:0;height:9px;border-radius:2px}.pace .bars .b1{top:1px;background:var(--red)}.pace .bars .b2{top:14px;background:#cfd8e3}
.pace .pv{text-align:right;font-weight:800;font-size:17px}.pace .pv small{display:block;font-weight:400;color:var(--mut);font-size:11px;margin-top:2px}
.heat td{text-align:center;font-weight:800;font-size:15px}.heat th{text-align:center}
.note{font-size:11px;color:var(--mut);padding:0 4px}
.wrap{padding:12px;max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.wrap.kpiwrap{gap:12px}
.kpiwrap .tbl{overflow-x:auto}.kpiwrap .tbl table{font-size:14px;min-width:100%}.kpiwrap .tbl th{font-size:12px;padding:10px 8px;white-space:nowrap}.kpiwrap .tbl td{padding:12px 8px;font-weight:700;white-space:nowrap}.kpiwrap .tbl td .s{font-size:12px;font-weight:600}
.kpiwrap .lg{font-size:12px}.kpiwrap .note{font-size:12px;line-height:1.6}
.kpi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.kpi div{background:#fff;border-radius:10px;padding:10px 6px;text-align:center}
.kpi b{display:block;font-size:24px}
.kpi small{font-size:11px;color:#6b6b6b}
.kpi .warn{border:2px solid #c0392b}.kpi .warn b,.kpi .warn small{color:#c0392b}
.card{background:#fff;border-radius:10px;overflow:hidden}
.card h3{margin:0;padding:10px 14px;font-size:13px;border-bottom:1px solid #e5e5e5}
.row{padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:8px;border-bottom:1px solid #e5e5e5;font-size:13px}
.row:last-child{border-bottom:0}
.row b{display:block}
.red{color:#c0392b}.green{color:#1e7a3c}.muted{color:#6b6b6b}
.btn{min-height:44px;padding:0 12px;border:1px solid #1a1a1a;background:#fff;border-radius:8px;font-size:12px;font-weight:700}
.btn.dark{background:#1a1a1a;color:#fff}
.grid{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;font-size:13px;padding:9px 14px;border-bottom:1px solid #e5e5e5;gap:4px}
.grid.h{font-size:12px;color:#6b6b6b;padding:6px 14px}
.grid span:first-child{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.foot{background:#fff;border-radius:10px;padding:10px 14px;font-size:12px;color:#6b6b6b;display:flex;justify-content:space-between;gap:8px}
.nav{display:flex;gap:6px}
.nav button{flex:1;min-height:40px;border:1px solid var(--line);background:#fff;border-radius:10px;font-size:14px;font-weight:700;color:var(--ink)}
.nav button.on{background:var(--red);border-color:var(--red);color:#fff}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 4px;border-bottom:1px solid #eee;text-align:right}
td:first-child,th:first-child{text-align:left}
.big{font-size:22px;font-weight:700;padding:10px 14px 0}
.cnt{display:flex;gap:8px;padding:10px 12px 0;max-width:560px;margin:0 auto}
.cnt button{flex:1;border:1px solid #d9d9d9;background:#fff;border-radius:10px;padding:8px 4px;font-size:12px;color:#6b6b6b}
.cnt button b{display:block;font-size:20px;color:#1a1a1a}
.cnt button.warn{border-color:#c0392b}.cnt button.warn b{color:#c0392b}
.calwrap{background:#fff;border-radius:10px;overflow:hidden}
.calbar{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #e5e5e5;font-size:13px}
.calbar button{min-width:44px;min-height:36px;border:1px solid #1a1a1a;background:#fff;border-radius:8px;font-weight:700}
.legend{display:flex;gap:10px;font-size:11px;color:#6b6b6b;padding:6px 10px;border-bottom:1px solid #e5e5e5}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:3px;vertical-align:-1px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.gantt{position:relative;display:grid}
.gantt .lbl{position:sticky;left:0;background:#fff;z-index:2;font-size:12px;font-weight:700;padding:0 8px;display:flex;align-items:center;border-bottom:1px solid #eee;border-right:1px solid #ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gantt .hd{font-size:10px;text-align:center;color:#6b6b6b;border-bottom:1px solid #ddd;border-left:1px solid #f0f0f0;padding:4px 0;line-height:1.2}
.gantt .hd.sat{color:#1f5fbf}.gantt .hd.sun{color:#c0392b}.gantt .hd.today{background:#fff3cd;font-weight:700;color:#1a1a1a}
.gantt .cell{border-bottom:1px solid #eee;border-left:1px solid #f3f3f3;height:40px}
.gantt .cell.today{background:#fffbe6}
.bar{position:absolute;height:28px;border-radius:6px;color:#fff;font-size:11px;line-height:28px;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;cursor:pointer}
.bar.airbnb{background:#e0455f}.bar.booking{background:#2a5bd7}.bar.direct{background:#7f8c8d}
.bar .reg{position:absolute;right:4px;top:0;font-size:12px}
.sheet{position:fixed;left:0;right:0;bottom:0;background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -4px 20px rgba(0,0,0,.2);max-height:85vh;overflow:auto;padding:14px 16px 24px;z-index:10;max-width:560px;margin:0 auto}
.dim{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9}
.sheet h2{margin:0 0 6px;font-size:16px}
.kv{display:grid;grid-template-columns:70px 1fr;gap:4px 8px;font-size:13px;margin:8px 0}
.kv span:nth-child(odd){color:#6b6b6b}
.acts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
.acts a,.acts button{display:block;text-align:center;min-height:44px;line-height:44px;border-radius:8px;border:1px solid #1a1a1a;background:#fff;color:#1a1a1a;text-decoration:none;font-size:13px;font-weight:700}
.acts .dark{background:#1a1a1a;color:#fff}
.msg{font-size:12px;padding:6px 8px;border-radius:8px;margin:4px 0;max-width:92%}
.msg.guest{background:#f1f1f1}.msg.host{background:#e3f1ff;margin-left:auto}
.msg small{display:block;color:#6b6b6b;font-size:10px}
.sub{padding:0 14px 8px}
</style></head><body>
<div class="hdr"><div class="brand"><b>MFInvestment</b><span class="upd" id="sub"></span></div>
<div class="top"><span id="title">今日</span><button id="refresh" style="display:none" aria-label="最新に更新">更新</button></div>
<div class="tabs" id="tabs"><button data-tab="today">今日</button><button data-tab="cal">カレンダー</button><button data-tab="overview" class="sales" style="display:none">概要</button><button data-tab="kpi" class="sales" style="display:none">KPI</button><button data-tab="props" class="sales" style="display:none">物件</button><button data-tab="pace" class="sales" style="display:none">ペース</button></div></div>
<div class="cnt" id="cnt" style="display:none"></div>
<div class="wrap" id="app">読み込み中…</div>
<div id="sheet"></div>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
const LIFF_ID="__LIFF_ID__";let idToken=null,cur='today',calStart=null,kpiCache=null,kpiSub='money';
const KPI_TABS=['overview','kpi','props','pace'];
const yen=n=>'¥'+Number(n||0).toLocaleString();
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(body){const r=await fetch('/liff/dash/data',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken,...body})});return r.json();}
async function load(tab,force){
  cur=tab;const app=document.getElementById('app');app.textContent='読み込み中…';
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab||(b.dataset.tab==='today'&&(tab==='tomorrow'||tab==='week'))));
  app.classList.toggle('kpiwrap',KPI_TABS.includes(tab));
  let d;
  if(KPI_TABS.includes(tab)){ if(!kpiCache||force){kpiCache=await api({tab:'kpi',force:!!force});} d=kpiCache; }
  else d=await api({tab,force:!!force,start:tab==='cal'?calStart:undefined});
  if(d.error){app.innerHTML='<p class="red">'+esc(d.error)+'</p>';return;}
  if(d.canSales)document.querySelectorAll('#tabs .sales').forEach(b=>b.style.display='');
  const titles={today:'今日　'+(d.label||''),tomorrow:'明日　'+(d.label||''),week:'今週',cal:'カレンダー',overview:'概要',kpi:'月別のKPI',props:'物件',pace:'予約ペース',sales:'売上'};
  document.getElementById('title').textContent=titles[tab]||tab;
  document.getElementById('sub').textContent=KPI_TABS.includes(tab)?(d.at||'')+' 更新':(tab==='sales'&&d.at?d.at+' 時点':'');
  app.innerHTML=tab==='sales'?renderSales(d):tab==='week'?renderWeek(d):tab==='cal'?renderCal(d):tab==='overview'?renderOverview(d):tab==='kpi'?renderKpi(d):tab==='props'?renderProps(d):tab==='pace'?renderPace(d):renderDay(d,tab);
  if(tab==='today')renderCounters(d.kpi);else document.getElementById('cnt').style.display='none';
  if(tab==='cal'){axisLock(app.querySelector('.scroll'));app.querySelectorAll('[data-bk]').forEach(b=>b.onclick=()=>openDetail(b.dataset.bk));app.querySelectorAll('[data-cal]').forEach(b=>b.onclick=()=>{calStart=b.dataset.cal;load('cal');});setTimeout(()=>{const t=app.querySelector('.hd.today');if(t)app.querySelector('.scroll').scrollLeft=Math.max(0,t.offsetLeft-120);},0);}
  if(tab==='kpi'){app.querySelectorAll('[data-seg]').forEach(b=>b.onclick=()=>{kpiSub=b.dataset.seg;load('kpi');});axisLock(app.querySelector('.kt'));const go=()=>{const sc=app.querySelector('.kt');const th=sc&&sc.querySelector('th.curcol');if(th)sc.scrollLeft=Math.max(0,th.getBoundingClientRect().left-sc.getBoundingClientRect().left+sc.scrollLeft-150);};setTimeout(go,30);setTimeout(go,400);}
  app.querySelectorAll('[data-remind]').forEach(b=>b.onclick=async()=>{if(!confirm(b.dataset.guest+'様に名簿の再催促を送りますか？'))return;b.disabled=true;b.textContent='送信中…';const r=await fetch('/liff/dash/remind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken,bookingId:b.dataset.remind})});const j=await r.json();b.textContent=j.ok?'送信済':'失敗';});
  app.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>load(b.dataset.nav));
  const rf=document.getElementById('refresh');rf.style.display='';rf.onclick=()=>load(cur,true);
}
// 表のスクロールを縦か横のどちらか一方に固定する（斜めに流れない）
function axisLock(el){if(!el||el.__axis)return;el.__axis=1;let sx=0,sy=0,sl=0,st=0,axis=null;
  el.addEventListener('touchstart',e=>{const t=e.touches[0];sx=t.clientX;sy=t.clientY;sl=el.scrollLeft;st=el.scrollTop;axis=null;},{passive:true});
  el.addEventListener('touchmove',e=>{const t=e.touches[0];const dx=t.clientX-sx,dy=t.clientY-sy;
    if(!axis){if(Math.abs(dx)<6&&Math.abs(dy)<6)return;axis=Math.abs(dx)>Math.abs(dy)?'x':'y';}
    if(axis==='x'){el.scrollLeft=sl-dx;if(e.cancelable)e.preventDefault();}
    else{const atTop=el.scrollTop<=0&&dy>0,atBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-1&&dy<0;if(el.scrollHeight>el.clientHeight+1&&!atTop&&!atBottom){el.scrollTop=st-dy;if(e.cancelable)e.preventDefault();}}
  },{passive:false});}
const man=n=>(Math.round((n||0)/1000)/10).toLocaleString()+'万円';const manS=n=>(Math.round((n||0)/1000)/10).toLocaleString()+'万';
const yoy=(v,unit='%')=>v==null?'<span class="muted">—</span>':'<span class="'+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+v+unit+'</span>';
function barChart(ms){ // 月別売上：前年(灰)・実績(赤)・予約済み(薄赤)
  const W=520,H=190,pl=8,pb=26,pt=8;const max=Math.max(1,...ms.map(m=>Math.max(m.rev,m.prev)));const n=ms.length,gw=(W-pl*2)/n,bw=Math.max(4,gw*0.33);
  let g='';ms.forEach((m,i)=>{const x=pl+i*gw;const h1=(m.prev/max)*(H-pb-pt),h2=(m.rev/max)*(H-pb-pt);
    g+='<rect x="'+(x+gw*0.12)+'" y="'+(H-pb-h1)+'" width="'+bw+'" height="'+h1+'" fill="#cfd8e3"/>';
    g+='<rect x="'+(x+gw*0.12+bw+2)+'" y="'+(H-pb-h2)+'" width="'+bw+'" height="'+h2+'" fill="'+(m.future?'#9fb3c8':'#2a4d69')+'"'+(m.future?' stroke="#2a4d69" stroke-dasharray="2 2"':'')+'/>';
    if(m.isCurrent)g+='<line x1="'+(x+gw/2)+'" x2="'+(x+gw/2)+'" y1="0" y2="'+(H-pb+4)+'" stroke="#1a1a1a" stroke-dasharray="3 3" opacity=".5"/>';
    g+='<text x="'+(x+gw/2)+'" y="'+(H-8)+'" font-size="10" text-anchor="middle" fill="#6b6b6b">'+m.label.replace('月','')+(m.ym.endsWith('-01')?'<tspan x="'+(x+gw/2)+'" dy="0" font-size="0"></tspan>':'')+'</text>';});
  return '<svg viewBox="0 0 '+W+' '+H+'">'+g+'</svg>';}
function lineChart(ms){const W=520,H=150,pl=8,pb=22,pt=8;const pts=(k)=>ms.map((m,i)=>[pl+(i+0.5)*((W-pl*2)/ms.length),H-pb-(Math.min(100,m[k]||0)/100)*(H-pb-pt)]);
  const path=a=>a.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const a=pts('occ').filter((p,i)=>!ms[i].future),b=pts('prevOcc');
  let g='';[25,50,75,100].forEach(v=>{const y=H-pb-(v/100)*(H-pb-pt);g+='<line x1="'+pl+'" x2="'+(W-pl)+'" y1="'+y+'" y2="'+y+'" stroke="#eee"/><text x="'+(W-pl)+'" y="'+(y-2)+'" font-size="9" text-anchor="end" fill="#aaa">'+v+'%</text>';});
  g+='<path d="'+path(b)+'" fill="none" stroke="#cfd8e3" stroke-width="2"/><path d="'+path(a)+'" fill="none" stroke="#2a4d69" stroke-width="2.5"/>';
  a.forEach(p=>g+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="2.5" fill="#2a4d69"/>');
  ms.forEach((m,i)=>g+='<text x="'+(pl+(i+0.5)*((W-pl*2)/ms.length))+'" y="'+(H-6)+'" font-size="10" text-anchor="middle" fill="#6b6b6b">'+m.label.replace('月','')+'</text>');
  return '<svg viewBox="0 0 '+W+' '+H+'">'+g+'</svg>';}
function renderOverview(d){const o=d.overview;
  let h='<div class="cards2"><div class="kc hi"><div class="t">'+esc(o.month)+'の宿泊売上（予約済み）</div><div class="v">'+man(o.revenue)+'</div><div class="d">前年同時点 '+yoy(o.revenueYoY)+'<br>・前年の着地 '+man(o.revenuePrevFinal)+'</div></div>';
  h+='<div class="kc"><div class="t">'+esc(o.month)+'の稼働率</div><div class="v">'+o.occ+'<small>%</small></div><div class="d">前年同月 '+yoy(o.occYoY,'pt')+'</div></div>';
  h+='<div class="kc"><div class="t">'+esc(o.month)+'の平均単価（ADR）</div><div class="v">'+Number(o.adr).toLocaleString()+'<small>円</small></div><div class="d">前年 '+yoy(o.adrYoY)+'</div></div>';
  h+='<div class="kc"><div class="t">1室1日あたり売上（RevPAR）</div><div class="v">'+Number(o.revpar).toLocaleString()+'<small>円</small></div><div class="d">前年同月 '+yoy(o.revparYoY)+'</div></div></div>';
  h+='<div class="kc" style="width:auto"><div class="t">'+esc(o.ytdLabel)+'</div><div class="v">'+man(o.ytd)+'</div><div class="d">前年同期 '+yoy(o.ytdYoY)+'</div></div>';
  h+='<div class="sec">HIGHLIGHTS</div><div class="h">今月の要点</div><div class="hl">'+(d.highlights.length?d.highlights.map(x=>'<p><span class="tag'+(/注意|稼働/.test(x.tag)?' w':'')+'">'+esc(x.tag)+'</span>'+esc(x.text)+'</p>').join(''):'<p class="muted">特記事項なし</p>')+'</div>';
  h+='<div class="sec">REVENUE</div><div class="h">月別の宿泊売上<small>過去12か月の実績 と これから5か月の予約済み</small></div><div class="chart"><div class="lg"><span><i style="background:#2a4d69"></i>今年（実績）</span><span><i style="background:#9fb3c8;border:1px dashed #2a4d69"></i>予約済み（これから増えます）</span><span><i style="background:#cfd8e3"></i>前年の実績</span></div>'+barChart(d.monthly)+'</div>';
  h+='<div class="sec">OCCUPANCY</div><div class="h">稼働率<small>月別・前年との比較</small></div><div class="chart"><div class="lg"><span><i style="background:#2a4d69"></i>今年</span><span><i style="background:#cfd8e3"></i>前年</span></div>'+lineChart(d.monthly)+'</div>';
  if(d.sales&&d.sales.months){h+='<div class="sec">BY MONTH</div><div class="h">月別の内訳<small>当月〜5か月先・物件ごと</small></div>';
    for(const m of d.sales.months){h+='<div class="tbl"><div style="display:flex;justify-content:space-between;align-items:baseline;padding:12px 12px 4px"><b style="font-size:16px">'+esc(m.month)+'</b><span style="font-size:20px;font-weight:800">'+man(m.total)+'</span></div><div class="note" style="padding:0 12px 6px">'+m.nightsTotal+'泊・ADR ¥'+Number(m.adr).toLocaleString()+'</div><table><tr><th style="text-align:left">物件</th><th>泊</th><th>稼働</th><th>ADR</th><th>売上</th></tr>';
      for(const [n,p] of Object.entries(m.props))h+='<tr><td>'+esc(n)+'</td><td>'+p.nights+'</td><td>'+p.occupancy+'%</td><td>¥'+Number(p.adr).toLocaleString()+'</td><td>'+man(p.revenue)+'</td></tr>';
      h+='</table></div>';}}
  h+='<p class="note">到着日ベース・キャンセル除く・Beds24の料金（清掃費込み）。市場比較・値付け記録はPriceLabs接続後に追加。</p>';
  return h;}
function renderKpi(d){
  const ms=d.series;const money=kpiSub==='money';
  let h='<div class="seg"><button data-seg="money" class="'+(money?'on':'')+'">売上・稼働率・ADR・RevPAR</button><button data-seg="vol" class="'+(money?'':'on')+'">泊数・人数・1泊の件数・リードタイム</button></div>';
  const metrics=money?[['売上','rev',v=>manS(v),(c,p)=>yoy(p&&p.rev?Math.round((c.rev/p.rev-1)*1000)/10:null)],['稼働率','occ',v=>v+'%',(c,p)=>yoy(p?Math.round((c.occ-p.occ)*10)/10:null,'pt')],['ADR','adr',v=>'¥'+Number(v).toLocaleString(),(c,p)=>yoy(p&&p.adr?Math.round((c.adr/p.adr-1)*1000)/10:null)],['RevPAR','revpar',v=>'¥'+Number(v).toLocaleString(),(c,p)=>yoy(p&&p.revpar?Math.round((c.revpar/p.revpar-1)*1000)/10:null)]]
    :[['泊数','nights',v=>v,(c,p)=>yoy(p&&p.nights?Math.round((c.nights/p.nights-1)*1000)/10:null)],['平均人数','pax',v=>v+'人',(c,p)=>yoy(p?Math.round((c.pax-p.pax)*10)/10:null,'人')],['1泊の件数','oneNight',v=>v+'%',(c,p)=>yoy(p?c.oneNight-p.oneNight:null,'pt')],['リードタイム','lead',v=>v==null?'—':v+'日',(c,p)=>yoy(p&&p.lead!=null&&c.lead!=null?c.lead-p.lead:null,'日')]];
  const rows=[['合計',null],...d.props.map(p=>[p,p])];
  h+='<div class="tbl kt" style="overflow-x:auto"><table><thead><tr><th class="pc">物件</th><th class="mc">指標</th>'+ms.map(m=>'<th'+(m.isCurrent?' class="curcol"':'')+'>'+m.label+'<span class="s">'+m.year+(m.future?' 予約済':'')+'</span></th>').join('')+'</tr></thead><tbody>';
  for(const [name,key] of rows){metrics.forEach(([ml,mk,fmt,cmp],i)=>{h+='<tr class="'+(key===null?'tot ':'')+(i===0?'grp':'')+'">'+(i===0?'<td class="pc" rowspan="'+metrics.length+'">'+esc(name)+(key===null?'<small>'+d.props.length+'物件</small>':'')+'</td>':'')+'<td class="mc">'+ml+'</td>';
    for(const m of ms){const c=key===null?m.total:m.props[key];const p=c&&c.prev;h+='<td'+(m.isCurrent?' class="curcol"':'')+'>'+(c?fmt(c[mk]):'—')+'<span class="s">'+(c?cmp(c,p):'')+'</span></td>';}
    h+='</tr>';});}
  h+='</tbody></table></div><p class="note">左右にスクロールできます。今月より右は「予約済み」で、今後増えます。前年比は前年同月の最終実績との比較。</p>';
  return h;}
function renderProps(d){
  let h='<div class="sec">PROPERTIES</div><div class="h">物件別の成績<small>直近3か月</small></div><div class="tbl"><table><tr><th>物件</th><th>ランク</th><th>稼働</th><th>ADR</th><th>RevPAR</th><th>売上/前年</th></tr>';
  for(const p of d.propPerf)h+='<tr><td>'+esc(p.prop)+'</td><td><span class="rank r'+p.rank+'">'+p.rank+'</span></td><td>'+p.occ+'%</td><td>¥'+p.adr.toLocaleString()+'</td><td>¥'+p.revpar.toLocaleString()+'</td><td>'+man(p.rev)+'<span class="s">'+yoy(p.yoy)+'</span></td></tr>';
  h+='</table></div><p class="note">ランクは直近3か月の稼働率：A 80%以上・B 65%以上・C 50%以上・D それ未満</p>';
  const tot=d.channels.reduce((a,c)=>a+c.rev,0)||1;const col={airbnb:'#e0455f',booking:'#2a5bd7',agoda:'#8e44ad',expedia:'#f0a202',rakuten:'#b10e1f',direct:'#7f8c8d'};
  h+='<div class="sec">CHANNELS</div><div class="h">販売チャネル<small>直近12か月の売上</small></div><div class="chart"><div style="display:flex;height:14px;border-radius:4px;overflow:hidden;margin-bottom:8px">'+d.channels.map(c=>'<i style="flex:'+c.rev+';background:'+(col[c.key]||'#999')+'"></i>').join('')+'</div><table style="width:100%;font-size:15px;border-collapse:collapse"><tr style="color:#6b6b6b;font-size:12px"><th style="text-align:left;font-weight:400">チャネル</th><th style="text-align:right;font-weight:400">売上</th><th style="text-align:right;font-weight:400">構成比</th><th style="text-align:right;font-weight:400">手数料率</th></tr>'+d.channels.map(c=>'<tr><td style="padding:9px 0;font-weight:700"><i style="display:inline-block;width:11px;height:11px;border-radius:2px;background:'+(col[c.key]||'#999')+';margin-right:6px"></i>'+esc(c.label)+'</td><td style="text-align:right">¥'+c.rev.toLocaleString()+'</td><td style="text-align:right">'+c.share+'%</td><td style="text-align:right">'+c.fee+'%</td></tr>').join('')+'<tr style="font-weight:700;border-top:1px solid #eee"><td style="padding-top:6px">合計</td><td style="text-align:right">¥'+tot.toLocaleString()+'</td><td style="text-align:right">100%</td><td style="text-align:right">'+d.feeAvg+'%</td></tr></table></div><p class="note">手数料率は目安の設定値（Airbnb 15.5%・Booking 15%・Agoda 17%）。実額は各OTAの明細で確認。</p>';
  return h;}
function renderPace(d){
  let h='<div class="sec">PACE</div><div class="h">これから先の予約ペース<small>前年の同じ日と比べて</small></div><div class="lg"><span><i style="background:#2a4d69"></i>今の予約</span><span><i style="background:#cfd8e3"></i>前年の同じ時点</span></div><div class="pace tbl" style="padding:4px 12px">';
  const max=Math.max(1,...d.pace.map(r=>Math.max(r.now,r.prevAsOf)));
  for(const r of d.pace){h+='<div class="row2"><div>'+esc(r.label)+'</div><div class="bars"><i class="b1" style="width:'+(r.now/max*100)+'%"></i><i class="b2" style="width:'+(r.prevAsOf/max*100)+'%"></i></div><div class="pv '+(r.pace==null?'':r.pace>=100?'up':'dn')+'">'+(r.pace==null?'—':r.pace+'%')+'<small>'+man(r.now)+' / '+man(r.prevAsOf)+'</small></div></div>';}
  h+='</div><p class="note">100%を下回る月は前年より売れ行きが遅い月です。前年の着地ではなく「前年の同じ日時点の予約済み」と比べています。</p>';
  h+='<div class="sec">BY PROPERTY</div><div class="h">物件ごとの予約ペース<small>前年同時点を100%として</small></div><div class="tbl" style="overflow-x:auto"><table class="heat"><tr><th style="text-align:left">物件</th>'+d.pace.map(r=>'<th>'+esc(r.label.slice(5))+'<span class="s">'+r.label.slice(0,4)+'</span></th>').join('')+'</tr>';
  for(const p of d.props){h+='<tr><td style="text-align:left">'+esc(p)+'</td>'+d.pace.map(r=>{const v=r.byProp[p];const bg=v==null?'#fff':v>=110?'#e3f1e7':v>=100?'#f1f7f2':v>=90?'#fff3cd':'#f9d6dc';return '<td style="background:'+bg+'">'+(v==null?'—':v+'%')+'</td>';}).join('')+'</tr>';}
  h+='</table></div><p class="note">90%未満は赤。遅れている物件×月から、価格・最低泊数・プロモーションを見直す。</p>';
  h+='<div class="sec">ACTIONS</div><div class="h">値付けの記録<small>直近30日に当社が行った変更</small></div><div class="tbl"><table><tr><th style="text-align:left">日付</th><th style="text-align:left">物件</th><th style="text-align:left">変更内容</th><th style="text-align:left">理由</th></tr>';
  const pl=d.pricelog||[];
  if(!pl.length)h+='<tr><td colspan="4" class="muted" style="font-weight:400">記録なし。SORAに「値付け 物件名 変更内容｜理由」と送ると追加されます。</td></tr>';
  for(const x of pl)h+='<tr><td style="font-weight:400;color:#6b6b6b">'+esc(x.date.slice(5).replace('-','/'))+'</td><td style="text-align:left;font-weight:400">'+esc(x.property)+'</td><td style="text-align:left">'+esc(x.change)+'</td><td style="text-align:left;font-weight:400;color:#6b6b6b;white-space:normal">'+esc(x.reason||'')+'</td></tr>';
  h+='</table></div><p class="note">PriceLabsの変更履歴の自動取り込みは接続後に追加。</p>';
  return h;}
function renderDay(d,tab){
  const k=d.kpi;let h='<div class="nav"><button data-nav="today" class="'+(tab==='today'?'on':'')+'">今日</button><button data-nav="tomorrow" class="'+(tab==='tomorrow'?'on':'')+'">明日</button><button data-nav="week">今週</button></div>';
  h+='<div class="kpi" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div><b>'+k.in+'</b><small>IN</small></div><div><b>'+k.out+'</b><small>OUT</small></div><div><b>'+k.clean+'</b><small>清掃</small></div></div>';
  h+='<div class="card" id="todo"><h3>要対応'+(d.todo.length?'':'　<span class="muted">なし</span>')+'</h3>';
  for(const t of d.todo){
    if(t.kind==='registry')h+='<div class="row"><div><b>'+esc(t.property)+' '+esc(t.guest)+'様</b><span class="red">'+esc(t.text)+'</span></div><button class="btn" data-remind="'+t.bookingId+'" data-guest="'+esc(t.guest)+'">再催促</button></div>';
    else h+='<div class="row"><div><b>'+esc(t.property)+' '+esc(t.guest)+'様</b><span class="muted">'+esc(t.text)+'　'+esc(t.snippet||'')+'</span></div><span class="muted" style="font-size:11px">SORAで確認</span></div>';
  }
  h+='</div>';
  h+='<div class="card" id="rows"><h3>物件ごとの動き</h3><div class="grid h"><span>物件</span><span>OUT</span><span>清掃</span><span>IN</span></div>';
  for(const r of d.rows){
    const cc=r.cleanState==='done'?'green':r.cleanState==='pending'?'red':r.cleanState==='none'?'muted':'';
    h+='<div class="grid"><span>'+esc(r.property)+'</span><span class="'+(r.stay?'muted':'')+'">'+(r.stay?'連泊':esc(r.out))+'</span><span class="'+cc+'">'+(r.stay?'なし':esc(r.clean))+'</span><span class="'+(r.inMissing?'red':'')+'">'+(r.stay?'—':esc(r.in))+'</span></div>';
  }
  h+='</div>';
  const tt=d.timetree;
  h+='<div class="foot"><span>TimeTree同期　'+(tt?esc((tt.at||'').replace(/^\\d+\\/\\d+\\/\\d+\\s*/,''))+(tt.ok?' 成功':' 失敗'):'未実行')+'</span><span>Beds24　'+new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'})+' 取得</span></div>';
  return h;
}
function renderCounters(k){
  const c=document.getElementById('cnt');if(!k){c.style.display='none';return;}c.style.display='';
  c.innerHTML='<button class="'+(k.reply?'warn':'')+'" data-go="todo"><b>'+(k.reply||0)+'</b>返信待ち</button><button class="'+(k.registryMissing?'warn':'')+'" data-go="todo"><b>'+k.registryMissing+'</b>名簿未</button><button data-go="rows"><b>'+(k.cleanPending||0)+'</b>清掃 未完了</button>';
  c.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{if(cur!=='today')return load('today');const el=document.getElementById(b.dataset.go);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});});
}
function renderCal(d){
  const W=34,L=84,n=d.days.length;const t0=Date.parse(d.start+'T00:00:00Z');const idx=ymd=>Math.round((Date.parse(ymd+'T00:00:00Z')-t0)/86400000);
  const prev=new Date(t0-7*86400000).toISOString().slice(0,10),next=new Date(t0+7*86400000).toISOString().slice(0,10),today=new Date(Date.parse(d.today+'T00:00:00Z')-2*86400000).toISOString().slice(0,10);
  const e=d.days[n-1];
  let h='<div class="calwrap"><div class="calbar"><button data-cal="'+prev+'">◀</button><span><b>'+d.days[0].m+'/'+d.days[0].dd+'〜'+e.m+'/'+e.dd+'</b></span><span><button data-cal="'+today+'" style="margin-right:6px">今日</button><button data-cal="'+next+'">▶</button></span></div>';
  h+='<div class="legend"><span><i style="background:#e0455f"></i>Airbnb</span><span><i style="background:#2a5bd7"></i>Booking</span><span><i style="background:#7f8c8d"></i>直・他</span><span>✔名簿済 ✖未</span></div>';
  h+='<div class="scroll"><div class="gantt" style="grid-template-columns:'+L+'px repeat('+n+','+W+'px);width:'+(L+W*n)+'px">';
  h+='<div class="lbl" style="height:34px"></div>';
  for(const x of d.days)h+='<div class="hd'+(x.dow===6?' sat':x.dow===0?' sun':'')+(x.d===d.today?' today':'')+'">'+x.m+'/'+x.dd+'<br>'+'日月火水木金土'[x.dow]+'</div>';
  d.props.forEach((p,ri)=>{h+='<div class="lbl" style="height:40px">'+esc(p)+'</div>';for(const x of d.days)h+='<div class="cell'+(x.d===d.today?' today':'')+'"></div>';
    for(const b of d.bookings.filter(b=>b.prop===p)){let a=idx(b.arrival),z=idx(b.departure);const s0=Math.max(a,0),e0=Math.min(z,n);if(e0<=s0&&!(a===z))continue;
      const left=L+s0*W+(a>=0?W*0.55:0),right=L+(z>=n?n*W:e0*W+W*0.45);const top=34+ri*40+6;
      const reg=b.registry==='done'?'<span class="reg">✔</span>':b.registry==='missing'?'<span class="reg">✖</span>':'';
      h+='<div class="bar '+b.chan+'" data-bk="'+b.id+'" style="left:'+left+'px;top:'+top+'px;width:'+Math.max(right-left,16)+'px" title="'+esc(b.name)+'">'+esc(b.name)+' '+b.pax+'名'+reg+'</div>';}
  });
  h+='</div></div></div>';
  h+='<div class="nav"><button data-nav="today">今日に戻る</button></div>';
  return h;
}
async function openDetail(id){
  const sh=document.getElementById('sheet');sh.innerHTML='<div class="dim"></div><div class="sheet">読み込み中…</div>';
  const d=await api({tab:'detail',bookingId:id});
  if(d.error){sh.innerHTML='<div class="dim"></div><div class="sheet"><p class="red">'+esc(d.error)+'</p></div>';}
  else{
    const reg=d.registry==='done'?'<span class="green">済</span>':d.registry==='missing'?'<span class="red">未提出</span>':'<span class="muted">対象外</span>';
    let h='<div class="dim"></div><div class="sheet"><h2>'+esc(d.prop)+'　'+esc(d.name)+'様</h2>';
    h+='<div class="kv"><span>日付</span><span>'+esc(d.arrival)+' 〜 '+esc(d.departure)+'（'+d.nights+'泊）</span><span>人数</span><span>'+d.pax+'名</span><span>チャネル</span><span>'+esc(d.channel)+'</span><span>名簿</span><span>'+reg+'</span>'+(d.price?'<span>金額</span><span>'+yen(d.price)+'</span>':'')+(d.notes?'<span>メモ</span><span>'+esc(d.notes)+'</span>':'')+'</div>';
    h+='<div class="acts">'+d.links.map(l=>'<a href="'+esc(l.url)+'" target="_blank" rel="noopener">'+esc(l.label)+'</a>').join('')+(d.registry==='missing'?'<button class="dark" data-remind="'+d.id+'" data-guest="'+esc(d.name)+'">名簿催促を送る</button>':'')+'<button data-close="1">閉じる</button></div>';
    h+='<h3 style="font-size:13px;margin:10px 0 4px">直近のメッセージ</h3>'+(d.thread.length?d.thread.map(m=>'<div class="msg '+m.from+'">'+esc(m.text).slice(0,400)+'<small>'+(m.from==='guest'?'ゲスト':'スタッフ')+' '+esc((m.time||'').slice(5,16).replace('T',' '))+'</small></div>').join(''):'<p class="muted" style="font-size:12px">メッセージはありません</p>');
    h+='<p class="muted" style="font-size:11px">返信はSORAの承認カード、または上のリンク先から行ってください。</p></div>';
    sh.innerHTML=h;
    sh.querySelectorAll('[data-remind]').forEach(b=>b.onclick=async()=>{if(!confirm(b.dataset.guest+'様に名簿の再催促を送りますか？'))return;b.disabled=true;b.textContent='送信中…';const r=await fetch('/liff/dash/remind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken,bookingId:b.dataset.remind})});const j=await r.json();b.textContent=j.ok?'送信済':'失敗';});
  }
  sh.querySelectorAll('.dim,[data-close]').forEach(x=>x.onclick=()=>{sh.innerHTML='';});
}
function renderWeek(d){
  let h='<div class="nav"><button data-nav="today">今日</button><button data-nav="tomorrow">明日</button><button data-nav="week" class="on">今週</button></div>';
  for(const day of d.days){h+='<div class="card"><h3>'+esc(day.label)+'</h3>'+(day.props.length?day.props.map(p=>'<div class="row"><b>'+esc(p.property)+'</b><span>'+(p.out?'<span class="muted">OUT</span> ':'')+(p.in?'IN '+esc(p.in):'')+'</span></div>').join(''):'<div class="row muted">動きなし</div>')+'</div>';}
  return h;
}
function renderSales(d){
  let h='';
  for(const m of d.months){
    h+='<div class="card"><h3>'+esc(m.month)+'</h3><div class="big">'+yen(m.total)+'</div><div class="sub muted" style="font-size:12px">到着日ベース・キャンセル除く・'+m.nightsTotal+'泊・ADR '+yen(m.adr)+(d.at?'　'+esc(d.at)+'時点':'')+'</div><table><tr><th>物件</th><th>泊</th><th>稼働</th><th>ADR</th><th>売上</th></tr>';
    for(const [n,p] of Object.entries(m.props)) h+='<tr><td>'+esc(n)+'</td><td>'+p.nights+'</td><td>'+p.occupancy+'%</td><td>'+yen(p.adr)+'</td><td>'+yen(p.revenue)+'</td></tr>';
    h+='</table></div>';
  }
  h+='<div class="nav"><button data-nav="today">今日に戻る</button></div>';
  return h;
}
document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>load(b.dataset.tab));
(async()=>{try{await liff.init({liffId:LIFF_ID});if(!liff.isLoggedIn()){liff.login();return;}idToken=liff.getIDToken();
  let q=new URLSearchParams(location.search).get('tab')||'today';if(q==='sales')q='overview';await load(q);}catch(e){document.getElementById('app').innerHTML='<p class="red">エラー: '+esc(e.message)+'</p>';}})();
</script></body></html>`;
