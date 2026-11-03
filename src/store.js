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
  return map[t] || map[t.toLowerCase()] || t;
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

// ---- 物件ID→名前のキャッシュ ----
export const props = {
  get: (kv) => j.get(kv, "props:map", null),
  set: (kv, map) => j.put(kv, "props:map", map, { expirationTtl: 60 * 60 * 24 })
};
