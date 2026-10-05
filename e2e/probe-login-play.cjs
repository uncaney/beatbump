const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const media = (p) => p.evaluate(() => { const a = window.__ytmMedia || document.querySelector("audio,video"); return a ? { src: (a.currentSrc || a.src || "").slice(0, 60), t: a.currentTime, paused: a.paused } : null; });
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  for (const login of [false, true]) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
    await page.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
    await sleep(2000);
    if (login) await page.evaluate(async () => fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "probe-lp-" + Date.now().toString(36) }) }));
    await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 45000 });
    await sleep(3000);
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
    const samples = [];
    for (let i = 1; i <= 5; i++) { await sleep(4000); samples.push(await media(page)); }
    const title = ((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim().slice(0, 30);
    const state = await page.evaluate(() => { try { return { rs: localStorage.getItem("resumeState") ? "yes" : "no", lt: !!localStorage.getItem("lastTrack"), rem: localStorage.getItem("Remember Last Track") }; } catch { return null; } });
    console.log(`LOGIN=${login}`, "title=" + JSON.stringify(title), "media=" + JSON.stringify(samples.map((m) => m ? Math.round(m.t) : null)), "last=" + JSON.stringify(samples[4]), "state=" + JSON.stringify(state), "errs=" + JSON.stringify(errs.slice(0, 2)));
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
