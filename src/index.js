// デジタル番頭 v2 — HARU（清掃用）と SORA（管理用）の2チャネルを1つのWorkerで扱う
import { haru, sora, handleWebhook, sourceIdOf } from "./line.js";
import { runCleaningNotification, collectFacilityInfo } from "./cleaning.js";
import { handleInventoryMessage, runDeliveryCheck } from "./inventory.js";
import { handleSoraEvent } from "./sora.js";
import { pollGuestMessages } from "./approval.js";
import { handleCleaningPostback, cleaningButtonsMessage, todayCleaningStatus } from "./cleanlog.js";
import { handleHaruDirect } from "./harucmd.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

// 管理用エンドポイントは ADMIN_KEY（secret）が一致したときだけ使える
function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key") || new URL(request.url).searchParams.get("key");
  return env.ADMIN_KEY && key === env.ADMIN_KEY;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- LINE Webhook ---
    if (request.method === "POST" && (path === "/haru/webhook" || path === "/")) {
      // "/" は旧番頭との互換（LINE側のWebhook URLを切り替えるまでの間）
      return handleWebhook(request, ctx, haru(env), async event => {
        if (event.type === "postback") {
          if (event.postback?.data === "act=sample") { await haru(env).reply(event.replyToken, "見本のボタンです（何も記録されません）"); return; }
          await handleCleaningPostback(env, event); return;
        }
        if (event.type !== "message" || event.message.type !== "text") return;
        const text = event.message.text.trim();
        if (text === "グループID教えて") {
          const sourceType = event.source.groupId ? "グループ" : event.source.roomId ? "ルーム" : "個人";
          await haru(env).reply(event.replyToken, `${sourceType}ID：\n${sourceIdOf(event)}`);
          return;
        }
        const gid = event.source.groupId || event.source.roomId;
        // 清掃委託先のグループ（物件登録・今日のボタン）
        if (gid && env.KV && ![env.LINE_GROUP_FUJINOMIYA_WEEKDAY, env.LINE_GROUP_FUJINOMIYA_HOLIDAY, env.LINE_GROUP_SHIZUOKA, env.LINE_GROUP_LINEN].includes(gid)) {
          const { handleContractorText } = await import("./contractor.js");
          if (await handleContractorText(env, event, text)) return;
        }
        // 清掃グループ以外のグループ（リネン業者とのグループ等）では、在庫の読み取りなどに一切反応しない
        if (gid && ![env.LINE_GROUP_FUJINOMIYA_WEEKDAY, env.LINE_GROUP_FUJINOMIYA_HOLIDAY, env.LINE_GROUP_SHIZUOKA].includes(gid)) return;
        // リネン入力画面から送られた報告（在庫は画面側で反映済み）。返信（無料）で清掃終了ボタンを出す
        if (env.KV && text.startsWith("📝 リネン入力")) {
          const m = text.match(/^📝 リネン入力（(.+?)・(.+?)）/);
          const fac = m && { "サクヤ": "サクヤ", "桜ハウス": "桜ハウス", "nel.": "nel.shizuoka" }[m[1]];
          if (fac && m[2] === "使った枚数") {
            const { cleanEndButton, todayCleaningStatus } = await import("./cleanlog.js");
            const { formatDateYMD } = await import("./beds24.js");
            const d = formatDateYMD(new Date());
            const st = (await todayCleaningStatus(env, d))[fac];
            if (!st?.endAt) await haru(env).replyRaw(event.replyToken, [cleanEndButton(fac, d, `${fac} のリネン入力ありがとうございます。清掃が終わったら押してください。`)]);
          }
          return;
        }
        if (env.KV && (await handleHaruDirect(env, event))) return;
        await handleInventoryMessage(env, text, event.replyToken, event.source.userId);
      });
    }

    if (path.startsWith("/liff/dash")) {
      const { handleDash } = await import("./dash.js");
      return handleDash(request, env, url);
    }
    if (path.startsWith("/liff/")) {
      const { handleLiff } = await import("./liff.js");
      return handleLiff(request, env, url);
    }

    if (request.method === "GET" && path === "/linen/share") {
      const { handleShare } = await import("./linen.js");
      return handleShare(env, url);
    }

    if (request.method === "POST" && path === "/sora/webhook") {
      return handleWebhook(request, ctx, sora(env), event => handleSoraEvent(env, event));
    }

    // --- 管理用（ADMIN_KEY必須） ---
    if (request.method === "GET" && path.startsWith("/admin/")) {
      if (!isAdmin(request, env)) return new Response("Forbidden", { status: 403 });
      try {
        if (path === "/admin/cleaning-preview") return json(await collectFacilityInfo(env));
        if (path === "/admin/cleaning-run") return json(await runCleaningNotification(env));
        if (path === "/admin/cleaning-buttons-test") {
          // 管理者の個人チャット（HARU）にテスト用ボタンを送る。物件は ?f=サクヤ
          const f = url.searchParams.get("f") || "nel.shizuoka";
          const { formatDateYMD } = await import("./beds24.js");
          await haru(env).pushMessages(url.searchParams.get("to") || env.OWNER_USER_ID, [cleaningButtonsMessage(formatDateYMD(new Date()), [{ name: f, text: "テスト（ゲストには送信しません）", linen: "" }], { test: url.searchParams.get("live") !== "1" })]);
          return json({ ok: true, facility: f });
        }
        if (path === "/admin/arrivals") {
          // 指定日（既定: 今日）の到着予約と Info コード（名簿判定の確認用）
          const { getToken, BEDS24_PROPERTIES, formatDateYMD } = await import("./beds24.js");
          const token = await getToken(env);
          const d = url.searchParams.get("d") || formatDateYMD(new Date());
          const out = {};
          for (const [name, p] of Object.entries(BEDS24_PROPERTIES)) {
            const r = await fetch(`https://beds24.com/api/v2/bookings?propertyId=${p.propId}&arrivalFrom=${d}&arrivalTo=${d}&includeInfoItems=true&includeInvoiceItems=false`, { headers: { accept: "application/json", token } });
            out[name] = ((await r.json()).data || []).map(b => ({ id: b.id, name: `${b.firstName || ""} ${b.lastName || ""}`.trim(), status: b.status, channel: b.channel || b.referer, arrival: b.arrival, departure: b.departure, infoCodes: (b.infoItems || []).map(i => `${i.code}${i.text ? "=" + String(i.text).slice(0, 30) : ""}`) }));
          }
          return json({ date: d, arrivals: out });
        }
        if (path === "/admin/booking-info") {
          const { getToken } = await import("./beds24.js");
          const token = await getToken(env);
          const r = await fetch(`https://beds24.com/api/v2/bookings?id=${url.searchParams.get("id")}&includeInfoItems=true&includeInvoiceItems=false`, { headers: { accept: "application/json", token } });
          const b = ((await r.json()).data || [])[0] || {};
          return json({ id: b.id, name: `${b.firstName || ""} ${b.lastName || ""}`, arrival: b.arrival, departure: b.departure, status: b.status, infoItems: b.infoItems });
        }
        if (path === "/admin/autoaction-audit") {
          // 過去N日の到着予約のスレッドを走査し、名簿催促・鍵案内・当日案内が実際に送られたかを物件別に集計
          const { getToken, getBookings, fetchThread, fetchPropertyMap, formatDateYMD, addDays } = await import("./beds24.js");
          const token = await getToken(env);
          const days = Number(url.searchParams.get("days") || 30);
          const from = formatDateYMD(addDays(new Date(), -days)), to = formatDateYMD(new Date());
          const map = await fetchPropertyMap(token);
          const list = (await getBookings(token, `arrivalFrom=${from}&arrivalTo=${to}&includeInfoItems=true`)).filter(b => b.status !== "cancelled");
          const PAT = {
            remind: /名簿のご登録が確認できていません|not yet received your guest registration/i,
            keyDone: /全員分のご登録を確認|宿泊者名簿のご登録ありがとうございました|registration for all guests has been confirmed|thank you for completing the guest registration/i,
            // 「番号は別メッセージで送ります」のような文を拾わないよう、ラベル直後に実際の数字があるときだけ鍵入りとみなす
            keyInWelcome: /(キーボックス(の)?(番号|コード|暗証番号)|key[- ]?box code|키박스 번호)\s*[:：]\s*\d{3,}/i,
            welcome: /本日はチェックイン日|ご宿泊日ですね|check-in day/i
          };
          const out = {};
          for (const b of list.slice(0, 120)) {
            const prop = map[String(b.propertyId)] || String(b.propertyId);
            const o = (out[prop] ||= { arrivals: 0, withRegistry: 0, registered: 0, remindSent: 0, keyDoneSent: 0, welcomeSent: 0, welcomeWithKey: 0, samples: [] });
            o.arrivals++;
            const codes = (b.infoItems || []).map(i => i.code);
            const usesReg = codes.some(c => /GUESTLINK|GUESTREGISTRATIONID/.test(c)); if (usesReg) o.withRegistry++;
            const done = codes.includes("GUESTDONE"); if (done) o.registered++;
            let thread = []; try { thread = await fetchThread(token, b.id, days + 10); } catch {}
            const host = thread.filter(t => t.source === "host").map(t => t.message || "");
            const r = host.some(m => PAT.remind.test(m)), k = host.some(m => PAT.keyDone.test(m)), w = host.find(m => PAT.welcome.test(m));
            if (r) o.remindSent++; if (k) o.keyDoneSent++; if (w) { o.welcomeSent++; if (PAT.keyInWelcome.test(w)) o.welcomeWithKey++; }
            if (o.samples.length < 6) o.samples.push({ arrival: b.arrival, channel: b.channel || b.referer, registry: usesReg ? (done ? "済" : "未") : "対象外", remind: r, keyDone: k, welcomeWithKey: !!(w && PAT.keyInWelcome.test(w)) });
          }
          return json({ range: { from, to }, bookings: list.length, note: "remindSent=名簿催促が届いた予約数, keyDoneSent=名簿済の鍵案内が届いた数, welcomeWithKey=当日案内の本文に鍵番号が入っていた数", byProperty: out });
        }
        if (path === "/admin/claude-test") {
          // Claude API の切り分け：size=small|medium|large, max=出力上限, model=fast|careful
          const { MODELS } = await import("./claude.js");
          const size = url.searchParams.get("size") || "small";
          const max = parseInt(url.searchParams.get("max")) || 1000;
          const model = url.searchParams.get("model") === "careful" ? MODELS.careful : MODELS.fast;
          if (url.searchParams.get("p")) {
            // 実データ（キャッシュ済みのやり取り）で試す。n=使うやり取りの件数
            const { resolveProperty } = await import("./store.js");
            const { buildFaqPrompt } = await import("./learn.js");
            const prop = await resolveProperty(env.KV, url.searchParams.get("p"));
            const c = await env.KV.get(`pairs:${prop}:180:80`, "json");
            if (!c) return json({ error: "キャッシュ済みのやり取りがありません（先にFAQ案を実行）", prop });
            const n = parseInt(url.searchParams.get("n")) || c.pairs.length;
            const { system, user } = await buildFaqPrompt(env, prop, { ...c, pairs: c.pairs.slice(-n) });
            const body = { model, max_tokens: max, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] };
            const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
            const data = await res.json();
            return json({ prop, pairsUsed: n, model, max, systemChars: system.length, userChars: user.length, status: res.status, requestId: res.headers.get("request-id"), stop: data.stop_reason, usage: data.usage, blocks: (data.content || []).map(x => x.type), textHead: (data.content || []).filter(x => x.type === "text").map(x => x.text).join("").slice(0, 300), error: data.error || null });
          }
          const filler = "ゲスト: 駐車場はありますか？\n返信: 敷地内に駐車場はありません。近くのコインパーキングをご利用ください。\n";
          const n = size === "large" ? 400 : size === "medium" ? 120 : 3;
          const system = "あなたは宿泊施設のスタッフです。次のやり取りからFAQ候補を3件、JSONで出してください。\n" + filler.repeat(n);
          const body = { model, max_tokens: max, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "{\"candidates\":[...]} の形で出力してください。" }] };
          const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
          const data = await res.json();
          return json({ model, max, size, systemChars: system.length, status: res.status, stop: data.stop_reason, usage: data.usage, blocks: (data.content || []).map(c => c.type), textHead: (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").slice(0, 200), error: data.error || null });
        }
        if (path === "/admin/contractor") {
          const m = await import("./contractor.js");
          return json({ groups: await m.cgroup.all(env.KV), facilities: await m.cfac.all(env.KV) });
        }
        if (path === "/admin/morning-brief") {
          const m = await import("./brief.js");
          if (url.searchParams.get("send") === "1") return json(await m.sendMorningBrief(env));
          return new Response(await m.buildMorningBrief(env, url.searchParams.get("date") || undefined), { headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        if (path === "/admin/run-jobs") {
          const { runJobs } = await import("./jobs.js");
          return json(await runJobs(env));
        }
        if (path === "/admin/beds24-setup") {
          // Beds24 → 設定 → アカウント → API で作った招待コードを渡すと、新しいリフレッシュトークンを KV に保存する（値は表示しない）
          const code = url.searchParams.get("code");
          if (!code) return json({ error: "code（招待コード）を指定してください" }, 400);
          const { setupFromInviteCode } = await import("./beds24.js");
          return json(await setupFromInviteCode(env, code));
        }
        if (path === "/admin/line-quota") {
          // 今月の送信数（push/multicast/broadcast が対象。reply は無料で数えない）
          const q = async (token) => {
            const h = { Authorization: `Bearer ${token}` };
            const [a, b] = await Promise.all([
              fetch("https://api.line.me/v2/bot/message/quota", { headers: h }).then(r => r.json()),
              fetch("https://api.line.me/v2/bot/message/quota/consumption", { headers: h }).then(r => r.json())
            ]);
            return { limit: a.value ?? a.type, used: b.totalUsage, remaining: a.value != null ? a.value - (b.totalUsage || 0) : null };
          };
          return json({ month: new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", timeZone: "Asia/Tokyo" }), HARU: await q(env.HARU_CHANNEL_ACCESS_TOKEN), SORA: await q(env.SORA_CHANNEL_ACCESS_TOKEN) });
        }
        if (path === "/admin/dash-today") { const { todayData } = await import("./dash.js"); return json(await todayData(env)); }
        if (path === "/admin/dash-sales") { const { salesData } = await import("./dash.js"); return json(await salesData(env)); }
        if (path === "/admin/cleaning-status") return json(await todayCleaningStatus(env, url.searchParams.get("d") || undefined));
        if (path === "/admin/delivery-run") return json(await runDeliveryCheck(env));
        if (path === "/admin/linen-preview") {
          // 送らずに計算だけ。?today=YYYY-MM-DD（起点）&nominal=YYYY-MM-DD（火 or 金）
          const { computeOrder } = await import("./linen.js");
          const o = await computeOrder(env, { today: url.searchParams.get("today") || undefined, nominal: url.searchParams.get("nominal") || undefined });
          return url.searchParams.get("text") === "1" ? new Response(o.text, { headers: { "content-type": "text/plain; charset=utf-8" } }) : json(o);
        }
        if (path === "/admin/linen-run") {
          // SORAに発注案を今すぐ出す（発注日でなくても force=1 で出せる）
          const { runLinenOrder } = await import("./linen.js");
          return json(await runLinenOrder(env, { force: url.searchParams.get("force") === "1", nominal: url.searchParams.get("nominal") || undefined }));
        }
        if (path === "/admin/linen-usage") { const { usageReport } = await import("./linen.js"); return json(await usageReport(env, Number(url.searchParams.get("days") || 30))); }
        if (path === "/admin/linen-shed") { const { shedGet } = await import("./linen.js"); return json(await shedGet(env)); }
        if (path === "/admin/messages-poll") return json(await pollGuestMessages(env, { force: url.searchParams.get("force") === "1" }));
        if (path === "/admin/beds24-check") {
          const { getToken } = await import("./beds24.js");
          const token = await getToken(env);
          const r = await fetch("https://beds24.com/api/v2/authentication/details", { headers: { accept: "application/json", token } });
          return json({ status: r.status, details: await r.json() });
        }
        if (path === "/admin/timetree-check") {
          const { timetreeCheck } = await import("./timetree.js");
          return json(await timetreeCheck(env, { fresh: url.searchParams.get("fresh") === "1" }));
        }
        if (path === "/admin/timetree-cleanup") {
          const { cleanupManual } = await import("./ttsync.js");
          const props = url.searchParams.get("props")?.split(",").map(s => s.trim()).filter(Boolean);
          return json(await cleanupManual(env, { props, apply: url.searchParams.get("apply") === "1" }));
        }
        if (path === "/admin/timetree-sync") {
          const { syncTimeTree } = await import("./ttsync.js");
          const props = url.searchParams.get("props")?.split(",").map(s => s.trim()).filter(Boolean);
          return json(await syncTimeTree(env, { props, mode: url.searchParams.get("mode") || "add", apply: url.searchParams.get("apply") === "1" }));
        }
        if (path === "/admin/timetree-test-event") {
          const { timetreeTestEvent } = await import("./timetree.js");
          return json(await timetreeTestEvent(env, { keep: url.searchParams.get("keep") === "1" }));
        }
        if (path === "/admin/timetree-findapi") {
          const { timetreeFindApi } = await import("./timetree.js");
          return json(await timetreeFindApi(env));
        }
        if (path === "/admin/timetree-api") {
          const { ttApi } = await import("./timetree.js");
          const r = await ttApi(env, url.searchParams.get("path") || "/api/v2/calendars");
          if (typeof r.data === "object" && r.data?.events) r.data = { since: r.data.since, chunk: r.data.chunk, count: r.data.events.length, events: r.data.events.slice(0, 5) };
          return json(r);
        }
        if (path === "/admin/messages-mark-test") {
          const { getToken } = await import("./beds24.js");
          const token = await getToken(env);
          const id = Number(url.searchParams.get("id"));
          const r = await fetch("https://beds24.com/api/v2/bookings/messages", {
            method: "POST", headers: { accept: "application/json", "Content-Type": "application/json", token },
            body: JSON.stringify([{ id, read: true }])
          });
          return json({ status: r.status, body: await r.json() });
        }
        if (path === "/admin/messages-raw") {
          const { getToken, fetchUnreadGuestMessages } = await import("./beds24.js");
          return json(await fetchUnreadGuestMessages(await getToken(env), 7));
        }
        if (path === "/admin/line-check") {
          const check = async token => {
            const r = await fetch("https://api.line.me/v2/bot/info", { headers: { Authorization: `Bearer ${token}` } });
            return { ok: r.ok, status: r.status, info: r.ok ? await r.json() : await r.text() };
          };
          return json({ haru: await check(env.HARU_CHANNEL_ACCESS_TOKEN), sora: await check(env.SORA_CHANNEL_ACCESS_TOKEN) });
        }
        return json({ error: "unknown admin path" }, 404);
      } catch (e) {
        return json({ error: e.message, stack: e.stack }, 500);
      }
    }

    if (path === "/health") return json({ ok: true, service: "bantou", time: new Date().toISOString() });
    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    console.log(`scheduled: cron=${event.cron}`);
    const notifyOwner = async msg => {
      try { await haru(env).push(env.OWNER_USER_ID, msg); } catch (e) { console.error("エラー通知失敗:", e.message); }
    };
    if (event.cron === "0 23 * * *") {
      ctx.waitUntil(import("./dash.js").then(m => m.warmDashboard(env, { sales: true })));
      ctx.waitUntil(import("./brief.js").then(m => m.sendMorningBrief(env)).then(r => console.log("morning brief", JSON.stringify(r).slice(0, 200))).catch(e => notifyOwner(`⚠️ 朝の要約エラー: ${e.message}`)));
      ctx.waitUntil(
        runCleaningNotification(env)
          .then(r => console.log("清掃通知 完了:", JSON.stringify(r)))
          .catch(err => { console.error("清掃通知エラー:", err.message, err.stack); return notifyOwner(`⚠️ 清掃通知エラー:\n${err.message}`); })
      );
    } else if (event.cron === "0 0 * * *") {
      // 納品反映 → リネン発注案（反映後の在庫で計算するため順番に）
      ctx.waitUntil(
        runDeliveryCheck(env)
          .then(() => import("./linen.js"))
          .then(m => m.runLinenOrder(env))
          .then(r => console.log("linen order", JSON.stringify(r).slice(0, 300)))
          .catch(err => notifyOwner(`⚠️ リネン発注案エラー:\n${err.message}`))
      );
    } else if (event.cron === "0 22 * * *" || event.cron === "0 9 * * *") {
      ctx.waitUntil(import("./dash.js").then(m => m.warmDashboard(env, { sales: true })));
      const { runTimeTreeSync } = await import("./ttsync.js");
      ctx.waitUntil(runTimeTreeSync(env).then(r => console.log("timetree sync", JSON.stringify(r).slice(0, 500))));
    } else if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(import("./dash.js").then(m => m.warmDashboard(env)));
      ctx.waitUntil(import("./cleanlog.js").then(m => m.runLinenPrompts(env)).catch(e => console.error("linen prompt", e.message)));
      { // 清掃の時間帯（日本時間9〜16時）はリネン在庫を先読みしておく
        const h = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Tokyo" }));
        if (h >= 9 && h < 16) ctx.waitUntil(import("./liff.js").then(m => m.warmLinenStock(env)).catch(e => console.error("warm linen", e.message)));
      }
      ctx.waitUntil(import("./contractor.js").then(m => m.runContractorButtons(env)).then(r => { if (r.out?.length) console.log("contractor buttons", JSON.stringify(r)); }).catch(e => console.error("contractor buttons", e.message)));
      ctx.waitUntil(import("./linen.js").then(m => m.remindLinen(env)).catch(e => console.error("linen remind", e.message)));
      ctx.waitUntil(import("./jobs.js").then(m => m.runJobs(env)).then(r => { if (r.ran) console.log("jobs", JSON.stringify(r)); }).catch(e => console.error("jobs error", e.message)));
      ctx.waitUntil(
        pollGuestMessages(env)
          .then(r => { if (r.checked) console.log("メッセージ確認:", JSON.stringify(r)); })
          .catch(err => { console.error("メッセージ確認エラー:", err.message); })
      );
    }
  }
};
