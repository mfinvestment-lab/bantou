// デジタル番頭 v2 — HARU（清掃用）と SORA（管理用）の2チャネルを1つのWorkerで扱う
import { haru, sora, handleWebhook, sourceIdOf } from "./line.js";
import { runCleaningNotification, collectFacilityInfo } from "./cleaning.js";
import { handleInventoryMessage, runDeliveryCheck } from "./inventory.js";
import { handleSoraEvent } from "./sora.js";
import { pollGuestMessages } from "./approval.js";

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
        if (event.type !== "message" || event.message.type !== "text") return;
        const text = event.message.text.trim();
        if (text === "グループID教えて") {
          const sourceType = event.source.groupId ? "グループ" : event.source.roomId ? "ルーム" : "個人";
          await haru(env).reply(event.replyToken, `${sourceType}ID：\n${sourceIdOf(event)}`);
          return;
        }
        await handleInventoryMessage(env, text, event.replyToken, event.source.userId);
      });
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
