// probe-tdz: capture page error stacks on the home, a release page and the offline page (staging).
const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const seen = new Map();
  page.on("pageerror", (e) => { const k = String(e && e.message || e).slice(0, 120); const n = (seen.get(k) || 0) + 1; seen.set(k, n); if (n <= 2) console.log("PAGEERROR", String(e && e.stack || e).slice(0, 900)); });
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 200)); });
  for (const p of ["/", "/library/downloads-offline", "/library/stats"]) {
    await page.goto(URL + p, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("GOTO", p, String(e).slice(0, 120)));
    await sleep(6000);
    console.log("PAGE", p, "errors so far", [...seen.entries()].map(([k, n]) => n + "x " + k).join(" | ").slice(0, 400));
    console.log("BODY", p, (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200));
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
