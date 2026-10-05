// c46b: traced replica of bienvenue_page (steps-c45-core.cjs) to find where the step hangs (chains 47-49: no
// PASS/FAIL line after arrived_month_row). Every await is logged with a stage name, a watchdog prints the
// current stage every 10 s and the process exits by itself after 200 s so a hang never eats the run budget.
// run.sh <url> <query> probe-c46b-bienvenue.cjs
const lib = require("./c46b-lib.cjs");
const { chromium } = require("playwright");
const { URL, RESOLVER, sleep, pollUntil, OUT } = lib;
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
let stage = "start";
const t0 = Date.now();
const at = (s) => { stage = s; console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`); };
setInterval(() => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] watchdog: still at "${stage}"`), 10000).unref();
setTimeout(() => { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] WATCHDOG EXIT: hung at "${stage}"`); process.exit(3); }, 200000).unref();

function shareStub() {
  window.__ytmShare = null;
  Object.defineProperty(navigator, "share", { configurable: true, value: async (d) => { window.__ytmShare = d; } });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
}
function clipboardStub() {
  window.__ytmCopied = null;
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__ytmCopied = String(t); } } });
}
const wire = (p, tag) => {
  p.on("pageerror", (e) => console.log(tag, "PAGEERROR", String((e && e.message) || e).slice(0, 200)));
  p.on("console", (m) => { if (m.type() === "error") console.log(tag, "CONSOLE", m.text().slice(0, 200)); });
  p.on("dialog", (d) => { console.log(tag, "DIALOG", d.type(), d.message().slice(0, 100)); d.dismiss().catch(() => {}); });
  p.on("crash", () => console.log(tag, "PAGE CRASH"));
  p.on("close", () => console.log(tag, "page closed"));
};

(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=" + RESOLVER] });
  const base = new (require("url").URL)(URL).origin + "/";
  const phone = (extra = {}) => browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ...extra });
  try {
    // 1. desktop UA + share stub
    at("ctx1.new"); const ctx1 = await phone();
    at("ctx1.page"); const p1 = await ctx1.newPage(); wire(p1, "p1");
    at("ctx1.init"); await p1.addInitScript(shareStub);
    at("ctx1.goto"); const res = await p1.goto(URL + "/bienvenue", { waitUntil: "load", timeout: 45000 });
    console.log("p1 status", res && res.status());
    at("ctx1.h1"); await p1.locator("main h1").first().waitFor({ state: "visible", timeout: 20000 });
    at("ctx1.h1.text"); console.log("h1", (await p1.locator("main h1").first().innerText({ timeout: 10000 })).trim());
    at("ctx1.platform"); console.log("platform", await p1.locator('[data-testid="bienvenue-page"]').getAttribute("data-platform", { timeout: 10000 }));
    for (const tid of ["steps-ios", "steps-android"]) {
      at(`ctx1.${tid}.wait`); await p1.locator(`[data-testid="${tid}"]`).waitFor({ state: "visible", timeout: 15000 });
      at(`ctx1.${tid}.count`); const n = await p1.locator(`[data-testid="${tid}"] ol.steps > li`).count(); console.log(tid, "li", n);
      for (let i = 0; i < n; i++) { at(`ctx1.${tid}.box${i}`); const b = await p1.locator(`[data-testid="${tid}"] ol.steps > li`).nth(i).boundingBox({ timeout: 10000 }); console.log(tid, i, b && Math.round(b.height)); }
      at(`ctx1.${tid}.text`); console.log(tid, ((await p1.locator(`[data-testid="${tid}"]`).innerText({ timeout: 10000 })) || "").replace(/\s+/g, " ").slice(0, 120));
    }
    at("ctx1.qr.wait"); await p1.locator('svg[data-testid="bienvenue-qr"]').waitFor({ state: "visible", timeout: 15000 });
    at("ctx1.qr.attrs"); console.log("qr size", await p1.locator('svg[data-testid="bienvenue-qr"]').getAttribute("data-size", { timeout: 10000 }), "modules", await p1.locator('svg[data-testid="bienvenue-qr"] rect.module').count(), "label", await p1.locator('svg[data-testid="bienvenue-qr"]').getAttribute("aria-label", { timeout: 10000 }));
    at("ctx1.qr.box"); console.log("qr box", JSON.stringify(await p1.locator('svg[data-testid="bienvenue-qr"]').boundingBox({ timeout: 10000 })));
    at("ctx1.btn.wait"); const btn = p1.locator('[data-testid="bienvenue-share"]'); await btn.waitFor({ state: "visible", timeout: 10000 });
    at("ctx1.btn.box"); console.log("btn box", JSON.stringify(await btn.boundingBox({ timeout: 10000 })), "text", (await btn.innerText({ timeout: 10000 })).replace(/\s+/g, " ").trim());
    at("ctx1.btn.click"); await btn.click({ timeout: 8000 });
    at("ctx1.share.poll"); const shared = await pollUntil(() => Promise.race([p1.evaluate(() => window.__ytmShare), sleep(5000).then(() => "EVALUATE-TIMEOUT")]), 10000, 250);
    console.log("shared", JSON.stringify(shared));
    for (const tid of ["about-bienvenue", "account-bienvenue"]) {
      const path = tid === "about-bienvenue" ? "/about" : "/library/account";
      at(`ctx1.${tid}.goto`); await p1.goto(URL + path, { waitUntil: "load", timeout: 45000 });
      at(`ctx1.${tid}.wait`); await p1.locator(`[data-testid="${tid}"]`).waitFor({ state: "visible", timeout: 20000 });
      at(`ctx1.${tid}.attrs`); console.log(tid, await p1.locator(`[data-testid="${tid}"]`).getAttribute("href", { timeout: 10000 }), JSON.stringify(await p1.locator(`[data-testid="${tid}"]`).boundingBox({ timeout: 10000 })));
    }
    at("ctx1.shot"); await p1.screenshot({ path: OUT + "/c46b-bienvenue-p1.png" }).catch((e) => console.log("shot err", String(e).slice(0, 100)));
    at("ctx1.close"); await ctx1.close(); console.log("ctx1 closed");

    // 2. iPhone UA
    at("ctx2.new"); const ctx2 = await phone({ userAgent: IPHONE_UA });
    at("ctx2.page"); const p2 = await ctx2.newPage(); wire(p2, "p2");
    at("ctx2.init"); await p2.addInitScript(shareStub);
    at("ctx2.goto"); await p2.goto(URL + "/bienvenue", { waitUntil: "load", timeout: 45000 });
    at("ctx2.main.wait"); const main = p2.locator('[data-testid="bienvenue-page"]'); await main.waitFor({ state: "visible", timeout: 20000 });
    at("ctx2.platform.poll"); console.log("platform", await pollUntil(async () => { const v = await main.getAttribute("data-platform", { timeout: 5000 }); return v === "ios" ? v : null; }, 10000, 250), "/", await main.getAttribute("data-platform", { timeout: 5000 }));
    at("ctx2.android.count"); console.log("android steps before", await p2.locator('[data-testid="steps-android"]').count());
    at("ctx2.ios.wait"); await p2.locator('[data-testid="steps-ios"]').waitFor({ state: "visible", timeout: 15000 });
    at("ctx2.other.wait"); const other = p2.locator('[data-testid="bienvenue-other"]'); await other.waitFor({ state: "visible", timeout: 10000 });
    at("ctx2.other.box"); console.log("other box", JSON.stringify(await other.boundingBox({ timeout: 10000 })));
    at("ctx2.other.click"); await other.click({ timeout: 8000 });
    at("ctx2.android.wait"); await p2.locator('[data-testid="steps-android"]').waitFor({ state: "visible", timeout: 15000 });
    at("ctx2.android.li"); console.log("android li", await p2.locator('[data-testid="steps-android"] ol.steps > li').count());
    at("ctx2.close"); await ctx2.close(); console.log("ctx2 closed");

    // 3. clipboard fallback
    at("ctx3.new"); const ctx3 = await phone();
    at("ctx3.page"); const p3 = await ctx3.newPage(); wire(p3, "p3");
    at("ctx3.init"); await p3.addInitScript(clipboardStub);
    at("ctx3.goto"); await p3.goto(URL + "/bienvenue", { waitUntil: "load", timeout: 45000 });
    at("ctx3.btn.wait"); const btn3 = p3.locator('[data-testid="bienvenue-share"]'); await btn3.waitFor({ state: "visible", timeout: 20000 });
    at("ctx3.btn.click"); await btn3.click({ timeout: 8000 });
    at("ctx3.copied.poll"); console.log("copied", await pollUntil(() => Promise.race([p3.evaluate(() => window.__ytmCopied), sleep(5000).then(() => "EVALUATE-TIMEOUT")]), 10000, 250));
    at("ctx3.toast.poll"); console.log("toast", await pollUntil(async () => { const t = ((await p3.locator('[data-testid="alert-container"]').innerText({ timeout: 3000 }).catch(() => "")) || "").replace(/\s+/g, " "); return /Lien copié/.test(t) ? t.trim() : null; }, 8000, 250));
    at("ctx3.close"); await ctx3.close(); console.log("ctx3 closed");
    at("done");
  } catch (e) {
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ERROR at "${stage}":`, String((e && e.message) || e).split("\n")[0].slice(0, 300));
  } finally {
    at("browser.close");
    await Promise.race([browser.close(), sleep(15000).then(() => console.log("browser.close timed out"))]);
    at("exit");
    process.exit(0);
  }
})();
