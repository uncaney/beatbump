// probe-keep-c41: fresh context, keep the fixture album on /release, log the button states, console
// errors, page errors and failed requests for 25 s. Read-only on the server side.
const { chromium } = require("playwright");
const FIX = require("/e2e/fixtures.json");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e && e.stack || e).slice(0, 400)));
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) console.log("CONSOLE", m.type(), m.text().slice(0, 300)); });
  page.on("requestfailed", (r) => console.log("REQFAIL", r.method(), r.url().slice(0, 160), r.failure() && r.failure().errorText));
  page.on("response", (r) => { const u = r.url(); if (r.status() >= 400 || /cache-audio|\/aud\/|local\/albums|offline|keep/.test(u)) console.log("RESP", r.status(), u.slice(0, 160)); });
  const albumId = FIX.localAlbumId;
  await page.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);
  console.log("SWCTL", await page.evaluate(() => !!navigator.serviceWorker.controller));
  const keep = page.locator('[data-testid="keep-offline"]').first();
  await keep.waitFor({ state: "visible", timeout: 20000 });
  const attrs = async () => page.evaluate(() => { const b = document.querySelector('[data-testid="keep-offline"]'); if (!b) return "no-btn"; const o = {}; for (const a of b.attributes) if (a.name.startsWith("data-")) o[a.name] = a.value; o.text = b.innerText; return JSON.stringify(o); });
  console.log("T0", await attrs());
  console.log("TRACKS_ON_PAGE", await page.evaluate(() => document.querySelectorAll('[data-testid="listing"], .listing, [data-lid]').length), (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300));
  await keep.click({ timeout: 5000 });
  for (let i = 1; i <= 50; i++) {
    await sleep(500);
    const a = await attrs();
    if (i % 2 === 0 || i < 8) console.log("T" + (i * 0.5).toFixed(1), a);
  }
  console.log("LS", await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((k) => /offline|keep|pin/i.test(k)).map((k) => [k, (localStorage.getItem(k) || "").slice(0, 300)])))));
  const sw = await page.evaluate(async () => { try { const r = await fetch("/__ytm_offline_list__"); return (await r.text()).slice(0, 400); } catch (e) { return "swlist-err " + e; } });
  console.log("SWLIST", sw);
  await page.screenshot({ path: "/e2e/out/probe-keep-c41.png" }).catch(() => {});
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
