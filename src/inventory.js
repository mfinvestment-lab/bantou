// 在庫管理BOT（HARU）: LINEの発言を解釈して GAS（スプレッドシート）を読み書きする
import { haru } from "./line.js";
import { shedTake, logUsage } from "./linen.js";

const FACILITY_LOCATION = { "サクヤ": "富士宮", "桜ハウス": "富士宮", "nel.shizuoka": "静岡" };
const FACILITY_MAP = {
  "サクヤ": "サクヤ", "さくや": "サクヤ",
  "桜ハウス": "桜ハウス", "ハウス": "桜ハウス", "さくらハウス": "桜ハウス",
  "nel": "nel.shizuoka", "ネル": "nel.shizuoka", "nel.shizuoka": "nel.shizuoka", "静岡": "nel.shizuoka"
};
const ITEM_NAMES = ["シングルシーツ", "シングルカバー", "ダブルシーツ", "ダブルカバー", "枕カバー", "バスタオル", "フェイスタオル", "バスマット"];

// 発注の対話状態。Workerのメモリ上なので再起動で消える（旧番頭と同じ挙動）。
const orderSessions = new Map();

// ---- GAS ----
const gas = {
  getAll: env => fetch(`${env.GAS_URL}?action=getAll`).then(r => r.json()),
  get: (env, facility) => fetch(`${env.GAS_URL}?action=get&facility=${encodeURIComponent(facility)}`).then(r => r.json()),
  post: (env, body) => fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()),
  checkDelivery: env => fetch(`${env.GAS_URL}?action=checkDelivery`).then(r => r.json())
};

// ---- 納品反映（毎朝 日本時間9:00） ----
export async function runDeliveryCheck(env) {
  try {
    const result = await gas.checkDelivery(env);
    if (!result.success || result.applied.length === 0) return { applied: 0 };
    let msg = "🚚 本日の納品分を在庫に反映しました\n━━━━━━━━━━━━\n";
    const byFacility = {};
    for (const it of result.applied) (byFacility[it.facility] ||= []).push(it);
    for (const [facility, items] of Object.entries(byFacility)) {
      msg += `\n【${facility}】\n`;
      for (const it of items) msg += `${it.name}　+${it.qty}枚 → ${it.newStock}枚\n`;
    }
    await haru(env).push(env.OWNER_USER_ID, msg);
    return { applied: result.applied.length };
  } catch (e) {
    console.error("Delivery check error:", e);
    return { error: e.message };
  }
}

// ---- 解析 ----
function getNextDeliveryDate(location) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const today = now.getDay();
  const deliveryDays = location === "富士宮" ? [3, 6] : [1, 4];
  let minDiff = 7;
  for (const day of deliveryDays) {
    let diff = day - today;
    if (diff <= 0) diff += 7;
    if (diff < minDiff) minDiff = diff;
  }
  const d = new Date(now);
  d.setDate(now.getDate() + minDiff);
  return {
    display: d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" }),
    iso: d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Tokyo" })
  };
}

function parseOrderInput(text) {
  let facility = null, itemName = null, qty = null;
  for (const [k, v] of Object.entries(FACILITY_MAP)) if (text.includes(k)) { facility = v; break; }
  for (const it of ITEM_NAMES) if (text.includes(it)) { itemName = it; break; }
  const m = text.match(/(\d+)/);
  if (m) qty = parseInt(m[1]);
  return facility && itemName && qty !== null ? { facility, name: itemName, qty } : null;
}

function splitByFacilityBlocks(text, valueKey) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const fkey = Object.keys(FACILITY_MAP).find(k => line.includes(k));
    const hasItem = ITEM_NAMES.some(it => line.includes(it));
    if (fkey && !hasItem) {
      if (current && current.items.length > 0) blocks.push(current);
      current = { facility: FACILITY_MAP[fkey], items: [] };
      continue;
    }
    if (hasItem && /\d/.test(line)) {
      if (!current) {
        if (fkey) current = { facility: FACILITY_MAP[fkey], items: [] };
        else continue;
      }
      for (const it of ITEM_NAMES) {
        if (line.includes(it)) {
          const m = line.match(/(\d+)/);
          if (m) current.items.push({ name: it, [valueKey]: parseInt(m[1]) });
          break;
        }
      }
    }
  }
  if (current && current.items.length > 0) blocks.push(current);
  return blocks;
}

function simpleAnalyze(text) {
  const t = text.trim();
  const isShort = t.length <= 10;
  if (isShort && (t.includes("発注") || t.includes("オーダー"))) return { type: "order_start" };
  if (isShort && ((t.includes("全") && (t.includes("在庫") || t.includes("確認"))) || t === "在庫確認")) return { type: "all_check" };
  const isRestock = t.includes("補充") || t.includes("入庫") || t.includes("追加");
  const itemLineCount = t.split("\n").filter(l => ITEM_NAMES.some(it => l.includes(it)) && /\d/.test(l)).length;
  if (t.length > 60 && itemLineCount < 1) return { type: "other" };
  if (t.includes("予定")) {
    const blocks = splitByFacilityBlocks(t, "qty");
    if (blocks.length >= 1) return { type: "preview_only", blocks };
  }
  if (isRestock) {
    const blocks = splitByFacilityBlocks(t, "qty");
    if (blocks.length === 1) return { type: "restock", facility: blocks[0].facility, items: blocks[0].items };
    if (blocks.length > 1) return { type: "restock_multi", blocks };
  }
  let facility = null;
  for (const [k, v] of Object.entries(FACILITY_MAP)) if (t.includes(k)) { facility = v; break; }
  if (isShort && facility && (t.includes("在庫") || t.includes("確認") || t.includes("残り") || t.includes("教えて")) && !/\d/.test(t)) return { type: "check", facility };
  if (/\d/.test(t)) {
    const blocks = splitByFacilityBlocks(t, "used");
    if (blocks.length === 1) return { type: "update", facility: blocks[0].facility, items: blocks[0].items };
    if (blocks.length > 1) return { type: "update_multi", blocks };
  }
  return { type: "other" };
}

// ---- 返信文 ----
const warnMark = it => (it.threshold > 0 && it.current <= it.threshold ? " ⚠️" : "");
function formatRestockReply(facility, r) {
  if (!r.success) return `❌ エラー: ${r.error}`;
  return `📦 ${facility} 在庫補充しました✅\n─────────────\n` + r.updated.map(it => `${it.name}　${it.before}枚 → ${it.current}枚`).join("\n") + "\n";
}
function formatUpdateReply(facility, r) {
  if (!r.success) return `❌ エラー: ${r.error}`;
  return `📦 ${facility} 在庫更新しました✅\n─────────────\n` + r.updated.map(it => `${it.name}　${it.current}枚${warnMark(it)}`).join("\n") + "\n";
}
function formatCheckReply(facility, s) {
  if (!s.success) return `❌ エラー: ${s.error}`;
  return `📋 ${facility} 現在の在庫\n─────────────\n` + s.items.map(it => `${it.name}　${it.current}枚${warnMark(it)}`).join("\n") + "\n";
}
function formatAllCheckReply(all) {
  if (!all.success) return `❌ エラー: ${all.error}`;
  let r = "📋 全施設 在庫状況\n";
  for (const f of all.facilities) {
    r += `\n【${f.name}】\n` + f.items.map(it => `${it.name}　${it.current}枚${warnMark(it)}`).join("\n") + "\n";
  }
  return r;
}
function formatPreviewOnlyReply(blocks) {
  let r = "📝 発注予定を確認しました（在庫は変更していません）\n─────────────\n";
  for (const b of blocks) {
    r += `【${b.facility}】\n` + b.items.map(it => `${it.name}　${it.qty}枚`).join("\n") + "\n";
  }
  return r.trim();
}
function formatAllCheckForOrderSplit(all) {
  if (!all.success) return [`❌ エラー: ${all.error}`];
  const groups = { "富士宮": [], "静岡": [] };
  for (const f of all.facilities) groups[FACILITY_LOCATION[f.name] || "富士宮"].push(f);
  const messages = [];
  for (const [loc, fs] of Object.entries(groups)) {
    if (fs.length === 0) continue;
    let msg = `📋 ${loc} 在庫状況\n`;
    for (const f of fs) msg += `\n【${f.name}】\n` + f.items.map(it => `${it.name}　${it.current}枚${warnMark(it)}`).join("\n") + "\n";
    messages.push(msg.trim());
  }
  return messages;
}
function buildOrderPreview(items) {
  if (items.length === 0) return "（まだ入力なし）";
  const grouped = {};
  for (const it of items) (grouped[it.facility] ||= []).push(it);
  let text = "現在の発注内容：\n";
  for (const [f, its] of Object.entries(grouped)) text += `【${f}】\n` + its.map(i => `${i.name}　${i.qty}枚`).join("\n") + "\n";
  return text;
}

async function saveOrders(env, orders) {
  const byDelivery = {};
  for (const o of orders) (byDelivery[o.deliveryDate] ||= []).push(o);
  for (const [deliveryDate, items] of Object.entries(byDelivery)) {
    await gas.post(env, { action: "saveOrder", orders: items, deliveryDate });
  }
}

// ---- メッセージ処理 ----
export async function handleInventoryMessage(env, text, replyToken, userId) {
  const line = haru(env);
  try {
    const t = text.trim().replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xfee0));

    if (orderSessions.has(userId)) {
      const session = orderSessions.get(userId);
      if (t === "発注完了" || t === "完了") {
        if (session.items.length === 0) {
          await line.reply(replyToken, "発注品目がありません。\n「施設名 品目 数量」の形式で入力してください。\n\n「キャンセル」で中止");
          return;
        }
        const byLocation = {};
        for (const it of session.items) (byLocation[FACILITY_LOCATION[it.facility] || it.facility] ||= []).push(it);
        const allOrders = [];
        const messages = [];
        for (const [loc, items] of Object.entries(byLocation)) {
          const delivery = getNextDeliveryDate(loc);
          let msg = `${delivery.display}\n${loc}\n\n`;
          const byFacility = {};
          for (const it of items) (byFacility[it.facility] ||= []).push(it);
          for (const [f, its] of Object.entries(byFacility)) msg += `【${f}】\n` + its.map(i => `${i.name}　${i.qty}枚`).join("\n") + "\n\n";
          messages.push(msg.trim());
          for (const it of items) allOrders.push({ ...it, deliveryDate: delivery.iso });
        }
        await saveOrders(env, allOrders);
        orderSessions.delete(userId);
        await line.replyMany(replyToken, messages);
        return;
      }
      if (t === "キャンセル" || t === "取消") {
        orderSessions.delete(userId);
        await line.reply(replyToken, "発注をキャンセルしました。");
        return;
      }
      const add = parseOrderInput(t);
      if (add) {
        const i = session.items.findIndex(x => x.facility === add.facility && x.name === add.name);
        if (i >= 0) session.items[i].qty = add.qty; else session.items.push(add);
        await line.reply(replyToken, `✅ 追加しました\n\n${buildOrderPreview(session.items)}\n続けて入力するか「発注完了」で送信、「キャンセル」で中止`);
        return;
      }
      await line.reply(replyToken, "入力形式：「施設名 品目 数量」\n例：「サクヤ バスタオル 20」\n\n「発注完了」で送信、「キャンセル」で中止");
      return;
    }

    const intent = simpleAnalyze(t);
    switch (intent.type) {
      case "order_start": {
        orderSessions.set(userId, { items: [], startTime: Date.now() });
        await line.replyMany(replyToken, formatAllCheckForOrderSplit(await gas.getAll(env)));
        return;
      }
      case "preview_only":
        await line.reply(replyToken, formatPreviewOnlyReply(intent.blocks));
        return;
      case "restock_multi": {
        const msgs = [];
        for (const b of intent.blocks) {
          msgs.push(formatRestockReply(b.facility, await gas.post(env, { action: "restock", facility: b.facility, items: b.items })));
          await shedTake(env, b.facility, b.items).catch(e => console.error("shedTake", e.message));
        }
        await line.replyMany(replyToken, msgs);
        return;
      }
      case "update_multi": {
        const msgs = [];
        for (const b of intent.blocks) {
          msgs.push(formatUpdateReply(b.facility, await gas.post(env, { action: "update", facility: b.facility, items: b.items })));
          await logUsage(env, b.facility, b.items).catch(e => console.error("logUsage", e.message));
        }
        await line.replyMany(replyToken, msgs);
        return;
      }
      case "restock":
        await line.reply(replyToken, formatRestockReply(intent.facility, await gas.post(env, { action: "restock", facility: intent.facility, items: intent.items })));
        await shedTake(env, intent.facility, intent.items).catch(e => console.error("shedTake", e.message)); // 富士宮：小屋から施設へ運んだ分を小屋から引く
        return;
      case "update":
        await line.reply(replyToken, formatUpdateReply(intent.facility, await gas.post(env, { action: "update", facility: intent.facility, items: intent.items })));
        await logUsage(env, intent.facility, intent.items).catch(e => console.error("logUsage", e.message)); // 使用数の実績（式の調整用）
        return;
      case "check":
        await line.reply(replyToken, formatCheckReply(intent.facility, await gas.get(env, intent.facility)));
        return;
      case "all_check":
        await line.reply(replyToken, formatAllCheckReply(await gas.getAll(env)));
        return;
      default:
        return; // 在庫と関係ない発言には反応しない
    }
  } catch (e) {
    console.error("handleInventoryMessage エラー:", e.message, e.stack);
    try { await line.reply(replyToken, `エラー: ${e.message}`); } catch {}
  }
}
