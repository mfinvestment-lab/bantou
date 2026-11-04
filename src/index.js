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
        if (event.type === "postback") { await handleCleaningPostback(env, event); return; }
        if (event.type !== "message" || event.message.type !== "text") return;
        const text = event.message.text.trim();
        if (text === "グループID教えて") {
          const sourceType = event.source.groupId ? "グループ" : event.source.roomId ? "ルーム" : "個人";
          await haru(env).reply(event.replyToken, `${sourceType}ID：\n${sourceIdOf(event)}`);
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
        if (path === "/admin/dash-today") { const { todayData } = await import("./dash.js"); return json(await todayData(env)); }
        if (path === "/admin/dash-sales") { const { salesData } = await import("./dash.js"); return json(await salesData(env)); }
        if (path === "/admin/cleaning-status") return json(await todayCleaningStatus(env, url.searchParams.get("d") || undefined));
        if (path === "/admin/delivery-run") return json(await runDeliveryCheck(env));
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
      ctx.waitUntil(
        runCleaningNotification(env)
          .then(r => console.log("清掃通知 完了:", JSON.stringify(r)))
          .catch(err => { console.error("清掃通知エラー:", err.message, err.stack); return notifyOwner(`⚠️ 清掃通知エラー:\n${err.message}`); })
      );
    } else if (event.cron === "0 0 * * *") {
      ctx.waitUntil(runDeliveryCheck(env));
    } else if (event.cron === "0 22 * * *" || event.cron === "0 9 * * *") {
      const { runTimeTreeSync } = await import("./ttsync.js");
      ctx.waitUntil(runTimeTreeSync(env).then(r => console.log("timetree sync", JSON.stringify(r).slice(0, 500))));
    } else if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(
        pollGuestMessages(env)
          .then(r => { if (r.checked) console.log("メッセージ確認:", JSON.stringify(r)); })
          .catch(err => { console.error("メッセージ確認エラー:", err.message); })
      );
    }
  }
};
