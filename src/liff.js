// LIFF（LINE内の入力画面）: リネン入力。/liff/linen を HARU のリッチメニューから開く
// 3つの入力：
//   使った枚数 … 清掃のあと。在庫シートから引く（グループの「リネン使用数」と同じ）。初期値は今日のアウトの人数・泊数からの見込み
//   補充       … 富士宮のみ。物置小屋から施設へ運んだ枚数。在庫シートに足し、「未補充」から引く。初期値は未補充の枚数
//   棚卸       … 2週間に1回。今ある枚数で在庫シートを上書き。初期値は在庫シートの枚数
import { sora } from "./line.js";
import { staff } from "./harucmd.js";

const FACILITY_LOC = { "サクヤ": "富士宮", "桜ハウス": "富士宮", "nel.shizuoka": "静岡" };
const LABEL = { "サクヤ": "サクヤ", "桜ハウス": "桜ハウス", "nel.shizuoka": "nel." };
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

async function who(env, idToken) {
  const u = await verifyIdToken(env, idToken);
  if (!u) return { error: "ログイン情報を確認できません", status: 401 };
  const me = u.userId === env.OWNER_USER_ID ? { loc: "*" } : await staff.get(env.KV, u.userId);
  if (!me) return { error: "担当エリアが未登録です。HARUに「登録」と送ってください", status: 403 };
  return { u, me };
}

export async function handleLiff(request, env, url) {
  const path = url.pathname;
  if (path === "/liff/linen" && request.method === "GET") {
    if (!env.LIFF_ID) return new Response("LIFF_ID が未設定です", { status: 503 });
    return new Response(PAGE.replace("__LIFF_ID__", env.LIFF_ID), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" } });
  }
  if (path === "/liff/linen/me" && request.method === "POST") {
    const { idToken } = await request.json();
    const w = await who(env, idToken);
    if (w.error) return json({ error: w.error }, w.status);
    const L = await import("./linen.js");
    const facilities = Object.keys(FACILITY_LOC).filter(f => w.me.loc === "*" || FACILITY_LOC[f] === w.me.loc);
    const shed = await L.shedGet(env);
    const out = {};
    for (const f of facilities) {
      let stock = {};
      try { const s = await gasGet(env, f); stock = Object.fromEntries((s.items || []).map(it => [it.name, it.current])); } catch {}
      let estimate = null; try { estimate = await L.estimateToday(env, f); } catch {}
      out[f] = {
        label: LABEL[f], area: FACILITY_LOC[f],
        items: Object.keys(L.FAC[f].par),
        stock, estimate,
        shed: FACILITY_LOC[f] === "富士宮" ? (shed[f] || {}) : null,
        usedToday: await L.usageLogged(env, f)
      };
    }
    return json({ name: w.u.name, facilities, data: out });
  }
  if (path === "/liff/linen/submit" && request.method === "POST") {
    const { idToken, facility, counts, mode, shedEmpty } = await request.json();
    const w = await who(env, idToken);
    if (w.error) return json({ error: w.error }, w.status);
    if (!(w.me.loc === "*" || FACILITY_LOC[facility] === w.me.loc)) return json({ error: "この物件の入力権限がありません" }, 403);
    const name = (await staff.get(env.KV, w.u.userId))?.name || w.u.name || "スタッフ";
    const L = await import("./linen.js");
    const nums = Object.entries(counts || {}).map(([n, v]) => [n, v === "" || v == null ? null : Math.max(0, Math.round(Number(v)))]).filter(([n, v]) => ITEMS.includes(n) && v != null && !isNaN(v));
    const lbl = LABEL[facility] || facility;

    if (mode === "use") {
      const items = nums.filter(([, v]) => v > 0).map(([n, v]) => ({ name: n, used: v }));
      if (!items.length) return json({ error: "枚数が入っていません" }, 400);
      const r = await gasPost(env, { action: "update", facility, items });
      if (!r.success) return json({ error: `在庫シートの更新に失敗：${r.error || ""}` }, 500);
      await L.logUsage(env, facility, items);
      return json({ ok: true, message: `【${lbl}】使った枚数を記録しました\n` + r.updated.map(it => `${it.name}　残り${it.current}枚`).join("\n") });
    }
    if (mode === "restock") {
      if (FACILITY_LOC[facility] !== "富士宮") return json({ error: "静岡は納品の翌日に自動で在庫に入ります。補充の入力は不要です" }, 400);
      const items = nums.filter(([, v]) => v > 0).map(([n, v]) => ({ name: n, qty: v }));
      if (!items.length) return json({ error: "枚数が入っていません" }, 400);
      const r = await gasPost(env, { action: "restock", facility, items });
      if (!r.success) return json({ error: `在庫シートの更新に失敗：${r.error || ""}` }, 500);
      await L.shedTake(env, facility, items);
      return json({ ok: true, message: `【${lbl}】補充を記録しました\n` + r.updated.map(it => `${it.name}　${it.before}→${it.current}枚`).join("\n") });
    }
    // 棚卸
    const r = await applyStockCount(env, facility, Object.fromEntries(nums), { name, userId: w.u.userId });
    if (shedEmpty && FACILITY_LOC[facility] === "富士宮") await L.shedClear(env, facility);
    return json({ ok: true, message: r.text + (shedEmpty ? "\n（小屋の未補充分は0にしました）" : "") });
  }
  return new Response("Not found", { status: 404 });
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>リネン入力</title>
<style>
body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;background:#f4f4f4;color:#222}
.wrap{padding:16px;max-width:520px;margin:0 auto}
h1{font-size:18px;margin:0 0 12px}
select{font-size:18px;padding:10px;border:1px solid #ccc;border-radius:8px;width:100%;box-sizing:border-box;background:#fff}
.tabs{display:flex;gap:6px;margin:12px 0 4px}
.tabs button{flex:1;margin:0;padding:12px 4px;font-size:16px;background:#fff;color:#333;border:2px solid #ddd}
.tabs button.on{background:#06c755;color:#fff;border-color:#06c755}
.hint{font-size:13px;color:#555;background:#fff;border-radius:10px;padding:10px 12px;margin:8px 0;line-height:1.6}
.warn{background:#fff4e5;color:#8a4b00}
.row{display:flex;align-items:center;background:#fff;border-radius:10px;padding:8px 12px;margin:6px 0}
.row label{flex:1;font-size:16px}
.row small{color:#888;margin-right:8px;font-size:12px;text-align:right}
.row input{width:90px;font-size:20px;padding:8px;border:1px solid #ccc;border-radius:8px;text-align:right}
.chk{display:flex;gap:8px;align-items:center;background:#fff;border-radius:10px;padding:12px;margin:8px 0;font-size:15px}
.chk input{width:22px;height:22px}
.send{width:100%;font-size:18px;padding:14px;border:0;border-radius:10px;background:#06c755;color:#fff;margin-top:12px}
.send:disabled{background:#aaa}
.msg{white-space:pre-wrap;background:#fff;border-radius:10px;padding:12px;margin-top:12px}
.err{color:#c00}
</style></head><body><div class="wrap">
<h1>リネン入力</h1>
<div id="app">読み込み中…</div>
</div>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
const LIFF_ID="__LIFF_ID__";
let D=null,idToken=null,mode="use";
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function main(){
  try{
    await liff.init({liffId:LIFF_ID});
    if(!liff.isLoggedIn()){liff.login();return;}
    idToken=liff.getIDToken();
    const r=await fetch('/liff/linen/me',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken})});
    D=await r.json();
    if(D.error){$('#app').innerHTML='<p class="err">'+esc(D.error)+'</p>';return;}
    $('#app').innerHTML='<select id="fac">'+D.facilities.map(f=>'<option value="'+esc(f)+'">'+esc(D.data[f].label)+'</option>').join('')+'</select><div class="tabs" id="tabs"></div><div id="body"></div><button class="send" id="send">送信</button><div id="out"></div>';
    $('#fac').onchange=()=>{ if(mode==='restock'&&!D.data[$('#fac').value].shed) mode='use'; draw(); };
    $('#send').onclick=send;
    draw();
  }catch(e){$('#app').innerHTML='<p class="err">エラー: '+esc(e.message)+'</p>';}
}
function draw(){
  const f=$('#fac').value, d=D.data[f];
  const tabs=[['use','使った枚数'],['restock','補充'],['count','棚卸']].filter(t=>t[0]!=='restock'||d.shed);
  $('#tabs').innerHTML=tabs.map(t=>'<button class="'+(mode===t[0]?'on':'')+'" data-m="'+t[0]+'">'+t[1]+'</button>').join('');
  document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>{mode=b.dataset.m;draw();});
  let hint='',init={},side={};
  if(mode==='use'){
    hint=d.estimate?'清掃のあと、使った枚数を入れてください。<br>今日のアウト：'+d.estimate.n+'名'+d.estimate.k+'泊（見込みを入れてあります。実際の枚数に直してください）':'清掃のあと、使った枚数を入れてください。<br>今日のアウトはありません（臨時の清掃なら入力してください）';
    if(d.usedToday) hint+='<div class="hint warn">今日はすでに入力済みです：'+Object.entries(d.usedToday).map(([k,v])=>esc(k)+v).join('・')+'<br>追加分だけ入れてください（同じ数を入れると二重になります）</div>';
    init=d.usedToday?{}:(d.estimate?d.estimate.items:{});
    side=d.stock;
  }else if(mode==='restock'){
    const has=Object.values(d.shed).some(v=>v>0);
    hint='物置小屋から施設に運んだ枚数を入れてください。<br>'+(has?'まだ運んでいない分（未補充）を入れてあります。':'未補充の分はありません。');
    init=d.shed; side=d.shed;
  }else{
    hint='棚にある枚数を数えて入れてください（2週間に1回）。<br>空欄の品目は変更しません。';
    init=d.stock; side=d.stock;
  }
  const sideLabel=mode==='restock'?'未補充':'在庫';
  let html='<div class="hint">'+hint+'</div>';
  html+=d.items.map(n=>'<div class="row"><label>'+esc(n)+'</label><small>'+sideLabel+'<br>'+(side&&side[n]!=null?side[n]:'-')+'</small><input type="number" inputmode="numeric" min="0" data-n="'+esc(n)+'" value="'+(init&&init[n]!=null&&init[n]!==0?init[n]:(mode==='count'&&init&&init[n]===0?0:''))+'"></div>').join('');
  if(mode==='count'&&d.shed&&Object.values(d.shed).some(v=>v>0)) html+='<label class="chk"><input type="checkbox" id="shedEmpty"> 小屋は空（届いた分はすべて施設に運んだ）</label>';
  $('#body').innerHTML=html;
  $('#send').disabled=false;$('#send').textContent={use:'使った枚数を送信',restock:'補充を送信',count:'棚卸を送信'}[mode];
  $('#out').innerHTML='';
}
async function send(){
  const f=$('#fac').value, btn=$('#send');
  const counts={};document.querySelectorAll('input[data-n]').forEach(i=>counts[i.dataset.n]=i.value);
  const lines=Object.entries(counts).filter(([,v])=>v!=='').map(([k,v])=>k+' '+v).join('\\n');
  const title={use:'使った枚数',restock:'補充',count:'棚卸（今ある枚数）'}[mode];
  if(!lines){alert('枚数が入っていません');return;}
  if(!confirm(D.data[f].label+' の'+title+'を送信します\\n\\n'+lines))return;
  btn.disabled=true;btn.textContent='送信中…';
  const r=await fetch('/liff/linen/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken,facility:f,counts,mode,shedEmpty:!!($('#shedEmpty')&&$('#shedEmpty').checked)})});
  const j=await r.json();
  $('#out').innerHTML='<div class="msg'+(j.error?' err':'')+'">'+esc(j.error||('✅ '+j.message))+'</div>';
  if(j.error){btn.disabled=false;btn.textContent='もう一度送信';return;}
  btn.textContent='送信済み';
  setTimeout(()=>{ if(liff.isInClient()) liff.closeWindow(); },3000);
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
  const text = `📦 棚卸 ${LABEL[facility] || facility}（${name}さん）\n` + (changed.length ? changed.map(d => `${d.name}：${d.before}→${d.after}（${d.diff > 0 ? "+" : ""}${d.diff}）`).join("\n") : "在庫シートと一致（差なし）");
  try { await sora(env).push(env.SORA_TARGET_ID || env.OWNER_USER_ID, text); } catch {}
  return { diffs, text, count: diffs.length };
}
export { ITEMS as LINEN_ITEMS };
