const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (let a = 0; a < 3; a++) { if (await page.goto(URL + "/home", { waitUntil: "domcontentloaded", timeout: 60000 }).then(() => true).catch(() => false)) break; }
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid^='row-'], section[data-row], [data-testid='album-of-day']"));
    return rows.map((r) => ({ id: r.getAttribute("data-testid") || r.getAttribute("data-row"), folded: r.getAttribute("data-folded"), albums: Array.from(r.querySelectorAll("a[href*='/release?id=']")).map((a) => a.getAttribute("href").replace("/release?id=", "")).slice(0, 25) }));
  });
  const seen = {}; for (const r of info) for (const id of new Set(r.albums)) { (seen[id] = seen[id] || []).push(r.id); }
  const dups = Object.entries(seen).filter(([, rs]) => rs.length > 1);
  console.log("rows:", info.map((r) => `${r.id}${r.folded ? "(folded)" : ""}:${r.albums.length}`).join(" "));
  console.log("dups:", JSON.stringify(dups.slice(0, 6)));
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
