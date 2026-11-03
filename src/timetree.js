// TimeTree 同期（機能1）。公開APIが無いため Cloudflare Browser Rendering で Web版を操作する。
// 段階1: ログインして Cookie を KV に保存し、Web版が内部で叩いている API を観察する（/admin/timetree-check）
import puppeteer from "@cloudflare/puppeteer";

const SIGNIN_URL = "https://timetreeapp.com/signin";
const COOKIE_KEY = "timetree:cookies";
const COOKIE_TTL = 60 * 60 * 24 * 14;

async function withBrowser(env, fn) {
  if (!env.BROWSER) throw new Error("Browser Rendering の binding（BROWSER）が未設定です");
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function restoreCookies(env, page) {
  const saved = await env.KV.get(COOKIE_KEY, "json");
  if (saved?.length) { await page.setCookie(...saved); return true; }
  return false;
}
async function saveCookies(env, page) {
  const cookies = await page.cookies();
  await env.KV.put(COOKIE_KEY, JSON.stringify(cookies), { expirationTtl: COOKIE_TTL });
  return cookies.length;
}

// ログイン画面の入力欄を広めに探す（TimeTree側の画面変更に少し耐える）
async function fillFirst(page, selectors, value) {
  for (const s of selectors) {
    const el = await page.$(s);
    if (el) { await el.click({ clickCount: 3 }); await el.type(value, { delay: 20 }); return s; }
  }
  throw new Error(`入力欄が見つかりません: ${selectors.join(" | ")}`);
}

async function login(env, page, log) {
  if (!env.TIMETREE_EMAIL || !env.TIMETREE_PASSWORD) throw new Error("TIMETREE_EMAIL / TIMETREE_PASSWORD が未設定です");
  if (!(await page.$('input[type="password"]'))) await page.goto(SIGNIN_URL, { waitUntil: "networkidle2", timeout: 45000 });
  log.push({ step: "signin page", url: page.url() });
  await fillFirst(page, ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="username"]', 'input[type="text"]'], env.TIMETREE_EMAIL);
  await fillFirst(page, ['input[type="password"]', 'input[name="password"]'], env.TIMETREE_PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => null),
    page.keyboard.press("Enter")
  ]);
  log.push({ step: "after submit", url: page.url() });
  if (/signin|login/.test(page.url())) {
    const text = (await page.evaluate(() => document.body.innerText)).slice(0, 500);
    throw new Error(`ログインできませんでした（URL: ${page.url()}）: ${text}`);
  }
  log.push({ step: "cookies saved", count: await saveCookies(env, page) });
}

/**
 * 診断: ログイン → カレンダー画面を開き、Web版が呼んでいる API（XHR/fetch）の一覧と画面テキストを返す。
 * これを見て、UI操作ではなく内部APIを直接叩く実装に切り替える判断をする。
 */
export async function timetreeCheck(env, { fresh = false } = {}) {
  const log = [];
  const apiCalls = [];
  return withBrowser(env, async page => {
    let apiHeaders = null;
    page.on("response", async res => {
      try {
        const req = res.request();
        const type = req.resourceType();
        const url = res.url();
        if (!["xhr", "fetch"].includes(type)) return;
        if (!/timetreeapp\.com\/api\//i.test(url)) return;
        const ct = res.headers()["content-type"] || "";
        let sample = null;
        if (/json/.test(ct)) sample = (await res.text()).slice(0, 400);
        const h = req.headers();
        const reqHeaders = Object.fromEntries(Object.entries(h).filter(([k]) => !/^(cookie|content-length|host|user-agent|referer|origin|sec-|accept-encoding)/i.test(k)));
        if (!apiHeaders && /\/api\/v[12]\/calendars?\b/.test(url) && req.method() === "GET") apiHeaders = reqHeaders;
        apiCalls.push({ method: req.method(), url, status: res.status(), reqHeaders, postData: (req.postData() || "").slice(0, 600), sample });
      } catch {}
    });

    const restored = !fresh && (await restoreCookies(env, page));
    // ログイン済みなら /signin はカレンダー画面へリダイレクトされる想定
    await page.goto(SIGNIN_URL, { waitUntil: "networkidle2", timeout: 45000 });
    log.push({ step: "open signin", url: page.url(), restoredCookies: restored });
    const hasPasswordField = !!(await page.$('input[type="password"]'));
    if (hasPasswordField) {
      await login(env, page, log);
    } else {
      log.push({ step: "already logged in (no password field)" });
    }
    await new Promise(r => setTimeout(r, 3000));
    const text = (await page.evaluate(() => document.body.innerText)).slice(0, 2000);
    const inputs = await page.evaluate(() => Array.from(document.querySelectorAll("input,button")).map(e => `${e.tagName.toLowerCase()}[type=${e.type}][name=${e.name}][text=${(e.innerText || e.placeholder || "").slice(0, 30)}]`).slice(0, 30));
    const links = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map(a => a.getAttribute("href")).filter(h => /calendar/i.test(h)).slice(0, 30));
    if (apiHeaders) await env.KV.put("timetree:headers", JSON.stringify(apiHeaders), { expirationTtl: COOKIE_TTL });
    return { ok: true, log, url: page.url(), apiHeaders, inputs, calendarLinks: links, apiCalls: apiCalls.slice(0, 80), pageText: text };
  }).catch(e => ({ ok: false, error: e.message, log, apiCalls: apiCalls.slice(0, 60) }));
}

// ---- 段階2: ブラウザを使わず、保存した Cookie で内部APIを直接呼ぶ ----
export async function ttApi(env, path, { method = "GET", body } = {}) {
  const cookies = (await env.KV.get(COOKIE_KEY, "json")) || [];
  if (!cookies.length) throw new Error("TimeTreeのCookieがありません。/admin/timetree-check を先に実行してください");
  const headers = (await env.KV.get("timetree:headers", "json")) || {};
  const res = await fetch(`https://timetreeapp.com${path}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...headers,
      cookie: cookies.map(c => `${c.name}=${c.value}`).join("; "),
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      origin: "https://timetreeapp.com",
      referer: "https://timetreeapp.com/calendars"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }
  return { status: res.status, data };
}

// ---- 診断: Web版のJSから events 関連のAPIパスとHTTPメソッドを探す ----
export async function timetreeFindApi(env) {
  const cookies = (await env.KV.get(COOKIE_KEY, "json")) || [];
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  const html = await (await fetch("https://timetreeapp.com/calendars", { headers: { cookie, "user-agent": ua } })).text();
  const scripts = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(m => m[1]).map(u => u.startsWith("http") ? u : `https://timetreeapp.com${u}`))];
  const hits = [];
  const scanned = [];
  for (const src of scripts.slice(0, 40)) {
    const js = await (await fetch(src, { headers: { "user-agent": ua } })).text();
    scanned.push({ src, size: js.length });
    // 追加で読み込まれる chunk も拾う
    for (const m of js.matchAll(/["']([^"']*\/api\/v\d\/[^"'`]*)["'`]/g)) {
      const path = m[1];
      if (!/calendar/.test(path)) continue;
      const i = m.index; hits.push({ src: src.split("/").pop(), path, ctx: js.slice(Math.max(0, i - 160), i + 120) });
    }
    for (const m of js.matchAll(/`([^`]*\/api\/v\d\/[^`]*)`/g)) {
      const path = m[1];
      if (!/calendar.*event/.test(path)) continue;
      const i = m.index; hits.push({ src: src.split("/").pop(), path, ctx: js.slice(Math.max(0, i - 160), i + 120) });
    }
  }
  // chunk ファイルも探す（assets 配下の .js 名）
  const chunkNames = new Set();
  for (const src of scripts.slice(0, 5)) {
    const js = await (await fetch(src, { headers: { "user-agent": ua } })).text();
    for (const m of js.matchAll(/["']([\w\-./]+\.js)["']/g)) if (/assets/.test(m[1]) || /^[\w-]+-[\w]{8}\.js$/.test(m[1])) chunkNames.add(m[1]);
  }
  const eventHits = hits.filter(h => /event/.test(h.path) || /event/i.test(h.ctx));
  return { scripts: scanned, chunkNames: [...chunkNames].slice(0, 50), eventHits: eventHits.slice(0, 40), otherCalendarPaths: [...new Set(hits.map(h => h.path))].slice(0, 60) };
}
