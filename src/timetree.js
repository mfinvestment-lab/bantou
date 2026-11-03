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
    page.on("response", async res => {
      try {
        const req = res.request();
        const type = req.resourceType();
        const url = res.url();
        if (!["xhr", "fetch"].includes(type)) return;
        if (!/timetree/i.test(url) || /google|_rsc=/.test(url)) return;
        const ct = res.headers()["content-type"] || "";
        let sample = null;
        if (/json/.test(ct)) sample = (await res.text()).slice(0, 400);
        apiCalls.push({ method: req.method(), url, status: res.status(), sample });
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
    return { ok: true, log, url: page.url(), inputs, calendarLinks: links, apiCalls: apiCalls.slice(0, 60), pageText: text };
  }).catch(e => ({ ok: false, error: e.message, log, apiCalls: apiCalls.slice(0, 60) }));
}
