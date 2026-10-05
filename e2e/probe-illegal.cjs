const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push({ msg: String(e.message || e).slice(0, 80), stack: String(e.stack || "").split("\n").slice(0, 4).join(" | ").slice(0, 400), at: Date.now() }));
  await page.addInitScript(() => { window.addEventListener("unhandledrejection", (ev) => { try { console.error("UNHANDLED", String(ev.reason && (ev.reason.stack || ev.reason)).slice(0, 300)); } catch {} }); });
  page.on("console", (m) => { if (m.type() === "error" && /UNHANDLED|Illegal/.test(m.text())) errs.push({ msg: "console: " + m.text().slice(0, 300) }); });
  const t0 = Date.now();
  await page.goto(URL + "/home", { waitUntil: "load", timeout: 60000 });
  await sleep(8000);
  console.log("after home", errs.length);
  await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 60000 });
  await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 15000 }).catch(() => {});
  await sleep(15000);
  console.log("after play", errs.length);
  const seen = new Map(); for (const e of errs) { const k = (e.msg + "|" + (e.stack || "")).slice(0, 300); seen.set(k, (seen.get(k) || 0) + 1); }
  for (const [k, n] of seen) console.log(n + "x", k);
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
