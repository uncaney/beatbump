// probe-installability: ask Chromium itself why the PWA is (not) installable (CDP Page.getInstallabilityErrors).
const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "X-Ytm-Harness": "1" } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 200)); });
  for (const p of ["/", "/home"]) {
    await page.goto(URL + p, { waitUntil: "load", timeout: 60000 }).catch((e) => console.log("GOTO", p, String(e).slice(0, 120)));
    await sleep(6000);
    const client = await ctx.newCDPSession(page);
    const mf = await client.send("Page.getAppManifest").catch((e) => ({ error: String(e) }));
    console.log("PAGE", p, "manifest url:", mf.url, "errors:", JSON.stringify(mf.errors || mf.error || []).slice(0, 600));
    const inst = await client.send("Page.getInstallabilityErrors").catch((e) => ({ error: String(e) }));
    console.log("INSTALLABILITY", p, JSON.stringify(inst).slice(0, 900));
    const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? { scope: r.scope, active: !!r.active, waiting: !!r.waiting } : null; });
    console.log("SW", p, JSON.stringify(sw));
    await client.detach().catch(() => {});
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
