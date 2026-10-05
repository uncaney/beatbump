const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 120)); });
  await page.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
  await sleep(4000);
  console.log("HOME rows recemment-acquis:", await page.locator('[data-row="recemment-acquis"]').count(), "main:", await page.locator("main").count(), "footer:", await page.locator("footer").count());
  await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 45000 });
  await sleep(4000);
  console.log("SEARCH songs:", await page.getByText(/Song\s*•/).count(), "h1:", JSON.stringify(await page.locator("h1").allInnerTexts()));
  try { await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 3000 }); console.log("CLICK ok"); }
  catch (e) { console.log("CLICK_ERR", e.message.replace(/\s+/g, " ").slice(0, 300)); }
  const top = await page.evaluate(() => { const el = document.elementFromPoint(640, 450); return el ? el.tagName + "." + (el.className || "").toString().slice(0, 60) + " id=" + el.id : null; });
  console.log("ELEMENT_AT_CENTER", top);
  await page.screenshot({ path: "/e2e/out/probe-overlay.png" }).catch(() => {});
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
