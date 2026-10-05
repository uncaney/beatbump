const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push("console: " + m.text().slice(0, 160)); });
  await page.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
  await sleep(2000);
  const st = await page.evaluate(async () => { const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "probe-remote-" + Date.now().toString(36) }) }); return x.status + " " + (await x.text()).slice(0, 80); });
  console.log("LOGIN", st);
  await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 45000 });
  await sleep(3000);
  console.log("SONGS", await page.getByText(/Song\s*•/).count());
  await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
  for (let i = 1; i <= 8; i++) { await sleep(4000); const m = await page.evaluate(() => { const a = window.__ytmMedia || document.querySelector("audio,video"); return a ? { src: (a.currentSrc || a.src || "").slice(0, 70), t: a.currentTime, paused: a.paused, rs: a.readyState, err: a.error && a.error.code } : null; }); console.log("T+" + (i * 4), JSON.stringify(m)); }
  console.log("TITLE", ((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim().slice(0, 40));
  console.log("ERRS", JSON.stringify(errs.slice(0, 5)));
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
