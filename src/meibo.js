// 名簿チェック（今後14日の到着予約）。旧「宿泊者名簿提出LINE通知GAS」の置き換え
// 判定は Beds24 の名簿（GUESTDONE）。Beds24名簿を使わない予約（GUESTLINKなし）は「対象外」
import { getToken, getBookings, formatDateYMD } from "./beds24.js";

const DAYS = 14;
const md = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const mdw = s => `${md(s)}(${DOW[new Date(s + "T00:00:00Z").getUTCDay()]})`;

export async function meiboCheck(env, days = DAYS) {
  const { allProperties, registry, disp } = await import("./dash.js");
  const token = await getToken(env);
  const { names } = await allProperties(env, token);
  const from = formatDateYMD(new Date());
  const t = new Date(Date.parse(from + "T00:00:00Z")); t.setUTCDate(t.getUTCDate() + days);
  const to = formatDateYMD(t);
  const list = (await getBookings(token, `arrivalFrom=${from}&arrivalTo=${to}&includeInfoItems=true`))
    .filter(b => b.status !== "cancelled" && b.status !== "black")
    .sort((a, b) => a.arrival.localeCompare(b.arrival) || String(a.propertyId).localeCompare(String(b.propertyId)));
  return list.map(b => ({
    id: b.id, arrival: b.arrival, today: b.arrival === from,
    property: disp(names[String(b.propertyId)] || String(b.propertyId)),
    name: `${b.firstName || ""} ${b.lastName || ""}`.trim() || "（名前なし）",
    pax: (b.numAdult || 0) + (b.numChild || 0),
    reg: registry(b) // done | missing | n/a
  }));
}

export async function meiboText(env, days = DAYS) {
  const rows = await meiboCheck(env, days);
  if (!rows.length) return `✅ 今後${days}日間の到着予約はありません。`;
  const now = new Date(Date.now() + 9 * 3600e3).toISOString();
  const L = [`📋 名簿チェック（今後${days}日間）`, `${md(now.slice(0, 10))} ${now.slice(11, 16)} 現在`, "────────────"];
  const mark = { done: "✅", missing: "⚠️", "n/a": "▫️" };
  for (const r of rows) L.push(`${mark[r.reg]} ${mdw(r.arrival)} ${r.property}`, `　${r.name}（${r.pax}名）`);
  const c = k => rows.filter(r => r.reg === k).length;
  L.push("────────────", `⚠️ 未提出 ${c("missing")}件　✅ 提出済 ${c("done")}件${c("n/a") ? `　▫️ Beds24名簿なし ${c("n/a")}件` : ""}`);
  return L.join("\n");
}
