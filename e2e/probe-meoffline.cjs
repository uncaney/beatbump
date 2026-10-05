const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 140)); });
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 140)));
  await page.goto(URL + "/home", { waitUntil: "networkidle", timeout: 45000 });
  await sleep(2000); // let the SW install
  console.log("SW", await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())));
  await ctx.setOffline(true);
  const r = await page.goto(URL + "/library/recent", { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => { console.log("GOTO", e.message.slice(0, 100)); return null; });
  console.log("STATUS", r && r.status(), page.url());
  await page.evaluate(() => window.dispatchEvent(new Event("offline"))).catch(() => {});
  await sleep(5000);
  console.log("ME_OFFLINE", await page.locator('[data-testid="me-offline"]').count(), "ONLINE", await page.evaluate(() => navigator.onLine));
  console.log("BODY", (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300));
  await page.screenshot({ path: "/e2e/out/probe-meoffline.png" }).catch(() => {});
  await ctx.setOffline(false);
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
