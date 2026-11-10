// 清掃委託先のLINEグループ（HARUを招待）向け：物件の紐づけ、10時の開始/終了ボタン配信
// 紐づけは KV `cfac:<物件>` = { checkin, groups:[groupId], propId, label } と `cgroup:<groupId>` = { props:[物件] }
import { haru, sora } from "./line.js";
import { getToken, getBookings, formatDateYMD, fetchPropertyMap } from "./beds24.js";
import { resolveProperty, props as propsCache, normalizeProperty } from "./store.js";

const DISPLAY = { "The Bunkhouse Nagoya": "Bunkhouse", "SimpleStayShibuyaShinjyuku": "SimpleStay", "SimpleStay Shibuya Shinjyuku": "SimpleStay", "アパートメントねね": "ねね" };
const DEFAULT_CHECKIN = { "SimpleStayShibuyaShinjyuku": "17:00" };
export const disp = n => DISPLAY[n] || n;

export const cfac = {
  get: (kv, name) => kv.get(`cfac:${name}`, "json"),
  put: (kv, name, v) => kv.put(`cfac:${name}`, JSON.stringify(v)),
  async all(kv) { const l = await kv.list({ prefix: "cfac:" }); return Promise.all(l.keys.map(async k => ({ name: k.name.slice(5), ...(await kv.get(k.name, "json")) }))); }
};
export const cgroup = {
  get: (kv, gid) => kv.get(`cgroup:${gid}`, "json"),
  put: (kv, gid, v) => kv.put(`cgroup:${gid}`, JSON.stringify(v)),
  async all(kv) { const l = await kv.list({ prefix: "cgroup:" }); return Promise.all(l.keys.map(async k => ({ groupId: k.name.slice(7), ...(await kv.get(k.name, "json")) }))); }
};

async function propIdOf(env, name) {
  let map = await propsCache.get(env.KV);
  if (!map) { map = await fetchPropertyMap(await getToken(env)); await propsCache.set(env.KV, map); }
  return Object.keys(map).find(id => normalizeProperty(map[id]) === name) || null;
}

/** 委託先グループでのテキストコマンド。対象外なら false */
export async function handleContractorText(env, event, text) {
  const gid = event.source.groupId || event.source.roomId;
  if (!gid) return false;
  const line = haru(env);
  const isOwner = event.source.userId === env.OWNER_USER_ID;
  const [cmd, ...args] = text.split(/\s+/);

  if (cmd === "物件登録" || cmd === "物件解除") {
    if (!isOwner) { await line.reply(event.replyToken, "物件の登録はオーナーのみできます。"); return true; }
    if (!args.length) { await line.reply(event.replyToken, `形式：${cmd} 物件名 [物件名…]\n例：物件登録 SimpleStay Bunkhouse ねね`); return true; }
    const g = (await cgroup.get(env.KV, gid)) || { props: [] };
    const done = [], ng = [];
    for (const a of args) {
      const name = await resolveProperty(env.KV, a);
      const propId = name && await propIdOf(env, name);
      if (!propId) { ng.push(a); continue; }
      const cur = (await cfac.get(env.KV, name)) || { checkin: DEFAULT_CHECKIN[name] || "16:00", groups: [] };
      if (cmd === "物件登録") {
        cur.groups = [...new Set([...(cur.groups || []), gid])]; cur.propId = propId; cur.label = disp(name);
        g.props = [...new Set([...g.props, name])];
      } else {
        cur.groups = (cur.groups || []).filter(x => x !== gid);
        g.props = g.props.filter(x => x !== name);
      }
      await cfac.put(env.KV, name, cur); done.push(`${disp(name)}（IN ${cur.checkin}）`);
    }
    await cgroup.put(env.KV, gid, g);
    await line.reply(event.replyToken, `${cmd === "物件登録" ? "✅ このグループに登録" : "🗑 このグループから解除"}：${done.join("、") || "なし"}${ng.length ? `\n⚠ Beds24に見つからない：${ng.join("、")}` : ""}\n\n登録した物件は、チェックアウトがある日の10時に開始・終了ボタンが届きます。\nチェックイン時刻の変更：チェックイン 物件名 17:00`);
    return true;
  }
  if (cmd === "チェックイン" && args.length === 2 && /^\d{1,2}:\d{2}$/.test(args[1])) {
    if (!isOwner) { await line.reply(event.replyToken, "オーナーのみ変更できます。"); return true; }
    const name = await resolveProperty(env.KV, args[0]);
    const cur = name && await cfac.get(env.KV, name);
    if (!cur) { await line.reply(event.replyToken, `${args[0]} はまだ登録されていません。先に「物件登録 ${args[0]}」を。`); return true; }
    cur.checkin = args[1].padStart(5, "0"); await cfac.put(env.KV, name, cur);
    await line.reply(event.replyToken, `✅ ${disp(name)} の通常チェックインを ${cur.checkin} にしました。`);
    return true;
  }
  const g = await cgroup.get(env.KV, gid);
  if (!g) return false; // 委託先グループでなければ他の処理へ
  if (text === "登録物件" || text === "物件一覧") {
    const rows = await Promise.all(g.props.map(async n => { const c = await cfac.get(env.KV, n); return `・${disp(n)}（通常IN ${c?.checkin || "16:00"}）`; }));
    await line.reply(event.replyToken, rows.length ? `このグループの物件\n${rows.join("\n")}` : "まだ物件が登録されていません。");
    return true;
  }
  if (text === "今日" || text === "清掃" || text === "ボタン") {
    // 返信で送る（通数を使わない）
    const msg = await buttonsForGroup(env, gid, g, formatDateYMD(new Date()));
    await line.replyRaw(event.replyToken, [msg || { type: "text", text: "今日はチェックアウトのある物件はありません。" }]);
    return true;
  }
  return true; // 委託先グループでは在庫BOTなど他の反応をしない
}

/** そのグループの物件のうち、今日チェックアウトがあるもののボタン */
async function buttonsForGroup(env, gid, g, date) {
  if (!g?.props?.length) return null;
  const token = await getToken(env);
  const { cleaningButtonsMessage } = await import("./cleanlog.js");
  const facs = [];
  for (const name of g.props) {
    const c = await cfac.get(env.KV, name); if (!c?.propId) continue;
    const [dep, arr] = await Promise.all([
      getBookings(token, `propertyId=${c.propId}&departureFrom=${date}&departureTo=${date}`),
      getBookings(token, `propertyId=${c.propId}&arrivalFrom=${date}&arrivalTo=${date}`)
    ]);
    const outs = dep.filter(b => b.status !== "cancelled"), ins = arr.filter(b => b.status !== "cancelled");
    if (!outs.length) continue;
    const nx = ins[0];
    const guests = nx ? `${(nx.numAdult || 0) + (nx.numChild || 0)}名${Math.round((Date.parse(nx.departure) - Date.parse(nx.arrival)) / 86400000)}泊` : null;
    facs.push({ name, label: disp(name), guests, text: nx ? `チェックアウト 10:00 → 当日イン（通常 ${c.checkin}〜）` : "チェックアウト 10:00 → 当日インなし" });
  }
  return facs.length ? cleaningButtonsMessage(date, facs, { groupId: gid }) : null;
}

/** cron（5分ごと）から：日本時間10:00〜10:09に、委託先グループへ1日1回ボタンを送る */
export async function runContractorButtons(env) {
  const now = new Date();
  const hm = now.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
  if (hm < "10:00" || hm >= "10:10") return { skipped: hm };
  const date = formatDateYMD(now);
  const out = [];
  for (const g of await cgroup.all(env.KV)) {
    const key = `cbtn:${date}:${g.groupId}`;
    if (await env.KV.get(key)) continue;
    await env.KV.put(key, "1", { expirationTtl: 60 * 60 * 30 });
    try {
      const msg = await buttonsForGroup(env, g.groupId, g, date);
      if (msg) { await haru(env).pushMessages(g.groupId, [msg]); out.push({ g: g.groupId, sent: true }); }
      else out.push({ g: g.groupId, sent: false, reason: "OUTなし" });
    } catch (e) {
      out.push({ g: g.groupId, error: e.message });
      try { await sora(env).push(env.SORA_TARGET_ID || env.OWNER_USER_ID, `⚠️ 委託先への清掃ボタン送信に失敗：${e.message.slice(0, 120)}`); } catch {}
    }
  }
  return { date, out };
}
