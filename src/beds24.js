// Beds24 API v2

export const BEDS24_PROPERTIES = {
  "サクヤ": { propId: "311740", location: "富士宮", maxGuests: 10 },
  "桜ハウス": { propId: "311741", location: "富士宮", maxGuests: 8 },
  "nel.shizuoka": { propId: "311749", location: "静岡", maxGuests: 7 }
};

// アクセストークンは KV に20分キャッシュ（Beds24のトークンは24時間有効。毎回取り直すと遅い）
export async function getToken(env) {
  if (env.KV) { const t = await env.KV.get("beds24:token"); if (t) return t; }
  // 招待コードから取り直したリフレッシュトークンが KV にあればそちらを優先（物件の追加時に Secrets を触らずに済む）
  const refresh = (env.KV && await env.KV.get("beds24:refresh")) || env.BEDS24_REFRESH_TOKEN;
  const res = await fetch("https://beds24.com/api/v2/authentication/token", {
    headers: { accept: "application/json", refreshToken: refresh }
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error(`Beds24トークン取得エラー: ${JSON.stringify(data)}`);
  if (env.KV) await env.KV.put("beds24:token", data.token, { expirationTtl: 60 * 20 });
  return data.token;
}

/** 招待コード → リフレッシュトークンを取得して KV に保存（値は返さない）。物件を増やしたときに使う */
export async function setupFromInviteCode(env, code) {
  const res = await fetch("https://beds24.com/api/v2/authentication/setup", { headers: { accept: "application/json", code } });
  const data = await res.json();
  if (!res.ok || !data.refreshToken) throw new Error(`招待コードの交換に失敗: ${JSON.stringify(data).slice(0, 200)}`);
  await env.KV.put("beds24:refresh", data.refreshToken);
  await env.KV.delete("beds24:token");
  await env.KV.delete("props:map");
  const map = await fetchPropertyMap(data.token);
  return { ok: true, properties: Object.values(map) };
}

export async function getBookings(token, query) {
  const url = `https://beds24.com/api/v2/bookings?${query}&includeInvoiceItems=false`;
  const res = await fetch(url, { headers: { accept: "application/json", token } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Beds24予約取得エラー (${query}): ${JSON.stringify(data)}`);
  return data.data || data || [];
}

// 到着が today〜rangeEnd の予約 ＋ 本日出発の予約（キャンセル除く）
export async function fetchFacilityBookings(token, propId, todayStr, rangeEndStr) {
  const [byArrival, byDeparture] = await Promise.all([
    getBookings(token, `propertyId=${propId}&arrivalFrom=${todayStr}&arrivalTo=${rangeEndStr}`),
    getBookings(token, `propertyId=${propId}&departureFrom=${todayStr}&departureTo=${todayStr}`)
  ]);
  const merged = new Map();
  for (const b of [...byArrival, ...byDeparture]) {
    if (b.status !== "cancelled") merged.set(b.id, b);
  }
  return Array.from(merged.values());
}

// 日付ユーティリティ（日本時間）
export function nowJST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}
export function formatDateYMD(date) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}
export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
export function nightsBetween(arrival, departure) {
  const a = new Date(arrival + "T00:00:00+09:00");
  const d = new Date(departure + "T00:00:00+09:00");
  return Math.max(1, Math.round((d - a) / 86400000));
}

// ---- ゲストメッセージ ----
async function api(token, path, opt = {}) {
  const res = await fetch(`https://beds24.com/api/v2${path}`, {
    ...opt,
    headers: { accept: "application/json", "Content-Type": "application/json", token, ...(opt.headers || {}) }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Beds24 ${opt.method || "GET"} ${path} エラー: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// 未読のゲストメッセージ（直近 maxAge 日）
export async function fetchUnreadGuestMessages(token, maxAgeDays = 2) {
  const d = await api(token, `/bookings/messages?source=guest&filter=unread&maxAge=${maxAgeDays}`);
  return d.data || d || [];
}

// 予約IDのスレッド（直近）
export async function fetchThread(token, bookingId, maxAgeDays = 30) {
  const d = await api(token, `/bookings/messages?bookingId=${bookingId}&maxAge=${maxAgeDays}`);
  return d.data || d || [];
}

export async function fetchBooking(token, bookingId) {
  const d = await api(token, `/bookings?id=${bookingId}&includeInvoiceItems=false`);
  const list = d.data || d || [];
  return list[0] || null;
}

// ゲストへ返信（Airbnb / Booking.com / Vrbo / email）
export async function sendGuestMessage(token, bookingId, message) {
  return api(token, "/bookings/messages", { method: "POST", body: JSON.stringify([{ bookingId, message, source: "host" }]) });
}

export async function markMessageRead(token, messageId) {
  return api(token, "/bookings/messages", { method: "POST", body: JSON.stringify([{ id: messageId, read: true }]) });
}

// 物件ID → 名前
export async function fetchPropertyMap(token) {
  const d = await api(token, "/properties");
  const map = {};
  for (const p of d.data || d || []) map[String(p.id)] = p.name;
  return map;
}
