// ダッシュボード（LIFF）: 今日の稼働・清掃・名簿・未返信、売上（許可ユーザーのみ）
import { BEDS24_PROPERTIES, getToken, getBookings, formatDateYMD, addDays, fetchPropertyMap } from "./beds24.js";
import { props as propsCache, normalizeProperty } from "./store.js";
import { todayCleaningStatus } from "./cleanlog.js";

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
// 全物件（Beds24）。先頭は清掃ボタンのある3物件、残りは名前順
async function allProperties(env, token) {
  let map = await propsCache.get(env.KV);
  if (!map) { map = await fetchPropertyMap(token); await propsCache.set(env.KV, map); }
  const main = Object.keys(BEDS24_PROPERTIES);
  const names = {};
  for (const [id, n] of Object.entries(map)) names[String(id)] = normalizeProperty(n);
  const order = [...main.map(n => Object.keys(names).find(id => names[id] === n)).filter(Boolean), ...Object.keys(names).filter(id => !main.includes(names[id])).sort((a, b) => names[a].localeCompare(names[b]))];
  return { names, order };
}
const groupBy = (list, names) => { const g = {}; for (const b of list) (g[names[String(b.propertyId)] || String(b.propertyId)] ||= []).push(b); return g; };
const monthRange = (d) => { const y = d.getFullYear(), m = d.getMonth(); const s = new Date(Date.UTC(y, m, 1)), e = new Date(Date.UTC(y, m + 1, 0)); return { from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10), label: `${y}年${m + 1}月`, days: e.getUTCDate() }; };

/** 今日タブのデータ */
export async function todayData(env) {
  const token = await getToken(env);
  const today = formatDateYMD(new Date());
  const tomorrow = formatDateYMD(addDays(new Date(), 1));
  const cleaning = await todayCleaningStatus(env, today);
  const { names, order } = await allProperties(env, token);
  const ok = b => b.status !== "cancelled";
  const [arr, dep, arrT] = await Promise.all([
    getBookings(token, `arrivalFrom=${today}&arrivalTo=${today}&includeInfoItems=true`),
    getBookings(token, `departureFrom=${today}&departureTo=${today}`),
    getBookings(token, `arrivalFrom=${tomorrow}&arrivalTo=${tomorrow}&includeInfoItems=true`)
  ]);
  const gA = groupBy(arr.filter(ok), names), gD = groupBy(dep.filter(ok), names), gT = groupBy(arrT.filter(ok), names);
  const fmt = b => ({ id: b.id, name: guestName(b), pax: pax(b), nights: nights(b), channel: b.channel || b.referer || "直", registered: (b.infoItems || []).some(i => /GUESTDONE/i.test(i.code || "")) });
  const props = {};
  for (const id of order) {
    const name = names[id];
    const c = cleaning[name];
    props[name] = {
      checkouts: (gD[name] || []).map(fmt),
      checkins: (gA[name] || []).map(fmt),
      checkinsTomorrow: (gT[name] || []).map(fmt),
      hasCleaningButtons: !!BEDS24_PROPERTIES[name],
      cleaning: c ? { startAt: c.startAt, startBy: c.startBy, endAt: c.endAt, endBy: c.endBy, early: c.early ? { time: c.early.time, sent: c.early.results?.filter(r => !r.test).length || 0 } : null } : null
    };
  }
  // 未返信カード（KV の card:* で pending のもの）
  const pending = [];
  try {
    const l = await env.KV.list({ prefix: "card:" });
    for (const k of l.keys.slice(0, 100)) {
      const card = await env.KV.get(k.name, "json");
      if (card?.status === "pending" && !card.test) pending.push({ property: card.property, guest: card.guest, text: (card.guestMessage || "").slice(0, 60), at: card.createdAt || null });
    }
  } catch {}
  const ttLast = await env.KV.get("tt:last", "json");
  return { today, props, pending, timetree: ttLast };
}

/** 売上タブのデータ（今月・来月、物件別） */
export async function salesData(env) {
  const token = await getToken(env);
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const months = [monthRange(now), monthRange(new Date(now.getFullYear(), now.getMonth() + 1, 1))];
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
      row.props[name] = { bookings: list.length, nights: n, occupancy: Math.round((n / m.days) * 100), revenue: Math.round(revenue) };
      row.total += revenue; row.nightsTotal += n;
    }
    row.total = Math.round(row.total);
    out.push(row);
  }
  return { months: out };
}

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
    if (tab === "sales") {
      if (!canSales) return json({ error: "売上の閲覧権限がありません" }, 403);
      return json({ ...(await salesData(env)), canSales });
    }
    return json({ ...(await todayData(env)), canSales });
  }
  return new Response("Not found", { status: 404 });
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>ダッシュボード</title>
<style>
body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;background:#f4f4f4;color:#222}
.tabs{display:flex;background:#fff;position:sticky;top:0;border-bottom:1px solid #ddd}
.tabs button{flex:1;border:0;background:none;padding:14px;font-size:16px;color:#888}
.tabs button.on{color:#06c755;border-bottom:3px solid #06c755;font-weight:bold}
.wrap{padding:12px;max-width:560px;margin:0 auto}
.card{background:#fff;border-radius:12px;padding:12px 14px;margin:10px 0}
.card h2{font-size:16px;margin:0 0 8px}
.line{font-size:14px;margin:4px 0;display:flex;justify-content:space-between;gap:8px}
.muted{color:#888;font-size:12px}
.ok{color:#06c755}.warn{color:#d9534f}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{padding:6px 4px;border-bottom:1px solid #eee;text-align:right}
td:first-child,th:first-child{text-align:left}
.big{font-size:22px;font-weight:bold}
</style></head><body>
<div class="tabs"><button id="t-today" class="on">今日</button><button id="t-sales" style="display:none">売上</button></div>
<div class="wrap" id="app">読み込み中…</div>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
const LIFF_ID="__LIFF_ID__";let idToken=null;
const yen=n=>'¥'+Number(n||0).toLocaleString();
async function load(tab){
  const app=document.getElementById('app');app.textContent='読み込み中…';
  const r=await fetch('/liff/dash/data',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken,tab})});
  const d=await r.json();
  if(d.error){app.innerHTML='<p class="warn">'+d.error+'</p>';return;}
  if(d.canSales)document.getElementById('t-sales').style.display='';
  app.innerHTML=tab==='sales'?renderSales(d):renderToday(d);
}
function g(x){return x.name+'（'+x.pax+'名'+x.nights+'泊・'+x.channel+'）';}
function renderToday(d){
  let h='<div class="muted">'+d.today+' 時点</div>';
  for(const [name,p] of Object.entries(d.props)){
    const c=p.cleaning;
    const st=!p.hasCleaningButtons?'<span class="muted">（記録対象外）</span>':!p.checkouts.length?'<span class="muted">清掃なし</span>':c&&c.endAt?'<span class="ok">✅ 終了 '+t(c.endAt)+'（'+c.endBy+'）'+(c.early&&c.early.sent?' → '+c.early.time+'〜アーリーイン案内済':'')+'</span>':c&&c.startAt?'<span>🧹 '+t(c.startAt)+'〜 清掃中（'+c.startBy+'）</span>':'<span class="warn">未着手</span>';
    h+='<div class="card"><h2>'+name+'</h2>';
    h+='<div class="line"><span>アウト</span><span>'+(p.checkouts.map(g).join('<br>')||'—')+'</span></div>';
    h+='<div class="line"><span>イン</span><span>'+(p.checkins.map(x=>g(x)+(x.registered?' <span class="ok">名簿済</span>':' <span class="warn">名簿未</span>')).join('<br>')||'—')+'</span></div>';
    h+='<div class="line"><span>明日イン</span><span>'+(p.checkinsTomorrow.map(x=>g(x)+(x.registered?' <span class="ok">名簿済</span>':' <span class="warn">名簿未</span>')).join('<br>')||'—')+'</span></div>';
    h+='<div class="line"><span>清掃</span><span>'+st+'</span></div></div>';
  }
  h+='<div class="card"><h2>未返信のゲストメッセージ '+(d.pending.length?'<span class="warn">'+d.pending.length+'件</span>':'<span class="ok">0件</span>')+'</h2>'+d.pending.map(x=>'<div class="line"><span>'+x.property+' '+x.guest+'様</span><span class="muted">'+x.text+'</span></div>').join('')+'</div>';
  const tt=d.timetree;
  h+='<div class="card"><h2>TimeTree同期</h2>'+(tt?'<div class="line"><span>'+(tt.at||'')+'</span><span class="'+(tt.ok?'ok':'warn')+'">'+(tt.ok?'正常（追加'+tt.create+'・変更'+tt.update+'・削除'+tt.delete+'）':'失敗：'+(tt.error||''))+'</span></div>':'<div class="muted">まだ実行されていません</div>')+'</div>';
  return h;
}
function t(iso){return new Date(iso).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'});}
function renderSales(d){
  let h='';
  for(const m of d.months){
    h+='<div class="card"><h2>'+m.month+'</h2><div class="big">'+yen(m.total)+'</div><div class="muted">到着日ベース・キャンセル除く・'+m.nightsTotal+'泊</div><table><tr><th>物件</th><th>予約</th><th>泊</th><th>稼働</th><th>売上</th></tr>';
    for(const [n,p] of Object.entries(m.props)) h+='<tr><td>'+n+'</td><td>'+p.bookings+'</td><td>'+p.nights+'</td><td>'+p.occupancy+'%</td><td>'+yen(p.revenue)+'</td></tr>';
    h+='</table></div>';
  }
  return h;
}
document.getElementById('t-today').onclick=()=>{sel('today');load('today');};
document.getElementById('t-sales').onclick=()=>{sel('sales');load('sales');};
function sel(k){document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('on',b.id==='t-'+k));}
(async()=>{try{await liff.init({liffId:LIFF_ID});if(!liff.isLoggedIn()){liff.login();return;}idToken=liff.getIDToken();
  const q=new URLSearchParams(location.search).get('tab')||(location.pathname.endsWith('/sales')?'sales':'today');sel(q);await load(q);}catch(e){document.getElementById('app').innerHTML='<p class="warn">エラー: '+e.message+'</p>';}})();
</script></body></html>`;
