// probe-weekend-pack: Android-like context, open /home, tap "Préparer 2 h" (or go straight to the link), capture
// page errors, console errors, body text and a screenshot. Read-only on the server except the pack it starts.
const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    extraHTTPHeaders: { "X-Ytm-Harness": "1" } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e && e.stack || e).slice(0, 700)));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 300)); });
  for (const [label, url] of [["direct", "/library/downloads-offline?pack=dur:7200"], ["home-then-link", "/home"]]) {
    await page.goto(URL + url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("GOTO", label, String(e).slice(0, 120)));
    await sleep(2500);
    if (label === "home-then-link") {
      const a = page.locator('a:has-text("Préparer 2 h")').first();
      const n = await a.count();
      console.log("WEEKEND_LINK_COUNT", n, n ? await a.getAttribute("href") : "");
      if (n) { await a.click({ timeout: 5000 }).catch((e) => console.log("CLICK", String(e).slice(0, 120))); await sleep(4000); }
    }
    const info = await page.evaluate(() => ({ url: location.href, bodyLen: (document.body && document.body.innerText || "").length, text: (document.body && document.body.innerText || "").replace(/\s+/g, " ").slice(0, 260), bg: getComputedStyle(document.body).backgroundColor, mainChildren: document.querySelector("main") ? document.querySelector("main").children.length : -1, progress: Array.from(document.querySelectorAll("[data-testid=pack-progress]")).map((p) => p.getAttribute("data-state")) }));
    console.log("STATE", label, JSON.stringify(info));
    await page.screenshot({ path: "/e2e/out/probe-weekend-" + label + ".png" }).catch(() => {});
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
