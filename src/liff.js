// LIFF（LINE内の入力画面）: リネン棚卸の数量入力。/liff/linen を HARU のリッチメニューから開く
import { sora } from "./line.js";
import { staff } from "./harucmd.js";

const FACILITY_LOC = { "サクヤ": "富士宮", "桜ハウス": "富士宮", "nel.shizuoka": "静岡" };
const ITEMS = ["シングルシーツ", "シングルカバー", "ダブルシーツ", "ダブルカバー", "枕カバー", "バスタオル", "フェイスタオル", "バスマット"];
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });

// LIFF の IDトークンを LINE に検証してもらい userId を得る
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

const gasGet = (env, facility) => fetch(`${env.GAS_URL}?action=get&facility=${encodeURIComponent(facility)}`).then(r => r.json());
const gasPost = (env, body) => fetch(env.GAS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

export async function handleLiff(request, env, url) {
  const path = url.pathname;
  if (path === "/liff/linen" && request.method === "GET") {
    if (!env.LIFF_ID) return new Response("LIFF_ID が未設定です", { status: 503 });
    return new Response(PAGE.replace("__LIFF_ID__", env.LIFF_ID), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path === "/liff/linen/me" && request.method === "POST") {
    const { idToken } = await request.json();
    const u = await verifyIdToken(env, idToken);
    if (!u) return json({ error: "ログイン情報を確認できません" }, 401);
    const me = u.userId === env.OWNER_USER_ID ? { loc: "*" } : await staff.get(env.KV, u.userId);
    if (!me) return json({ error: "担当エリアが未登録です。HARUに「登録」と送ってください" }, 403);
    const facilities = Object.keys(FACILITY_LOC).filter(f => me.loc === "*" || FACILITY_LOC[f] === me.loc);
    const stock = {};
    for (const f of facilities) {
      try { const s = await gasGet(env, f); stock[f] = Object.fromEntries((s.items || []).map(it => [it.name, it.current])); } catch { stock[f] = {}; }
    }
    return json({ name: u.name, facilities, items: ITEMS, stock });
  }
  if (path === "/liff/linen/submit" && request.method === "POST") {
    const { idToken, facility, counts } = await request.json();
    const u = await verifyIdToken(env, idToken);
    if (!u) return json({ error: "ログイン情報を確認できません" }, 401);
    const me = u.userId === env.OWNER_USER_ID ? { loc: "*" } : await staff.get(env.KV, u.userId);
    if (!me || !(me.loc === "*" || FACILITY_LOC[facility] === me.loc)) return json({ error: "この物件の入力権限がありません" }, 403);
    const name = (await staff.get(env.KV, u.userId))?.name || u.name || "スタッフ";
    const r = await applyStockCount(env, facility, counts, { name, userId: u.userId });
    return json({ ok: true, facility, diffs: r.diffs, message: r.text });
  }
  return new Response("Not found", { status: 404 });
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>リネン入力</title>
<style>
body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;background:#f4f4f4;color:#222}
.wrap{padding:16px;max-width:520px;margin:0 auto}
h1{font-size:18px;margin:0 0 12px}
select,input{font-size:18px;padding:10px;border:1px solid #ccc;border-radius:8px;width:100%;box-sizing:border-box}
.row{display:flex;align-items:center;background:#fff;border-radius:10px;padding:10px 12px;margin:8px 0}
.row label{flex:1;font-size:16px}
.row input{width:110px;text-align:right}
.row small{color:#888;margin-right:8px;font-size:12px}
button{width:100%;font-size:18px;padding:14px;border:0;border-radius:10px;background:#06c755;color:#fff;margin-top:12px}
button:disabled{background:#aaa}
.msg{white-space:pre-wrap;background:#fff;border-radius:10px;padding:12px;margin-top:12px}
.err{color:#c00}
</style></head><body><div class="wrap">
<h1>リネン入力（今ある枚数）</h1>
<div id="app">読み込み中…</div>
</div>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
const LIFF_ID="__LIFF_ID__";
let data=null,idToken=null;
async function main(){
  const app=document.getElementById('app');
  try{
    await liff.init({liffId:LIFF_ID});
    if(!liff.isLoggedIn()){liff.login();return;}
    idToken=liff.getIDToken();
    const r=await fetch('/liff/linen/me',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken})});
    data=await r.json();
    if(data.error){app.innerHTML='<p class="err">'+data.error+'</p>';return;}
    render();
  }catch(e){app.innerHTML='<p class="err">エラー: '+e.message+'</p>';}
}
function render(){
  const app=document.getElementById('app');
  const f=data.facilities;
  app.innerHTML='<select id="fac">'+f.map(x=>'<option>'+x+'</option>').join('')+'</select><div id="items"></div><button id="send">送信</button><div id="out"></div>';
  const sel=document.getElementById('fac');
  const draw=()=>{const st=data.stock[sel.value]||{};document.getElementById('items').innerHTML=data.items.map(n=>'<div class="row"><label>'+n+'</label><small>前回 '+(st[n]??'-')+'</small><input type="number" inputmode="numeric" min="0" data-n="'+n+'" value="'+(st[n]??'')+'"></div>').join('');};
  sel.onchange=draw;draw();
  document.getElementById('send').onclick=async()=>{
    const btn=document.getElementById('send');btn.disabled=true;btn.textContent='送信中…';
    const counts={};document.querySelectorAll('input[data-n]').forEach(i=>counts[i.dataset.n]=i.value);
    if(!confirm(sel.value+' の枚数を送信します。よろしいですか？')){btn.disabled=false;btn.textContent='送信';return;}
    const r=await fetch('/liff/linen/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken,facility:sel.value,counts})});
    const j=await r.json();
    document.getElementById('out').innerHTML='<div class="msg'+(j.error?' err':'')+'">'+(j.error||('✅ 送信しました\\n'+j.message))+'</div>';
    btn.textContent='送信済み';
    if(!j.error) setTimeout(()=>{ if(liff.isInClient()) liff.closeWindow(); },2500);
  };
}
main();
</script></body></html>`;

/** 棚卸の反映：入力された「今ある枚数」と在庫シートの差を restock/update で合わせ、SORAに差分を通知 */
export async function applyStockCount(env, facility, counts, { name = "スタッフ", userId = "" } = {}) {
  const cur = await gasGet(env, facility);
  const before = Object.fromEntries((cur.items || []).map(it => [it.name, it.current]));
  const diffs = [];
  const restock = [], used = [];
  for (const item of ITEMS) {
    const v = counts?.[item];
    if (v === "" || v == null || isNaN(Number(v))) continue;
    const n = Math.max(0, Math.round(Number(v)));
    const b = before[item] ?? 0;
    const d = n - b;
    diffs.push({ name: item, before: b, after: n, diff: d });
    if (d > 0) restock.push({ name: item, qty: d });
    else if (d < 0) used.push({ name: item, used: -d });
  }
  if (restock.length) await gasPost(env, { action: "restock", facility, items: restock });
  if (used.length) await gasPost(env, { action: "update", facility, items: used });
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
  await env.KV.put(`tana:${date}:${facility}`, JSON.stringify({ by: name, userId, at: new Date().toISOString(), diffs }), { expirationTtl: 60 * 60 * 24 * 365 });
  const changed = diffs.filter(d => d.diff !== 0);
  const text = `📦 棚卸 ${facility}（${name}さん）\n` + (changed.length ? changed.map(d => `${d.name}：${d.before}→${d.after}（${d.diff > 0 ? "+" : ""}${d.diff}）`).join("\n") : "理論在庫と一致（差なし）");
  try { await sora(env).push(env.SORA_TARGET_ID || env.OWNER_USER_ID, text); } catch {}
  return { diffs, text, count: diffs.length };
}
export { ITEMS as LINEN_ITEMS };
