// 清掃通知（毎朝 日本時間8:00）: Beds24 → HARU の清掃グループへ
import { BEDS24_PROPERTIES, getToken, fetchFacilityBookings, nowJST, formatDateYMD, addDays, nightsBetween } from "./beds24.js";
import { haru } from "./line.js";
import { cleaningButtonsMessage } from "./cleanlog.js";

async function isWeekendOrHoliday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6) return true;
  try {
    const res = await fetch("https://holidays-jp.github.io/api/v1/date.json");
    if (!res.ok) return false;
    const holidays = await res.json();
    return Object.prototype.hasOwnProperty.call(holidays, dateStr);
  } catch (e) {
    console.error("祝日API取得エラー:", e);
    return false;
  }
}

// 本日チェックアウトがある施設について「何名何泊分の清掃か」を決める
function calcCleaningInfo(r, maxGuests) {
  if (!r.hasCheckoutToday) return null;
  if (r.checkinsToday.length > 0) {
    const g = r.checkinsToday[0];
    return { count: g.numAdult + (g.numChild || 0), nights: nightsBetween(g.arrival, g.departure) };
  }
  if (r.nextFutureCheckin) {
    const next = r.nextFutureCheckin;
    const tomorrow = formatDateYMD(addDays(new Date(r.today + "T00:00:00+09:00"), 1));
    const nextInfo = { count: next.numAdult + (next.numChild || 0), nights: nightsBetween(next.arrival, next.departure) };
    if (next.arrival === tomorrow) return nextInfo;
    const maxOption = { count: maxGuests, nights: 1 };
    return maxOption.count * maxOption.nights >= nextInfo.count * nextInfo.nights ? maxOption : nextInfo;
  }
  return { count: maxGuests, nights: 1 };
}

export async function collectFacilityInfo(env) {
  const token = await getToken(env);
  const now = nowJST();
  const todayStr = formatDateYMD(now);
  const rangeEnd = formatDateYMD(addDays(now, 14));
  const info = {};
  for (const [name, p] of Object.entries(BEDS24_PROPERTIES)) {
    const bookings = await fetchFacilityBookings(token, p.propId, todayStr, rangeEnd);
    const pick = b => ({ numAdult: b.numAdult || 0, numChild: b.numChild || 0, arrival: b.arrival, departure: b.departure });
    const checkoutsToday = bookings.filter(b => b.departure === todayStr);
    const checkinsToday = bookings.filter(b => b.arrival === todayStr).map(pick);
    const future = bookings.filter(b => b.arrival > todayStr).sort((a, b) => a.arrival.localeCompare(b.arrival)).map(pick);
    const r = { today: todayStr, hasCheckoutToday: checkoutsToday.length > 0, checkinsToday, nextFutureCheckin: future[0] || null };
    info[name] = { cleaning: calcCleaningInfo(r, p.maxGuests), location: p.location, raw: r };
  }
  return { todayStr, info };
}

export async function runCleaningNotification(env) {
  const line = haru(env);
  const { todayStr, info } = await collectFacilityInfo(env);

  const fujinomiya = ["サクヤ", "桜ハウス"];
  let fujinomiyaResult = null;
  if (fujinomiya.some(f => info[f].cleaning !== null)) {
    const holiday = await isWeekendOrHoliday(todayStr);
    const groupId = holiday ? env.LINE_GROUP_FUJINOMIYA_HOLIDAY : env.LINE_GROUP_FUJINOMIYA_WEEKDAY;
    let msg = "おはようございます。\n本日もよろしくお願いします。\n";
    for (const f of fujinomiya) {
      const c = info[f].cleaning;
      msg += c ? `${f}　${c.count}名${c.nights}泊\n` : `${f}　なし\n`;
    }
    const cards = fujinomiya.filter(f => info[f].cleaning).map(f => ({ name: f, text: `${info[f].cleaning.count}名${info[f].cleaning.nights}泊` }));
    await line.pushMessages(groupId, [{ type: "text", text: msg.trim() }, cleaningButtonsMessage(todayStr, cards)]);
    fujinomiyaResult = { sentTo: holiday ? "富士宮休日チーム" : "富士宮平日チーム", message: msg.trim() };
  }

  let shizuokaResult = null;
  const nel = info["nel.shizuoka"].cleaning;
  if (nel) {
    const msg = `おはようございます。\n本日もよろしくお願いします。\nnel.shizuoka　${nel.count}名${nel.nights}泊`;
    await line.pushMessages(env.LINE_GROUP_SHIZUOKA, [{ type: "text", text: msg }, cleaningButtonsMessage(todayStr, [{ name: "nel.shizuoka", text: `${nel.count}名${nel.nights}泊` }])]);
    shizuokaResult = { sentTo: "静岡チーム", message: msg };
  }

  return { success: true, today: todayStr, fujinomiya: fujinomiyaResult, shizuoka: shizuokaResult };
}
