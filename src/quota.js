// LINE の月間通数（SORA・HARU）。LINE公式の数字（上限・今月の使用数・日別の内訳）と、システム内の用途別記録
const API = "https://api.line.me/v2/bot";
const get = (token, path) => fetch(API + path, { headers: { Authorization: `Bearer ${token}` } }).then(async r => (r.ok ? r.json() : { error: r.status }));
const jst = () => new Date(Date.now() + 9 * 3600e3);

async function channelUsage(env, ch, token) {
  const [q, c] = await Promise.all([get(token, "/message/quota"), get(token, "/message/quota/consumption")]);
  const now = jst(), y = now.getUTCFullYear(), m = now.getUTCMonth(), today = now.getUTCDate();
  const days = [];
  for (let d = 1; d < today; d++) days.push(`${y}${String(m + 1).padStart(2, "0")}${String(d).padStart(2, "0")}`);
  const daily = await Promise.all(days.map(async d => ({ d, r: await get(token, `/insight/message/delivery?date=${d}`) })));
  const sum = { push: 0, multicast: 0, broadcast: 0, reply: 0, other: 0 };
  const byDay = [];
  for (const { d, r } of daily) {
    if (r.status !== "ready") continue;
    const push = (r.apiPush || 0), mc = (r.apiMulticast || 0) + (r.apiNarrowcast || 0), bc = (r.apiBroadcast || 0) + (r.broadcast || 0) + (r.targeting || 0);
    sum.push += push; sum.multicast += mc; sum.broadcast += bc; sum.reply += r.apiReply || 0;
    sum.other += (r.welcomeResponse || 0) + (r.autoResponse || 0) + (r.chat || 0) + (r.stepMessage || 0);
    byDay.push({ d: d.slice(6), n: push + mc + bc });
  }
  const log = (env.KV && await env.KV.get(`pushlog:${now.toISOString().slice(0, 7)}:${ch}`, "json")) || {};
  return { ch, limit: q.type === "limited" ? q.value : q.type === "none" ? "無制限" : q.value ?? "?", used: c.totalUsage ?? "?", sum, byDay, log };
}

export async function lineUsage(env) {
  return Promise.all([
    channelUsage(env, "SORA", env.SORA_CHANNEL_ACCESS_TOKEN),
    channelUsage(env, "HARU", env.HARU_CHANNEL_ACCESS_TOKEN)
  ]);
}

export async function usageText(env) {
  const rs = await lineUsage(env);
  const now = jst();
  const L = [`📊 LINE通数 ${now.getUTCMonth() + 1}月（${now.getUTCMonth() + 1}/${now.getUTCDate()} 時点）`];
  for (const r of rs) {
    L.push("", `【${r.ch}】${r.used}／${r.limit}通`);
    L.push(`内訳（昨日まで）：push ${r.sum.push}・一斉 ${r.sum.multicast + r.sum.broadcast}　※返信 ${r.sum.reply} は無料`);
    const top = [...r.byDay].sort((a, b) => b.n - a.n).slice(0, 3).filter(x => x.n);
    if (top.length) L.push(`多い日：${top.map(x => `${Number(x.d)}日 ${x.n}`).join("・")}`);
    const lg = Object.entries(r.log).sort((a, b) => b[1].msgs - a[1].msgs).slice(0, 8);
    if (lg.length) L.push("用途（記録開始後）：", ...lg.map(([k, v]) => `・${k} ${v.msgs}`));
  }
  L.push("", "※グループへの送信は人数分で数えられます");
  return L.join("\n");
}
