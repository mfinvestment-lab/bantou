// ダッシュボード（LIFF）: 画面案④に沿った「今日」（KPI・要対応・物件ごとの動き）、明日、今週、売上（許可ユーザーのみ）
import { BEDS24_PROPERTIES, getToken, getBookings, formatDateYMD, addDays, fetchPropertyMap, sendGuestMessage } from "./beds24.js";
import { props as propsCache, normalizeProperty } from "./store.js";
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
  const kpi = { in: 0, out: 0, clean: 0, registryMissing: 0 };
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
    for (const k of l.keys.slice(0, 100)) {
      const card = await env.KV.get(k.name, "json");
      if (card?.status === "pending" && !card.test) todo.push({ kind: "reply", property: disp(card.property), guest: card.guest, text: `返信待ち ${card.createdAt ? hhmm(card.createdAt) : ""} 受信`, snippet: (card.guestMessage || "").slice(0, 50) });
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

/** 売上タブ（先月〜4か月先、物件別、ADR） */
export async function salesData(env) {
  const token = await getToken(env);
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const months = [-1, 0, 1, 2, 3, 4].map(k => monthRange(new Date(now.getFullYear(), now.getMonth() + k, 1)));
  const { names, order } = await allProperties(env, token);
  const out = [];
  for (const m of months) {
    const row = { month: m.label, props: {}, total: 0, nightsTotal: 0 };
    const all = (await getBookings(token, `arrivalFrom=${m.from}&arrivalTo=${m.to}`)).filter(b => b.status !== "cancelled");
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
  return { months: out };
}

/** 名簿の再催促（Beds24経由でゲストへ。鍵の番号は送らない） */
async function remindRegistry(env, bookingId, by) {
  const token = await getToken(env);
  const b = ((await getBookings(token, `id=${bookingId}&includeInfoItems=true`)) || [])[0];
  if (!b) return { error: "予約が見つかりません" };
  const link = (b.infoItems || []).find(i => /GUESTLINK/i.test(i.code || ""))?.text || "";
  const msg = `${guestName(b)} 様\n\n本日のご宿泊にあたり、宿泊者名簿のご登録がまだ確認できておりません。旅館業法により、宿泊者全員の名簿登録が必要です。\n下記よりご登録をお願いいたします。\n${link}\n\nご登録の確認後、入室方法をお送りします。`;
  await sendGuestMessage(token, b.id, msg);
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
    const { idToken, tab } = await request.json();
    const u = await verifyIdToken(env, idToken);
    if (!u) return json({ error: "ログイン情報を確認できません" }, 401);
    if (!allow(env, "DASH_ALLOW", u.userId)) return json({ error: "閲覧権限がありません" }, 403);
    const canSales = allow(env, "SALES_ALLOW", u.userId);
    if (tab === "sales") { if (!canSales) return json({ error: "売上の閲覧権限がありません" }, 403); return json({ ...(await salesData(env)), canSales }); }
    if (tab === "week") return json({ ...(await weekData(env)), canSales });
    if (tab === "tomorrow") return json({ ...(await dayData(env, formatDateYMD(addDays(new Date(), 1)))), canSales });
    return json({ ...(await todayData(env)), canSales });
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
body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;background:#f4f4f4;color:#1a1a1a}
.hdr{background:#fff;border-bottom:1px solid #d9d9d9;padding:14px 16px;font-size:17px;font-weight:700;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0}
.hdr .tabs{display:flex;gap:6px}
.hdr .tabs button{border:1px solid #1a1a1a;background:#fff;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:700}
.hdr .tabs button.on{background:#1a1a1a;color:#fff}
.wrap{padding:12px;max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
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
.nav{display:flex;gap:8px}
.nav button{flex:1;min-height:44px;border:1px solid #1a1a1a;background:#fff;border-radius:8px;font-size:13px;font-weight:700}
.nav button.on{background:#1a1a1a;color:#fff}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 4px;border-bottom:1px solid #eee;text-align:right}
td:first-child,th:first-child{text-align:left}
.big{font-size:22px;font-weight:700;padding:10px 14px 0}
.sub{padding:0 14px 8px}
</style></head><body>
<div class="hdr"><span id="title">今日</span><div class="tabs"><button id="t-sales" style="display:none">売上</button></div></div>
<div class="wrap" id="app">読み込み中…</div>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
const LIFF_ID="__LIFF_ID__";let idToken=null,cur='today';
const yen=n=>'¥'+Number(n||0).toLocaleString();
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(body){const r=await fetch('/liff/dash/data',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken,...body})});return r.json();}
async function load(tab){
  cur=tab;const app=document.getElementById('app');app.textContent='読み込み中…';
  const d=await api({tab});
  if(d.error){app.innerHTML='<p class="red">'+esc(d.error)+'</p>';return;}
  if(d.canSales)document.getElementById('t-sales').style.display='';
  document.getElementById('title').textContent=tab==='sales'?'売上':tab==='week'?'今週':(tab==='tomorrow'?'明日　':'今日　')+(d.label||'');
  app.innerHTML=tab==='sales'?renderSales(d):tab==='week'?renderWeek(d):renderDay(d,tab);
  app.querySelectorAll('[data-remind]').forEach(b=>b.onclick=async()=>{if(!confirm(b.dataset.guest+'様に名簿の再催促を送りますか？'))return;b.disabled=true;b.textContent='送信中…';const r=await fetch('/liff/dash/remind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken,bookingId:b.dataset.remind})});const j=await r.json();b.textContent=j.ok?'送信済':'失敗';});
  app.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>load(b.dataset.nav));
}
function renderDay(d,tab){
  const k=d.kpi;let h='<div class="kpi"><div><b>'+k.in+'</b><small>IN</small></div><div><b>'+k.out+'</b><small>OUT</small></div><div><b>'+k.clean+'</b><small>清掃</small></div><div class="'+(k.registryMissing?'warn':'')+'"><b>'+k.registryMissing+'</b><small>名簿未</small></div></div>';
  h+='<div class="card"><h3>要対応'+(d.todo.length?'':'　<span class="muted">なし</span>')+'</h3>';
  for(const t of d.todo){
    if(t.kind==='registry')h+='<div class="row"><div><b>'+esc(t.property)+' '+esc(t.guest)+'様</b><span class="red">'+esc(t.text)+'</span></div><button class="btn" data-remind="'+t.bookingId+'" data-guest="'+esc(t.guest)+'">再催促</button></div>';
    else h+='<div class="row"><div><b>'+esc(t.property)+' '+esc(t.guest)+'様</b><span class="muted">'+esc(t.text)+'　'+esc(t.snippet||'')+'</span></div><span class="muted" style="font-size:11px">SORAで確認</span></div>';
  }
  h+='</div>';
  h+='<div class="card"><h3>物件ごとの動き</h3><div class="grid h"><span>物件</span><span>OUT</span><span>清掃</span><span>IN</span></div>';
  for(const r of d.rows){
    const cc=r.cleanState==='done'?'green':r.cleanState==='pending'?'red':r.cleanState==='none'?'muted':'';
    h+='<div class="grid"><span>'+esc(r.property)+'</span><span class="'+(r.stay?'muted':'')+'">'+(r.stay?'連泊':esc(r.out))+'</span><span class="'+cc+'">'+(r.stay?'なし':esc(r.clean))+'</span><span class="'+(r.inMissing?'red':'')+'">'+(r.stay?'—':esc(r.in))+'</span></div>';
  }
  h+='</div>';
  const tt=d.timetree;
  h+='<div class="foot"><span>TimeTree同期　'+(tt?esc((tt.at||'').replace(/^\\d+\\/\\d+\\/\\d+\\s*/,''))+(tt.ok?' 成功':' 失敗'):'未実行')+'</span><span>Beds24　'+new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'})+' 取得</span></div>';
  h+='<div class="nav"><button data-nav="today" class="'+(tab==='today'?'on':'')+'">今日</button><button data-nav="tomorrow" class="'+(tab==='tomorrow'?'on':'')+'">明日</button><button data-nav="week">今週</button></div>';
  return h;
}
function renderWeek(d){
  let h='';
  for(const day of d.days){h+='<div class="card"><h3>'+esc(day.label)+'</h3>'+(day.props.length?day.props.map(p=>'<div class="row"><b>'+esc(p.property)+'</b><span>'+(p.out?'<span class="muted">OUT</span> ':'')+(p.in?'IN '+esc(p.in):'')+'</span></div>').join(''):'<div class="row muted">動きなし</div>')+'</div>';}
  h+='<div class="nav"><button data-nav="today">今日</button><button data-nav="tomorrow">明日</button><button data-nav="week" class="on">今週</button></div>';
  return h;
}
function renderSales(d){
  let h='';
  for(const m of d.months){
    h+='<div class="card"><h3>'+esc(m.month)+'</h3><div class="big">'+yen(m.total)+'</div><div class="sub muted" style="font-size:12px">到着日ベース・キャンセル除く・'+m.nightsTotal+'泊・ADR '+yen(m.adr)+'</div><table><tr><th>物件</th><th>泊</th><th>稼働</th><th>ADR</th><th>売上</th></tr>';
    for(const [n,p] of Object.entries(m.props)) h+='<tr><td>'+esc(n)+'</td><td>'+p.nights+'</td><td>'+p.occupancy+'%</td><td>'+yen(p.adr)+'</td><td>'+yen(p.revenue)+'</td></tr>';
    h+='</table></div>';
  }
  h+='<div class="nav"><button data-nav="today">今日に戻る</button></div>';
  return h;
}
document.getElementById('t-sales').onclick=()=>load('sales');
(async()=>{try{await liff.init({liffId:LIFF_ID});if(!liff.isLoggedIn()){liff.login();return;}idToken=liff.getIDToken();
  const q=new URLSearchParams(location.search).get('tab')||'today';await load(q);}catch(e){document.getElementById('app').innerHTML='<p class="red">エラー: '+esc(e.message)+'</p>';}})();
</script></body></html>`;
