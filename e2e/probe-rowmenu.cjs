const { chromium } = require("playwright");
const URL = "https://music.ekaii.fr";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL + "/search/" + encodeURIComponent("daft punk") + "?filter=all", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByText(/Song\s*•/).first().click(); await sleep(3000);
  const wrappers = page.locator("main [aria-label=\"Plus d'options\"]");
  console.log("wrappers", await wrappers.count());
  await wrappers.nth(1).click({ timeout: 5000 });
  await sleep(900);
  const items = await page.evaluate(() => [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.offsetParent !== null && /Lire ensuite|Ajouter à la file|Add to|Play Next|favoris|Favorite/i.test(e.textContent || "")).map((e) => e.tagName + ":" + (e.textContent || "").trim().slice(0, 30)).slice(0, 10));
  console.log("MENU_ITEMS", JSON.stringify(items));
  await page.screenshot({ path: "/e2e/out/probe-rowmenu.png" });
  const add = page.getByText(/Ajouter à la file/i).first();
  const before = await page.evaluate(() => (window.localStorage.getItem("x"), 0));
  if (await add.count()) { await add.click({ timeout: 4000 }); await sleep(800); console.log("clicked add"); }
  const toasts = await page.locator(".alert").allInnerTexts().catch(() => []);
  console.log("TOASTS", JSON.stringify(toasts));
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
