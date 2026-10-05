const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  for (const opts of [{}, { serviceWorkers: "block" }]) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, ...opts });
    const page = await ctx.newPage();
    for (const path of ["/home", "/listen?id=fa5IWHDbftI&t=30"]) {
      const t0 = Date.now();
      const r = await page.goto(URL + path, { waitUntil: "domcontentloaded", timeout: 25000 }).then((r) => "status " + (r && r.status())).catch((e) => "ERR " + String(e.message).slice(0, 50));
      console.log(JSON.stringify(opts), path, r, Date.now() - t0, "ms");
    }
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
