const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 45000 });
  await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 15000 });
  for (const t of [1500, 4000, 8000]) { await sleep(t === 1500 ? 1500 : 2500); console.log("t+" + t, JSON.stringify(await page.evaluate(() => ({ mini: document.querySelectorAll("[data-testid='mini-progress']").length, footer: !!document.querySelector("footer"), queueRows: document.querySelectorAll("[data-testid='queue-row']").length, title: (document.querySelector(".now-playing-title") || {}).textContent, playerClass: (document.querySelector(".player") || {}).className, inst: !!document.querySelector("[data-testid='install-hint']") })))); }
  await page.screenshot({ path: "/e2e/out/probe-miniprog.png" });
  await ctx.close(); await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
