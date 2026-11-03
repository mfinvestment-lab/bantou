// Beds24 API v2

export const BEDS24_PROPERTIES = {
  "サクヤ": { propId: "311740", location: "富士宮", maxGuests: 10 },
  "桜ハウス": { propId: "311741", location: "富士宮", maxGuests: 8 },
  "nel.shizuoka": { propId: "311749", location: "静岡", maxGuests: 7 }
};

export async function getToken(env) {
  const res = await fetch("https://beds24.com/api/v2/authentication/token", {
    headers: { accept: "application/json", refreshToken: env.BEDS24_REFRESH_TOKEN }
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error(`Beds24トークン取得エラー: ${JSON.stringify(data)}`);
  return data.token;
}

async function getBookings(token, query) {
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
