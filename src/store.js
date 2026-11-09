// KV の薄いラッパー。物件ごとの返信ルール・FAQ・学習例、承認カードの状態を持つ。
const MAX_EXAMPLES = 50;
const MAX_FAQ = 60;

const j = {
  get: async (kv, key, fallback) => { const v = await kv.get(key, "json"); return v ?? fallback; },
  put: (kv, key, val, opt) => kv.put(key, JSON.stringify(val), opt)
};

// 物件名の正規化（表記ゆれ対策）
export function normalizeProperty(name) {
  if (!name) return null;
  const t = name.trim();
  const map = {
    "サクヤ": "サクヤ", "さくや": "サクヤ", "sakuya": "サクヤ", "SAKUYA": "サクヤ",
    "桜ハウス": "桜ハウス", "さくらハウス": "桜ハウス", "sakurahaus": "桜ハウス", "SAKURAHAUS": "桜ハウス",
    "nel": "nel.shizuoka", "ネル": "nel.shizuoka", "nel.shizuoka": "nel.shizuoka"
  };
  // Beds24上の表記は "nel. shizuoka"（空白入り）。空白・記号を無視して照合する
  const k = t.toLowerCase().replace(/[\s._\-・]/g, "");
  if (k === "nelshizuoka") return "nel.shizuoka";
  return map[t] || map[t.toLowerCase()] || t;
}

// 表記ゆれ・省略名を Beds24 の物件名に寄せる（Beds24 の物件一覧を KV にキャッシュして照合）
// 例: "simplestay" → "SimpleStay Shibuya Shinjuku"、"ねね" → "アパートメントねね"
const squash = s => String(s).toLowerCase().replace(/[\s._\-・]/g, "");
export const aliases = {
  get: (kv) => j.get(kv, "alias:map", {}),
  async add(kv, canonical, list) {
    const m = await this.get(kv);
    for (const a of list) if (a) m[squash(a)] = canonical;
    await j.put(kv, "alias:map", m);
    return m;
  },
  async remove(kv, alias) {
    const m = await this.get(kv);
    const had = m[squash(alias)];
    delete m[squash(alias)];
    await j.put(kv, "alias:map", m);
    return had;
  }
};
export async function resolveProperty(kv, name) {
  const s = normalizeProperty(name);
  if (!s) return null;
  if (kv) { const al = await aliases.get(kv); if (al[squash(s)]) return al[squash(s)]; }
  if (["サクヤ", "桜ハウス", "nel.shizuoka"].includes(s)) return s;
  const map = kv ? await props.get(kv) : null;
  const names = map ? [...new Set(Object.values(map))] : [];
  const key = squash(s);
  const hit = names.find(n => squash(n) === key) || names.find(n => squash(n).includes(key)) || names.find(n => key.includes(squash(n)));
  return hit ? normalizeProperty(hit) : s;
}
export async function listProperties(kv) {
  const map = kv ? await props.get(kv) : null;
  const names = map ? [...new Set(Object.values(map).map(normalizeProperty))] : [];
  return names.length ? names : ["サクヤ", "桜ハウス", "nel.shizuoka"];
}

// ---- 返信ルール ----
export const rules = {
  get: (kv, p) => kv.get(`rules:${p}`),
  set: (kv, p, text) => kv.put(`rules:${p}`, text)
};

// ---- FAQ ----
export const faq = {
  list: (kv, p) => j.get(kv, `faq:${p}`, []),
  async add(kv, p, q, a) {
    const list = await this.list(kv, p);
    list.push({ q, a, at: new Date().toISOString() });
    await j.put(kv, `faq:${p}`, list.slice(-MAX_FAQ));
    return list.length;
  },
  async remove(kv, p, index1) {
    const list = await this.list(kv, p);
    const removed = list.splice(index1 - 1, 1)[0];
    await j.put(kv, `faq:${p}`, list);
    return removed;
  },
  update: (kv, p, list) => j.put(kv, `faq:${p}`, list),
  // 「次から自動返信」フラグ
  async setAuto(kv, p, indexes1, on) {
    const list = await this.list(kv, p);
    let n = 0;
    for (const i of indexes1) { if (list[i - 1]) { list[i - 1].auto = !!on; n++; } }
    await j.put(kv, `faq:${p}`, list);
    return n;
  }
};

// ---- 学習例（スタッフが実際に送った返信） ----
export const examples = {
  list: (kv, p) => j.get(kv, `ex:${p}`, []),
  async add(kv, p, q, a, meta = {}) {
    const list = await this.list(kv, p);
    list.unshift({ q, a, at: new Date().toISOString(), ...meta }); // 新しい順
    await j.put(kv, `ex:${p}`, list.slice(0, MAX_EXAMPLES));
    return list.length;
  },
  async remove(kv, p, index1) {
    const list = await this.list(kv, p);
    const removed = list.splice(index1 - 1, 1)[0];
    await j.put(kv, `ex:${p}`, list);
    return removed;
  }
};

// ---- 承認カード ----
export const cards = {
  get: (kv, id) => j.get(kv, `card:${id}`, null),
  put: (kv, id, card) => j.put(kv, `card:${id}`, card, { expirationTtl: 60 * 60 * 24 * 7 }),
  // 「修正して送信」「自分で書く」で、次のテキスト入力を待っている状態
  awaiting: {
    get: (kv, userId) => kv.get(`await:${userId}`),
    set: (kv, userId, cardId) => kv.put(`await:${userId}`, cardId, { expirationTtl: 60 * 30 }),
    clear: (kv, userId) => kv.delete(`await:${userId}`)
  }
};

// ---- 既読管理 ----
export const seen = {
  has: async (kv, msgId) => (await kv.get(`seen:${msgId}`)) !== null,
  mark: (kv, msgId) => kv.put(`seen:${msgId}`, "1", { expirationTtl: 60 * 60 * 24 * 30 })
};

// ---- 値付けの記録（当社が行った価格・条件の変更） ----
export const pricelog = {
  async add(kv, { property, change, reason, by, source = "manual", date }) {
    const d = date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
    const id = `${d}-${Date.now().toString(36)}`;
    await kv.put(`pricelog:${id}`, JSON.stringify({ id, date: d, property, change, reason: reason || "", by: by || "", source, at: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 400 });
    return id;
  },
  async list(kv, days = 30) {
    const l = await kv.list({ prefix: "pricelog:" });
    const since = new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
    const items = (await Promise.all(l.keys.map(k => kv.get(k.name, "json")))).filter(x => x && x.date >= since);
    return items.sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
  },
  async remove(kv, id) { await kv.delete(`pricelog:${id}`); }
};

// ---- 物件ID→名前のキャッシュ ----
export const props = {
  get: (kv) => j.get(kv, "props:map", null),
  set: (kv, map) => j.put(kv, "props:map", map, { expirationTtl: 60 * 60 * 24 })
};
