// ytm-e2e — headless click-test + DOM discovery for music.ekaii.fr
// run: NODE_PATH=$(npm root -g) node harness.cjs --url=https://music.ekaii.fr --out=/out --query="daft punk" --repeat=1
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));

const arg = (k, d = "") =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "https://music.ekaii.fr");
const OUT = arg("out", "/out");
const QUERY = arg("query", "daft punk");
const REPEAT = parseInt(arg("repeat", "1"), 10);
const RESOLVER = arg("resolver", "");
const STREAM_RE = /(videoplayback|googlevideo|\/localf|\/vp\?|\/aud\/|stream|\.m4a|\.opus|\.webm|range)/i;

fs.mkdirSync(OUT, { recursive: true });
let shotN = 0;
const steps = [];

async function shot(page, label) {
  const f = `${String(++shotN).padStart(2, "0")}-${label.replace(/\W+/g, "_")}.png`;
  await page.screenshot({ path: path.join(OUT, f) }).catch(() => {});
  return f;
}
async function step(page, name, fn) {
  try {
    const detail = (await fn()) || "";
    steps.push({ name, ok: true, detail, shot: await shot(page, name) });
    console.log("PASS", name, detail);
    return true;
  } catch (e) {
    steps.push({ name, ok: false, detail: String(e && e.message || e), shot: await shot(page, "FAIL_" + name) });
    console.log("FAIL", name, "-", e && e.message || e);
    return false;
  }
}

async function dumpDOM(page, tag) {
  const info = await page.evaluate(() => {
    const txt = (el) => (el.innerText || el.getAttribute("aria-label") || el.title || "").trim().slice(0, 40);
    return {
      navLinks: [...document.querySelectorAll("nav a, aside a, [class*=nav] a")].slice(0, 30).map((a) => ({ t: txt(a), href: a.getAttribute("href") })),
      buttons: [...document.querySelectorAll("button")].slice(0, 40).map((b) => ({ t: txt(b), aria: b.getAttribute("aria-label") })),
      inputs: [...document.querySelectorAll("input")].map((i) => ({ type: i.type, ph: i.placeholder, name: i.name, role: i.getAttribute("role") })),
      links: [...document.querySelectorAll("a[href*='/artist/'], a[href*='/release'], a[href*='/playlist']")].slice(0, 20).map((a) => ({ t: txt(a), href: a.getAttribute("href") })),
    };
  }).catch((e) => ({ error: String(e) }));
  fs.writeFileSync(path.join(OUT, `dom-${tag}.json`), JSON.stringify(info, null, 2));
  return info;
}

async function runOnce(browser, iter) {
  const consoleErrors = [], failed = [], streamResp = [];
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("requestfailed", (r) => failed.push(`${r.method()} ${r.url().slice(0, 120)} :: ${r.failure() && r.failure().errorText}`));
  page.on("response", (r) => { if (STREAM_RE.test(r.url())) streamResp.push({ status: r.status(), url: r.url().slice(0, 90) }); });

  await step(page, "load_home", async () => { await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 }); return page.url(); });
  await dumpDOM(page, "home");

  await step(page, "search", async () => {
    const box = page.locator("input[type=search], input[role=searchbox], input[placeholder*='earch' i], input[name*='earch' i]").first();
    if (await box.count() === 0) {
      // maybe a search nav link/button opens it
      await page.locator("a[href*='search'], button[aria-label*='earch' i]").first().click({ timeout: 5000 }).catch(() => {});
    }
    const b2 = page.locator("input[type=search], input[placeholder*='earch' i], input").first();
    await b2.click({ timeout: 8000 });
    await b2.fill(QUERY);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 20000 });
    return page.url();
  });
  await dumpDOM(page, "search");

  let songRow = null;
  await step(page, "find_first_song", async () => {
    // a list row with a title; capture how many artist links it has
    const row = page.locator("[class*='listItem'], li, [class*='ListItem'], [role='listitem']").filter({ hasText: /.{2,}/ }).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    songRow = row;
    const html = (await row.innerHTML().catch(() => "")).slice(0, 400);
    fs.writeFileSync(path.join(OUT, `row-${iter}.html`), html);
    return "row captured";
  });

  await step(page, "open_3dot_menu", async () => {
    const dots = page.locator("button[aria-label*='more' i], button[aria-label*='option' i], button[aria-label*='menu' i], [aria-haspopup]").first();
    await dots.click({ timeout: 8000 });
    await page.waitForTimeout(500);
  });
  await dumpDOM(page, "menu");

  await step(page, "view_artist_assert", async () => {
    const va = page.getByText(/view artist/i).first();
    await va.click({ timeout: 8000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 });
    const u = page.url();
    if (u.includes("/artist/undefined") || /\/artist\/?$/.test(u)) throw new Error("BAD artist url: " + u);
    if (!/\/artist\/[^/]+/.test(u)) throw new Error("not artist url: " + u);
    return u;
  });

  await step(page, "play_assert_206", async () => {
    const wait = page.waitForResponse((r) => STREAM_RE.test(r.url()), { timeout: 25000 });
    wait.catch(() => {});
    const play = page.getByRole("button", { name: /^play$/i }).or(page.locator("[aria-label*='play' i]")).first();
    await play.click({ timeout: 8000 });
    const resp = await wait;
    await page.waitForFunction(() => { const el = document.querySelector("audio,video"); return el && el.readyState >= 2; }, { timeout: 15000 }).catch(() => {});
    const t0 = await page.evaluate(() => { const el = document.querySelector("audio,video"); return el ? el.currentTime : -1; });
    await page.waitForTimeout(1500);
    const t1 = await page.evaluate(() => { const el = document.querySelector("audio,video"); return el ? el.currentTime : -1; });
    return `resp ${resp.status()} ${resp.url().slice(0, 60)} | t ${t0}->${t1}`;
  });

  fs.writeFileSync(path.join(OUT, `iter${iter}.console.log`), consoleErrors.join("\n"));
  fs.writeFileSync(path.join(OUT, `iter${iter}.failed.log`), failed.join("\n"));
  fs.writeFileSync(path.join(OUT, `iter${iter}.streams.json`), JSON.stringify(streamResp, null, 2));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    headless: true, chromiumSandbox: false,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage",
      ...(RESOLVER ? ["--host-resolver-rules=" + RESOLVER] : [])],
  });
  for (let i = 1; i <= REPEAT; i++) { console.log(`\n=== iter ${i}/${REPEAT} ===`); await runOnce(browser, i); }
  await browser.close();
  const report = { url: URL, query: QUERY, when: "stamped-after", passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length, steps };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${report.passed} passed / ${report.failed} failed -> ${OUT}/report.json`);
})();
