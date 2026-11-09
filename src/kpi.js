// 経営KPI（概要・KPI・物件・予約ペース）。Beds24の予約だけから作る。
// 前年比は「前年同月の実績」、予約ペースは「前年の同じ日時点での予約済み」（bookingTime で判定）
import { getToken, getBookings, fetchPropertyMap, formatDateYMD } from "./beds24.js";
import { props as propsCache, normalizeProperty } from "./store.js";

const DISPLAY = { "The Bunkhouse Nagoya": "Bunkhouse", "SimpleStayShibuyaShinjyuku": "SimpleStay", "SimpleStay Shibuya Shinjyuku": "SimpleStay", "アパートメントねね": "ねね", "nel.shizuoka": "nel" };
const disp = n => DISPLAY[n] || n;
// 販売チャネルの手数料率（目安。実額は各OTAの明細で）
const FEE = { airbnb: 0.155, booking: 0.15, agoda: 0.17, expedia: 0.15, rakuten: 0.10, direct: 0 };
const CHAN_LABEL = { airbnb: "Airbnb", booking: "Booking.com", agoda: "Agoda", expedia: "Expedia", rakuten: "楽天", direct: "直予約・他" };
const chanOf = b => { const c = String(b.channel || b.referer || "").toLowerCase(); return /airbnb/.test(c) ? "airbnb" : /booking/.test(c) ? "booking" : /agoda/.test(c) ? "agoda" : /expedia/.test(c) ? "expedia" : /rakuten|楽天/.test(c) ? "rakuten" : "direct"; };

const nights = b => Math.max(0, Math.round((Date.parse(b.departure) - Date.parse(b.arrival)) / 86400000));
const ym = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const monthOf = ymd => ymd.slice(0, 7);
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12
const pct = (a, b) => (b ? Math.round((a / b - 1) * 1000) / 10 : null);
const pt = (a, b) => (a != null && b != null && b !== 0 ? Math.round((a - b) * 10) / 10 : null);

async function allProperties(env, token) {
  let map = await propsCache.get(env.KV);
  if (!map) { map = await fetchPropertyMap(token); await propsCache.set(env.KV, map); }
  const names = {};
  for (const [id, n] of Object.entries(map)) { if (/new property/i.test(n)) continue; names[String(id)] = normalizeProperty(n); }
  return names;
}

/** 月ごとの集計（物件別＋合計） */
function aggregate(list, names, ymKey, asOfTs = null) {
  // asOfTs: この時刻までに入った予約だけ（予約ペースの前年同時点用）
  const rows = {}; // prop -> {rev, nights, bookings, pax, oneNight, leadSum, leadN}
  const [y, m] = ymKey.split("-").map(Number);
  const days = daysIn(y, m);
  for (const b of list) {
    if (asOfTs && Date.parse(b.bookingTime || b.created || 0) > asOfTs) continue;
    const p = disp(names[String(b.propertyId)] || String(b.propertyId));
    const r = (rows[p] ||= { rev: 0, nights: 0, bookings: 0, pax: 0, oneNight: 0, leadSum: 0, leadN: 0, chan: {} });
    const n = nights(b);
    r.rev += Number(b.price) || 0; r.nights += n; r.bookings++; r.pax += (b.numAdult || 0) + (b.numChild || 0);
    if (n === 1) r.oneNight++;
    const lead = b.bookingTime ? Math.round((Date.parse(b.arrival) - Date.parse(b.bookingTime)) / 86400000) : null;
    if (lead != null && lead >= 0) { r.leadSum += lead; r.leadN++; }
    const c = chanOf(b); r.chan[c] = (r.chan[c] || 0) + (Number(b.price) || 0);
  }
  const fin = r => ({ rev: Math.round(r.rev), nights: r.nights, bookings: r.bookings, occ: Math.round((r.nights / days) * 1000) / 10, adr: r.nights ? Math.round(r.rev / r.nights) : 0, revpar: Math.round(r.rev / days), pax: r.nights ? Math.round((r.pax / r.bookings) * 10) / 10 : 0, oneNight: r.bookings ? Math.round((r.oneNight / r.bookings) * 100) : 0, lead: r.leadN ? Math.round(r.leadSum / r.leadN) : null, chan: r.chan });
  const out = { props: {}, total: null };
  for (const [p, r] of Object.entries(rows)) out.props[p] = fin(r);
  const t = Object.values(rows).reduce((a, r) => ({ rev: a.rev + r.rev, nights: a.nights + r.nights, bookings: a.bookings + r.bookings, pax: a.pax + r.pax, oneNight: a.oneNight + r.oneNight, leadSum: a.leadSum + r.leadSum, leadN: a.leadN + r.leadN, chan: Object.entries(r.chan).reduce((c, [k, v]) => ({ ...c, [k]: (c[k] || 0) + v }), a.chan) }), { rev: 0, nights: 0, bookings: 0, pax: 0, oneNight: 0, leadSum: 0, leadN: 0, chan: {} });
  const units = Math.max(1, Object.keys(rows).length);
  out.total = fin(t); out.total.occ = Math.round((t.nights / (days * units)) * 1000) / 10; out.total.revpar = Math.round(t.rev / (days * units)); out.units = units;
  return out;
}

export async function kpiData(env) {
  const token = await getToken(env);
  const names = await allProperties(env, token);
  const propList = Object.values(names).map(disp);
  const nowJ = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const today = formatDateYMD(new Date());
  const cy = nowJ.getFullYear(), cm = nowJ.getMonth() + 1;
  // 対象：過去12か月〜5か月先（計18か月）＋その前年（前年比・前年同時点用）
  const months = [];
  for (let k = -12; k <= 5; k++) { const d = new Date(Date.UTC(cy, cm - 1 + k, 1)); months.push(ym(d)); }
  const prevMonths = months.map(k => { const [y, m] = k.split("-").map(Number); return `${y - 1}-${String(m).padStart(2, "0")}`; });
  const first = prevMonths[0] + "-01";
  const lastD = new Date(Date.UTC(cy, cm - 1 + 6, 0)); const last = formatDateYMD(lastD);
  // 到着日ベースで一括取得（ページング対応済み）→ 月に振り分け
  const all = (await getBookings(token, `arrivalFrom=${first}&arrivalTo=${last}`)).filter(b => b.status !== "cancelled" && b.arrival && b.departure);
  const byMonth = {};
  for (const b of all) (byMonth[monthOf(b.arrival)] ||= []).push(b);

  const oneYearAgo = Date.now() - 365 * 86400000;
  const series = months.map((k, i) => {
    const cur = aggregate(byMonth[k] || [], names, k);
    const prev = aggregate(byMonth[prevMonths[i]] || [], names, prevMonths[i]);
    const prevAsOf = aggregate(byMonth[prevMonths[i]] || [], names, prevMonths[i], oneYearAgo); // 前年の同じ日時点での予約済み
    const future = k > `${cy}-${String(cm).padStart(2, "0")}`;
    return { ym: k, label: `${Number(k.slice(5))}月`, year: Number(k.slice(0, 4)), future, isCurrent: k === `${cy}-${String(cm).padStart(2, "0")}`, cur, prev, prevAsOf };
  });

  // 概要：今月
  const thisM = series.find(s => s.isCurrent);
  const ytd = series.filter(s => s.year === cy && !s.future).reduce((a, s) => a + s.cur.total.rev, 0);
  const ytdPrev = series.filter(s => s.year === cy && !s.future).reduce((a, s) => a + s.prev.total.rev, 0);
  const overview = {
    month: `${cm}月`,
    revenue: thisM.cur.total.rev, revenueYoY: pct(thisM.cur.total.rev, thisM.prevAsOf.total.rev), revenuePrevFinal: thisM.prev.total.rev,
    occ: thisM.cur.total.occ, occYoY: pt(thisM.cur.total.occ, thisM.prev.total.occ),
    adr: thisM.cur.total.adr, adrYoY: pct(thisM.cur.total.adr, thisM.prev.total.adr),
    revpar: thisM.cur.total.revpar, revparYoY: pct(thisM.cur.total.revpar, thisM.prev.total.revpar),
    ytd: Math.round(ytd), ytdYoY: pct(ytd, ytdPrev), ytdLabel: `${cy}年の累計（1〜${cm}月）`
  };
  // 要点（ルールベース）
  const highlights = [];
  const paceRows = series.filter(s => s.isCurrent || s.future).map(s => ({ ym: s.ym, label: `${s.year}/${s.ym.slice(5)}`, now: s.cur.total.rev, prevAsOf: s.prevAsOf.total.rev, prevFinal: s.prev.total.rev, pace: s.prevAsOf.total.rev ? Math.round((s.cur.total.rev / s.prevAsOf.total.rev) * 100) : null, byProp: Object.fromEntries(propList.map(p => [p, s.prevAsOf.props[p]?.rev ? Math.round(((s.cur.props[p]?.rev || 0) / s.prevAsOf.props[p].rev) * 100) : null])) }));
  const slow = paceRows.filter(r => r.pace != null && r.pace < 90);
  if (slow.length) highlights.push({ tag: "注意", text: `${slow.map(r => r.label).join("・")} は前年同時点より予約が遅れています（${slow.map(r => r.pace + "%").join("・")}）。価格・最低泊数・プロモーションの見直し候補です。` });
  const lowOcc = Object.entries(thisM.cur.props).filter(([, v]) => v.occ < 50).map(([p, v]) => `${p} ${v.occ}%`);
  if (lowOcc.length) highlights.push({ tag: "稼働", text: `今月の稼働が50%未満：${lowOcc.join("、")}` });
  if (overview.revenueYoY != null) highlights.push({ tag: "売上", text: `今月の売上（予約済み）は前年同時点比 ${overview.revenueYoY >= 0 ? "+" : ""}${overview.revenueYoY}%。前年の着地は ${Math.round(overview.revenuePrevFinal / 10000)}万円。` });
  const lastMonthS = series.find(s => s.ym === months[11]);
  if (lastMonthS) { const best = Object.entries(lastMonthS.cur.props).sort((a, b) => b[1].revpar - a[1].revpar)[0]; if (best) highlights.push({ tag: "先月", text: `先月のRevPAR最高は ${best[0]}（¥${best[1].revpar.toLocaleString()}）、稼働 ${best[1].occ}%・ADR ¥${best[1].adr.toLocaleString()}` }); }

  // 物件別成績（直近3か月：先々月〜今月）
  const recent3 = series.slice(10, 13);
  const propPerf = propList.map(p => {
    const rev = recent3.reduce((a, s) => a + (s.cur.props[p]?.rev || 0), 0);
    const n = recent3.reduce((a, s) => a + (s.cur.props[p]?.nights || 0), 0);
    const days = recent3.reduce((a, s) => { const [y, m] = s.ym.split("-").map(Number); return a + daysIn(y, m); }, 0);
    const prevRev = recent3.reduce((a, s) => a + (s.prev.props[p]?.rev || 0), 0);
    const occ = Math.round((n / days) * 100);
    const rank = occ >= 80 ? "A" : occ >= 65 ? "B" : occ >= 50 ? "C" : "D";
    return { prop: p, rev: Math.round(rev), occ, adr: n ? Math.round(rev / n) : 0, revpar: Math.round(rev / days), yoy: pct(rev, prevRev), rank };
  }).sort((a, b) => b.revpar - a.revpar);

  // 販売チャネル（直近12か月）
  const chanAgg = {};
  for (const s of series.slice(0, 12)) for (const [c, v] of Object.entries(s.cur.total.chan || {})) chanAgg[c] = (chanAgg[c] || 0) + v;
  const chanTotal = Object.values(chanAgg).reduce((a, b) => a + b, 0) || 1;
  const channels = Object.entries(chanAgg).sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ key: c, label: CHAN_LABEL[c] || c, rev: Math.round(v), share: Math.round((v / chanTotal) * 100), fee: Math.round(FEE[c] * 1000) / 10 }));
  const feeAvg = Math.round((Object.entries(chanAgg).reduce((a, [c, v]) => a + v * (FEE[c] || 0), 0) / chanTotal) * 1000) / 10;

  // KPI表（物件×月）：売上/稼働/ADR/RevPAR と 泊数/人数/1泊比率/リードタイム
  const table = series.map(s => ({ ym: s.ym, label: s.label, year: s.year, future: s.future, isCurrent: s.isCurrent, total: { ...s.cur.total, prev: s.prev.total.bookings ? s.prev.total : null }, props: Object.fromEntries(propList.map(p => [p, { ...(s.cur.props[p] || { rev: 0, nights: 0, bookings: 0, occ: 0, adr: 0, revpar: 0, pax: 0, oneNight: 0, lead: null }), prev: (s.prev.props[p] && s.prev.props[p].bookings) ? s.prev.props[p] : null }])) }));

  return {
    at: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    today, props: propList, units: propList.length, overview, highlights, series: table, pace: paceRows, propPerf, channels, feeAvg,
    monthly: series.map(s => ({ ym: s.ym, label: s.label, year: s.year, future: s.future, isCurrent: s.isCurrent, rev: s.cur.total.rev, prev: s.prev.total.rev, occ: s.cur.total.occ, prevOcc: s.prev.total.occ }))
  };
}
