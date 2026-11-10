// オーナー向けの朝の要約（SORAに毎朝1通）。金額を含むので清掃スタッフ（HARU）には送らない
import { sora } from "./line.js";
import { formatDateYMD } from "./beds24.js";

const yen = n => "¥" + Math.round(n || 0).toLocaleString();
const md = ymd => { const [, m, d] = ymd.split("-").map(Number); return `${m}/${d}`; };
const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const CH = c => { const s = String(c || "").toLowerCase(); return /airbnb/.test(s) ? "Airbnb" : /booking/.test(s) ? "Booking" : /agoda/.test(s) ? "Agoda" : "直"; };

export async function buildMorningBrief(env, date = formatDateYMD(new Date())) {
  const { dayData } = await import("./dash.js");
  const d = await dayData(env, date);
  const [y, m, dd] = date.split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];

  const ins = [], outs = [], stays = [];
  for (const r of d.rows) {
    for (const b of r.ins) ins.push({ prop: r.property, ...b });
    if (r.outs.length) outs.push(r.property);
    if (r.staying) stays.push(r.property);
  }
  const inTotal = ins.reduce((a, b) => a + b.price, 0);
  const regMissing = ins.filter(b => b.registry === "missing").length;

  const L = [];
  L.push(`${m}/${dd}(${dow}) おはようございます`);
  L.push(`IN ${ins.length}件${ins.length ? " " + yen(inTotal) : ""} ／ OUT ${outs.length}件 ／ 滞在中 ${stays.length}件`);
  if (ins.length) {
    L.push("", "▼IN");
    for (const b of ins) {
      const reg = b.registry === "done" ? "名簿✓" : b.registry === "missing" ? "名簿✖" : "";
      L.push(`${b.prop} ${b.name}様 ${b.pax}名${b.nights}泊 ${yen(b.price)} ${CH(b.channel)}${reg ? " " + reg : ""}`);
    }
  }
  if (outs.length) L.push("", `▼OUT（清掃）${outs.join("・")}`);
  if (stays.length) L.push(`▼滞在中 ${stays.join("・")}`);
  if (!ins.length && !outs.length && !stays.length) L.push("", "今日は動きなし・全室空室です");
  const warn = [];
  if (regMissing) warn.push(`名簿未 ${regMissing}件`);
  if (d.kpi.reply) warn.push(`返信待ち ${d.kpi.reply}件`);
  L.push("", warn.length ? "⚠ " + warn.join("／") : "✅ 名簿未・返信待ちなし");
  return L.join("\n");
}

/** cron から：SORAに送る（push 1通/日） */
export async function sendMorningBrief(env) {
  if ((env.MORNING_BRIEF || "on") === "off") return { skipped: true };
  const text = await buildMorningBrief(env);
  const id = env.LIFF_DASH_ID || env.LIFF_ID;
  const msg = { type: "text", text };
  const messages = [msg];
  if (id) messages[0] = { ...msg, quickReply: { items: [{ type: "action", action: { type: "uri", label: "ダッシュボード", uri: `https://liff.line.me/${id}?tab=today` } }] } };
  await sora(env).pushMessages(env.SORA_TARGET_ID || env.OWNER_USER_ID, messages);
  return { sent: true, text };
}
