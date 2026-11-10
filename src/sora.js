// SORA（管理用）: 承認カードのボタン処理と、FAQ・ルール・学習例の登録コマンド
import { sora, sourceIdOf } from "./line.js";
import { rules, faq, examples, resolveProperty, listProperties, props, aliases, normalizeProperty, pricelog } from "./store.js";
import { getToken, fetchPropertyMap } from "./beds24.js";
import { faqCandidates } from "./learn.js";
import { jobs } from "./jobs.js";
import { handlePostback, handleAwaitingText, pollGuestMessages, createTestCard } from "./approval.js";

const qr = (label, text) => ({ type: "action", action: { type: "message", label: label.slice(0, 20), text } });
const MENU_TEXT = "ボタンを押すか、コマンドを送ってください。\n物件名は省略形でOK（サクヤ／nel／simplestay／ねね など）。別名登録 物件名 別名1 別名2… で追加\n入力が必要なもの：\nFAQ追加 物件名（改行）Q: 質問（改行）A: 答え\nルール設定 物件名（改行）ルール本文\nルール追記 物件名 追加する文\nFAQ自動 物件名 番号（次から自動返信）／FAQ自動解除\nFAQ案 物件名 [日数]（過去のやり取りからFAQ候補）→ FAQ採用 物件名 番号…（改行して文面を直してもOK）\nFAQ修正 物件名 番号（改行）新しい回答\nFAQ一括 物件名（改行）1. Q: …（改行）A: … を複数（FAQ案を手直しして貼る）\n一斉送信 物件名（改行）文面\nFAQ削除 物件名 番号 番号…（2-7 も可）／ 学習削除 物件名 番号\n値付け 物件名 変更内容｜理由（値付けの記録。ダッシュボードに表示）";
const menuQR = { items: [qr("新着確認", "新着確認"), qr("物件一覧", "物件一覧"), qr("ルール表示", "ルール表示"), qr("FAQ一覧", "FAQ一覧"), qr("学習一覧", "学習一覧"), qr("FAQ追加", "FAQ追加")] };
const MENU = { type: "text", text: MENU_TEXT, quickReply: menuQR };
const withMenu = text => ({ type: "text", text, quickReply: menuQR });
const pickProperty = (cmd, label, list) => ({
  type: "text", text: `${label}する物件を選んでください`,
  quickReply: { items: list.slice(0, 13).map(p => qr(p, `${cmd} ${p}`)) }
});
// FAQ追加の対話状態（userId → 物件名）
const faqMode = {
  get: (kv, u) => kv.get(`mode:faqadd:${u}`),
  set: (kv, u, p) => kv.put(`mode:faqadd:${u}`, p, { expirationTtl: 600 }),
  clear: (kv, u) => kv.delete(`mode:faqadd:${u}`)
};

export async function handleSoraEvent(env, event) {
  const line = sora(env);
  const sourceId = sourceIdOf(event);
  const sourceType = event.source.groupId ? "group" : event.source.roomId ? "room" : "user";

  console.log("SORA event", JSON.stringify({ type: event.type, sourceType, sourceId, userId: event.source.userId || null, messageType: event.message?.type || null, text: event.message?.type === "text" ? event.message.text : null }));

  if (event.type === "join") {
    await line.push(sourceId, "SORAです。このグループでゲスト対応の承認カードをお届けします。「ヘルプ」でコマンド一覧。");
    return;
  }
  if (event.type === "postback") {
    const pp = new URLSearchParams(event.postback.data || "");
    if (pp.get("bcast")) { await handleBroadcastPostback(env, event, pp); return; }
    if (pp.get("linen")) { const { handleLinenPostback } = await import("./linen.js"); await handleLinenPostback(env, event, pp); return; }
    await handlePostback(env, event); return;
  }
  if (event.type !== "message" || event.message.type !== "text") return;

  // 修正・自分で書く の入力待ちなら、それを優先
  if (env.KV && (await handleAwaitingText(env, event))) return;

  const text = event.message.text.trim();
  if (env.KV) {
    const lm = await import("./linen.js");
    if (await lm.handleLinenEditText(env, event)) return;
    if ((/^(リネン発注案|小屋|小屋在庫|未補充|小屋クリア)$/.test(text) || text.startsWith("小屋登録")) && (await lm.handleLinenCommand(env, event, text))) return;
  }
  const [head, ...restLines] = text.split("\n");
  const [cmd, ...args] = head.trim().split(/\s+/);
  const userId = event.source.userId;

  try {
    // FAQ追加の入力待ち
    if (env.KV && userId) {
      const p = await faqMode.get(env.KV, userId);
      if (p && !/^(FAQ|ルール|学習|過去学習|新着|物件|別名|一斉送信|テスト|設定|ヘルプ|メニュー|ID|ping|キャンセル)/i.test(text)) {
        const q = (text.match(/Q[:：]\s*([\s\S]*?)(?=\nA[:：]|$)/) || [])[1]?.trim();
        const a = (text.match(/A[:：]\s*([\s\S]*)$/) || [])[1]?.trim();
        if (!q || !a) { await line.reply(event.replyToken, `${p} のFAQを追加します。次の形で送ってください：\nQ: 質問\nA: 答え\n\n「キャンセル」で中止`); return; }
        await faqMode.clear(env.KV, userId);
        const n = await faq.add(env.KV, p, q, a);
        await line.replyRaw(event.replyToken, [withMenu(`✅ ${p} のFAQに追加しました（${n}件目）\nQ: ${q}\nA: ${a}`)]);
        return;
      }
      if (p && text === "キャンセル") { await faqMode.clear(env.KV, userId); await line.reply(event.replyToken, "FAQ追加を中止しました。"); return; }
    }

    // 物件名なしのコマンドは物件選択ボタンを出す
    if (["FAQ一覧", "FAQ追加", "ルール表示", "学習一覧"].includes(cmd) && args.length === 0 && restLines.length === 0) {
      await line.replyRaw(event.replyToken, [pickProperty(cmd, cmd, await listProperties(env.KV))]);
      return;
    }
    if (cmd === "FAQ追加" && args[0] && restLines.length === 0) {
      const p = await resolveProperty(env.KV, args[0]);
      await faqMode.set(env.KV, userId, p);
      await line.reply(event.replyToken, `${p} のFAQを追加します。次の形で送ってください：\nQ: 質問\nA: 答え\n\n「キャンセル」で中止`);
      return;
    }
    if (text === "ID教えて" || text === "グループID教えて") {
      await line.reply(event.replyToken, `${sourceType} ID：\n${sourceId}\n\nあなたのuserId：\n${event.source.userId || "（取得不可）"}`);
      return;
    }
    if (text === "ping") { await line.reply(event.replyToken, "pong（SORA稼働中）"); return; }
    if (text === "設定") {
      await line.replyRaw(event.replyToken, [{ type: "text", text: "何をしますか？", quickReply: { items: [qr("FAQ追加", "FAQ追加"), qr("ルール表示", "ルール表示"), qr("学習一覧", "学習一覧"), qr("FAQ一覧", "FAQ一覧")] } }]);
      return;
    }
    if (text === "朝の要約" || text === "要約") {
      const { buildMorningBrief } = await import("./brief.js");
      await line.replyRaw(event.replyToken, [withMenu(await buildMorningBrief(env))]);
      return;
    }
    if (text === "今日" || text === "売上") {
      const id = env.LIFF_DASH_ID || env.LIFF_ID;
      if (!id) { await line.reply(event.replyToken, `「${text}」のダッシュボードは準備中です。`); return; }
      const tab = text === "売上" ? "sales" : "today";
      await line.replyRaw(event.replyToken, [{ type: "flex", altText: `${text}のダッシュボード`, contents: { type: "bubble", size: "kilo",
        body: { type: "box", layout: "vertical", contents: [{ type: "text", text: text === "売上" ? "売上（今月・来月）" : "今日の稼働・清掃・名簿・未返信", weight: "bold", wrap: true }] },
        footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", action: { type: "uri", label: "開く", uri: `https://liff.line.me/${id}?tab=${tab}` } }] } } }]);
      return;
    }
    if (text === "ヘルプ" || text === "help" || text === "メニュー") { await line.replyRaw(event.replyToken, [MENU]); return; }
    if (!env.KV) { if (/^(FAQ|ルール|学習|新着)/.test(cmd)) await line.reply(event.replyToken, "KVが未設定のため、登録機能はまだ使えません。"); return; }

    if (cmd === "物件一覧") {
      const map = await fetchPropertyMap(await getToken(env));
      await props.set(env.KV, map);
      const names = await listProperties(env.KV);
      const ruled = [];
      for (const n of names) ruled.push(`${(await rules.get(env.KV, n)) ? "✅" : "▫️"} ${n}`);
      await line.replyRaw(event.replyToken, [withMenu(`🏠 Beds24の物件（✅=返信ルール登録済み）\n${ruled.join("\n")}\n\nルール設定・テストはこの名前（省略形でも可）で指定してください。`)]);
      return;
    }
    if (cmd === "別名登録") {
      const p = await resolveProperty(env.KV, args[0]);
      const list = [...args.slice(1), ...restLines.join(" ").split(/\s+/)].filter(Boolean);
      if (!p || !list.length) { await line.reply(event.replyToken, "形式：別名登録 物件名 別名1 別名2 …\n例：別名登録 nel.shizuoka nel. ネル ねる"); return; }
      await aliases.add(env.KV, p, list);
      await line.reply(event.replyToken, `✅ ${p} の別名に追加しました：${list.join("、")}\n（大文字小文字・空白・記号は無視して照合します）`);
      return;
    }
    if (cmd === "別名一覧") {
      const m = await aliases.get(env.KV);
      const byP = {};
      for (const [a, p] of Object.entries(m)) (byP[p] ||= []).push(a);
      await line.reply(event.replyToken, Object.keys(byP).length ? "🔤 登録済みの別名\n" + Object.entries(byP).map(([p, as]) => `${p}：${as.join("、")}`).join("\n") : "別名はまだありません。「別名登録 物件名 別名…」で追加できます。");
      return;
    }
    if (cmd === "別名削除") {
      const r = await aliases.remove(env.KV, args[0]);
      await line.reply(event.replyToken, r ? `🗑 「${args[0]}」を削除しました（${r}）` : "その別名はありません。");
      return;
    }
    if (cmd === "過去学習") {
      const p = await resolveProperty(env.KV, args[0]);
      const days = Math.min(parseInt(args[1]) || 90, 365);
      if (!p) { await line.reply(event.replyToken, "形式：過去学習 物件名 [日数=90]\nBeds24の過去スレッドから「質問→スタッフ返信」を学習例に取り込みます。"); return; }
      await jobs.add(env.KV, { type: "import-history", property: p, days, to: sourceId });
      await line.reply(event.replyToken, `${p} の過去${days}日分を取り込みます。5分以内に結果をお送りします。`);
      return;
    }
    if (cmd === "FAQ案") {
      const p = await resolveProperty(env.KV, args[0]);
      const days = Math.min(parseInt(args[1]) || 180, 365);
      if (!p) { await line.reply(event.replyToken, "形式：FAQ案 物件名 [日数=180]\nBeds24の過去のやり取りから、FAQ候補（質問と回答案）を作ります。採用は「FAQ採用 物件名 番号…」"); return; }
      await jobs.add(env.KV, { type: "faq-suggest", property: p, days, to: sourceId });
      await line.reply(event.replyToken, `${p} の過去${days}日分からFAQ案を作ります。5分以内に結果をお送りします。`);
      return;
    }
    if (cmd === "FAQ採用") {
      const p = await resolveProperty(env.KV, args[0]);
      const cands = p ? await faqCandidates.get(env.KV, p) : null;
      if (!p || !cands) { await line.reply(event.replyToken, p ? `${p} のFAQ案がありません（3日で消えます）。先に「FAQ案 ${p}」を実行してください。` : "形式：FAQ採用 物件名 番号 [番号…]／全部\n文面を直して採用するなら：\nFAQ採用 物件名 番号（改行）直した回答\n（Q: … / A: … の形で質問も直せます）"); return; }
      const all = args.slice(1).includes("全部");
      const nums = all ? cands.map((_, i) => i + 1) : args.slice(1).map(Number).filter(n => n >= 1 && n <= cands.length);
      if (!nums.length) { await line.reply(event.replyToken, `番号を指定してください（1〜${cands.length}）。`); return; }
      // 2行目以降があれば「編集して採用」（1件のみ）
      const edit = restLines.join("\n").trim();
      if (edit) {
        if (nums.length !== 1) { await line.reply(event.replyToken, "文面を直して採用するときは番号を1つだけ指定してください。"); return; }
        const c = cands[nums[0] - 1];
        const q = (edit.match(/Q[:：]\s*([\s\S]*?)(?=\nA[:：]|$)/) || [])[1]?.trim();
        const a = (edit.match(/A[:：]\s*([\s\S]*)$/) || [])[1]?.trim() || (!/^Q[:：]/.test(edit) ? edit : "");
        if (!a) { await line.reply(event.replyToken, "回答（A:）が空です。"); return; }
        const n = await faq.add(env.KV, p, q || c.q, a);
        await line.replyRaw(event.replyToken, [withMenu(`✅ ${p} のFAQに追加しました（${n}件目・編集あり）\nQ: ${q || c.q}\nA: ${a}`)]);
        return;
      }
      const added = [], skipped = [];
      for (const n of nums) { const c = cands[n - 1]; if (!c.a) { skipped.push(n); continue; } await faq.add(env.KV, p, c.q, c.a); added.push(n); }
      const total = (await faq.list(env.KV, p)).length;
      await line.replyRaw(event.replyToken, [withMenu(`✅ ${p} のFAQに ${added.length} 件追加しました（合計${total}件）${skipped.length ? `\n❓ 回答が無いため見送り：${skipped.join(", ")}` : ""}\n「FAQ一覧 ${p}」で確認。文面を直すなら「FAQ修正 ${p} 番号（改行）新しい回答」、自動返信にするなら「FAQ自動 ${p} 番号」`)]);
      return;
    }
    if (cmd === "FAQ一括" || cmd === "FAQ一括登録") {
      const p = await resolveProperty(env.KV, args[0]);
      const body = restLines.join("\n");
      // 「1. Q: …（件数）\n   A: …」の並び、または「Q: …\nA: …」の並びを全部拾う
      const pairs = [];
      const re = /Q[:：]\s*([\s\S]*?)\n\s*A[:：]\s*([\s\S]*?)(?=\n\s*(?:\d+[.．、)]\s*)?Q[:：]|$)/g;
      let m; while ((m = re.exec(body))) { const q = m[1].replace(/（\d+件）\s*$/, "").trim(); const a = m[2].trim(); if (q && a) pairs.push({ q, a }); }
      if (!p || !pairs.length) { await line.reply(event.replyToken, "形式：\nFAQ一括 物件名\n1. Q: 質問\n   A: 答え\n2. Q: 質問\n   A: 答え\n…（FAQ案の結果を手直しして、そのまま貼ってOK）"); return; }
      for (const x of pairs) await faq.add(env.KV, p, x.q, x.a);
      await faqCandidates.clear(env.KV, p);
      const total = (await faq.list(env.KV, p)).length;
      await line.replyRaw(event.replyToken, [withMenu(`✅ ${p} のFAQに ${pairs.length} 件を一括登録しました（合計${total}件）\n` + pairs.map((x, i) => `・${x.q}`).join("\n").slice(0, 3000) + `\n\n「FAQ一覧 ${p}」で確認。直すなら「FAQ修正 ${p} 番号」`)]);
      return;
    }
    if (cmd === "FAQ修正") {
      const p = await resolveProperty(env.KV, args[0]); const n = parseInt(args[1]);
      const list = p ? await faq.list(env.KV, p) : [];
      const body = restLines.join("\n").trim();
      if (!p || !n || !list[n - 1] || !body) { await line.reply(event.replyToken, "形式：\nFAQ修正 物件名 番号\n新しい回答\n（Q: … / A: … の形で質問も直せます。番号は「FAQ一覧」で確認）"); return; }
      const q = (body.match(/Q[:：]\s*([\s\S]*?)(?=\nA[:：]|$)/) || [])[1]?.trim();
      const a = (body.match(/A[:：]\s*([\s\S]*)$/) || [])[1]?.trim() || (!/^Q[:：]/.test(body) ? body : "");
      const f = list[n - 1];
      if (q) f.q = q; if (a) f.a = a; f.editedAt = new Date().toISOString();
      await faq.update(env.KV, p, list);
      await line.replyRaw(event.replyToken, [withMenu(`✏️ ${p} のFAQ ${n} を更新しました\nQ: ${f.q}\nA: ${f.a}`)]);
      return;
    }
    if (cmd === "値付け" || cmd === "値付け記録") {
      // 形式：値付け 物件名 変更内容｜理由   または 2行目に理由
      const p = await resolveProperty(env.KV, args[0]);
      const rest = [args.slice(1).join(" "), ...restLines].join("\n").trim();
      const [change, ...reasonParts] = rest.split(/[｜|\n]/);
      if (!p || !change?.trim()) { await line.reply(event.replyToken, "形式：値付け 物件名 変更内容｜理由\n例：値付け サクヤ 12/1〜12/20の平日 -8%｜12月前半の予約ペースが前年比78%"); return; }
      const who = (await line.memberName(event.source.groupId, userId)) || "";
      await pricelog.add(env.KV, { property: p, change: change.trim(), reason: reasonParts.join(" ").trim(), by: who });
      await line.reply(event.replyToken, `📝 値付けの記録に追加しました\n${p}：${change.trim()}${reasonParts.length ? `\n理由：${reasonParts.join(" ").trim()}` : ""}\n（ダッシュボードの「ペース」タブに表示されます）`);
      return;
    }
    if (cmd === "テスト") {
      const p = await resolveProperty(env.KV, args[0]);
      const q = [args.slice(1).join(" "), ...restLines].join("\n").trim();
      if (!p || !q) { await line.reply(event.replyToken, "形式：テスト 物件名 ゲストの質問文"); return; }
      await line.reply(event.replyToken, "返信案を作っています…");
      const r = await createTestCard(env, p, q, sourceId);
      console.log("test card", JSON.stringify(r));
      return;
    }
    if (cmd === "新着確認") {
      // 結果は返事（reply）で返す＝送信数にカウントされない。処理が長引いて返事に失敗したときだけ push
      const r = await pollGuestMessages(env, { force: args[0] === "再" });
      const rs = r.results || [];
      const n = { card: rs.filter(x => x.cardId).length, auto: rs.filter(x => x.auto).length, skip: rs.filter(x => x.skipped).length, err: rs.filter(x => x.error).length };
      const lines = rs.map(x => x.cardId ? `📩 カード: ${x.category}` : x.auto ? `💬 ${x.auto}` : x.skipped ? `✔ ${x.skipped}` : `⚠️ ${x.error}`).slice(0, 10).join("\n");
      const msg = withMenu(`未読 ${r.checked ?? 0} 件（カード${n.card}・一言返し${n.auto}・不要${n.skip}${n.err ? `・エラー${n.err}` : ""}）${lines ? "\n" + lines : ""}`);
      try { await line.replyRaw(event.replyToken, [msg]); } catch { await line.pushMessages(sourceId, [msg]); }
      return;
    }
    if (cmd === "FAQ追加") {
      const p = await resolveProperty(env.KV, args[0]);
      const body = restLines.join("\n");
      const q = (body.match(/Q[:：]\s*([\s\S]*?)(?=\nA[:：]|$)/) || [])[1]?.trim();
      const a = (body.match(/A[:：]\s*([\s\S]*)$/) || [])[1]?.trim();
      if (!p || !q || !a) { await line.reply(event.replyToken, "形式：\nFAQ追加 物件名\nQ: 質問\nA: 答え"); return; }
      const n = await faq.add(env.KV, p, q, a);
      await line.reply(event.replyToken, `✅ ${p} のFAQに追加しました（${n}件目）\nQ: ${q}\nA: ${a}`);
      return;
    }
    if (cmd === "FAQ一覧") {
      const p = await resolveProperty(env.KV, args[0]);
      const list = await faq.list(env.KV, p);
      await line.reply(event.replyToken, list.length ? `📋 ${p} のFAQ（${list.length}件）\n` + list.map((f, i) => `${i + 1}. ${f.auto ? "🤖" : ""}Q: ${f.q}\n   A: ${f.a}`).join("\n").slice(0, 4500) : `${p} のFAQはまだありません。`);
      return;
    }
    if (cmd === "FAQ自動" || cmd === "FAQ自動解除") {
      const p = await resolveProperty(env.KV, args[0]); const nums = args.slice(1).map(Number).filter(Boolean);
      if (!p || !nums.length) { await line.reply(event.replyToken, `形式：${cmd} 物件名 番号 [番号…]`); return; }
      const n = await faq.setAuto(env.KV, p, nums, cmd === "FAQ自動");
      await line.reply(event.replyToken, `${cmd === "FAQ自動" ? "🤖" : "✋"} ${p} のFAQ ${nums.join(",")} を${cmd === "FAQ自動" ? "自動返信に" : "承認制に戻"}しました（${n}件）`);
      return;
    }
    if (cmd === "一斉送信") {
      // 一斉送信 物件名（改行）文面 → 滞在中のゲスト全員に確認後に送る
      const p = await resolveProperty(env.KV, args[0]); const body = [args.slice(1).join(" "), ...restLines].join("\n").trim();
      if (!p || !body) { await line.reply(event.replyToken, "形式：\n一斉送信 物件名\n文面（日本語でOK・OTAが翻訳）\n滞在中（本日到着含む）のゲスト全員に送ります。送信前に確認が出ます。"); return; }
      const { getToken, getBookings, BEDS24_PROPERTIES, formatDateYMD } = await import("./beds24.js");
      const token = await getToken(env);
      let pid = BEDS24_PROPERTIES[p]?.propId;
      if (!pid) { const map = await props.get(env.KV); pid = map && Object.keys(map).find(id => normalizeProperty(map[id]) === p); }
      if (!pid) { await line.reply(event.replyToken, `${p} のBeds24物件IDが分かりません。「物件一覧」で名前を確認してください。`); return; }
      const today = formatDateYMD(new Date());
      const guests = (await getBookings(token, `propertyId=${pid}&arrivalTo=${today}&departureFrom=${today}`)).filter(b => b.status !== "cancelled" && b.arrival <= today && b.departure > today);
      if (!guests.length) { await line.reply(event.replyToken, `${p} に本日滞在中のゲストはいません。`); return; }
      const id = `bc${Date.now()}`;
      await env.KV.put(`bcast:${id}`, JSON.stringify({ property: p, body, bookings: guests.map(b => ({ id: b.id, name: `${b.firstName || ""} ${b.lastName || ""}`.trim() })) }), { expirationTtl: 1800 });
      await line.replyRaw(event.replyToken, [{ type: "flex", altText: "一斉送信の確認", contents: { type: "bubble", size: "mega",
        header: { type: "box", layout: "vertical", backgroundColor: "#c0392b", paddingAll: "12px", contents: [{ type: "text", text: `一斉送信の確認：${p} ${guests.length}名`, color: "#ffffff", weight: "bold" }] },
        body: { type: "box", layout: "vertical", spacing: "sm", contents: [{ type: "text", text: guests.map(b => `・${`${b.firstName || ""} ${b.lastName || ""}`.trim()}（${b.arrival}〜${b.departure}）`).join("\n"), size: "xs", color: "#6b6b6b", wrap: true }, { type: "separator" }, { type: "text", text: body, size: "sm", wrap: true }] },
        footer: { type: "box", layout: "horizontal", spacing: "sm", contents: [
          { type: "button", style: "primary", color: "#c0392b", height: "sm", action: { type: "postback", label: `${guests.length}名に送信`, data: `bcast=${id}&action=send`, displayText: "一斉送信を実行" } },
          { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "やめる", data: `bcast=${id}&action=cancel`, displayText: "一斉送信を中止" } }
        ] } } }]);
      return;
    }
    if (cmd === "FAQ削除" || cmd === "削除") {
      const p = await resolveProperty(env.KV, args[0]);
      // 「2 3 4」「2-7」「2,3,4」いずれも可
      const nums = [...new Set(args.slice(1).join(" ").split(/[\s,、]+/).flatMap(t => { const r = t.match(/^(\d+)-(\d+)$/); if (r) { const a = +r[1], b = +r[2]; return Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i); } return t ? [parseInt(t)] : []; }).filter(n => n > 0))].sort((a, b) => b - a);
      if (!p || !nums.length) { await line.reply(event.replyToken, "形式：FAQ削除 物件名 番号 [番号…]（例：FAQ削除 桜ハウス 2 3 4 ／ FAQ削除 桜ハウス 2-7）"); return; }
      const removed = [];
      for (const n of nums) { const r = await faq.remove(env.KV, p, n); if (r) removed.push(`${n}. ${r.q}`); } // 大きい番号から消すので番号がずれない
      const total = (await faq.list(env.KV, p)).length;
      await line.reply(event.replyToken, removed.length ? `🗑 ${removed.length}件削除しました（残り${total}件）\n${removed.reverse().join("\n")}\n\n番号は詰まるので「FAQ一覧 ${p}」で確認してください。` : "その番号はありません。");
      return;
    }
    if (cmd === "ルール設定" || cmd === "ルール上書き") {
      const p = await resolveProperty(env.KV, args[0]);
      const body = [args.slice(1).join(" "), ...restLines].join("\n").trim();
      if (!p || !body) { await line.reply(event.replyToken, "形式：\nルール設定 物件名\nルール本文（複数行可）\n\n1行だけ足すなら：ルール追記 物件名 追加する文"); return; }
      const cur = (await rules.get(env.KV, p)) || "";
      // 既存ルールより大幅に短い本文は誤操作の可能性が高いので止める（ルール上書き で強制）
      if (cmd === "ルール設定" && cur.length > 300 && body.length < cur.length * 0.3) {
        await line.reply(event.replyToken, `⚠️ ${p} には既に ${cur.length} 文字のルールがあり、今回の本文は ${body.length} 文字です。全部を置き換えてよければ「ルール上書き ${p}」＋本文で送ってください。\n1行足すだけなら：\nルール追記 ${p} 追加する文`);
        return;
      }
      await rules.set(env.KV, p, body);
      await line.reply(event.replyToken, `✅ ${p} の返信ルールを更新しました（${body.length}文字）`);
      return;
    }
    if (cmd === "ルール追記") {
      const p = await resolveProperty(env.KV, args[0]);
      const add = [args.slice(1).join(" "), ...restLines].join("\n").trim();
      if (!p || !add) { await line.reply(event.replyToken, "形式：ルール追記 物件名 追加する文（複数行可）"); return; }
      const cur = (await rules.get(env.KV, p)) || "";
      const next = (cur ? cur + "\n" : "") + add;
      await rules.set(env.KV, p, next);
      await line.reply(event.replyToken, `✅ ${p} のルールに追記しました（${next.length}文字）\n＋ ${add}`);
      return;
    }
    if (cmd === "ルール表示") {
      const p = await resolveProperty(env.KV, args[0]);
      const r = await rules.get(env.KV, p);
      await line.reply(event.replyToken, r ? `📄 ${p} の返信ルール\n${r}`.slice(0, 4500) : `${p} のルールは未設定です。`);
      return;
    }
    if (cmd === "学習一覧") {
      const p = await resolveProperty(env.KV, args[0]);
      const list = await examples.list(env.KV, p);
      await line.reply(event.replyToken, list.length ? `🧠 ${p} の学習例（${list.length}件・新しい順）\n` + list.slice(0, 15).map((e, i) => `${i + 1}. ${e.q.slice(0, 40)}\n   → ${e.a.slice(0, 60)}`).join("\n").slice(0, 4500) : `${p} の学習例はまだありません。`);
      return;
    }
    if (cmd === "学習削除") {
      const p = await resolveProperty(env.KV, args[0]); const n = parseInt(args[1]);
      if (!p || !n) { await line.reply(event.replyToken, "形式：学習削除 物件名 番号"); return; }
      const r = await examples.remove(env.KV, p, n);
      await line.reply(event.replyToken, r ? `🗑 削除しました\n${r.q.slice(0, 60)}` : "その番号はありません。");
      return;
    }
    // それ以外は無視（ログのみ）
  } catch (e) {
    console.error("SORAコマンドエラー:", e.message, e.stack);
    try { await line.reply(event.replyToken, `エラー: ${e.message}`); } catch {}
  }
}
