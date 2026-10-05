// Probe: reproduce the intermittent MediaError (PIPELINE_ERROR_READ) on the first play.
// Fresh context each round: search → click first Song row → watch media element + audio responses.
const { chromium } = require("playwright");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const URL = args.url || "https://staging-music.ekaii.fr";
const QUERY = args.query || "daft punk";
const ROUNDS = Number(args.rounds || 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  let fails = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const net = [];
    await page.addInitScript(() => {
      window.__m = { events: [] };
      const p = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!this.__hooked) {
          this.__hooked = true; window.__m.el = this;
          for (const ev of ["error", "loadstart", "loadedmetadata", "canplay", "playing", "stalled", "abort", "emptied"]) {
            this.addEventListener(ev, () => window.__m.events.push(ev + "@" + Date.now() % 100000 + (ev === "error" && this.error ? ":" + this.error.code + ":" + (this.error.message || "").slice(0, 80) : "") + " src=" + (this.currentSrc || this.src || "").slice(0, 60)));
          }
        }
        window.__m.events.push("play() src=" + (this.currentSrc || this.src || "").slice(0, 60));
        return p.apply(this, arguments);
      };
    });
    page.on("response", (r) => { const u = r.url(); if (/\/localf|\/vp\?|\/aud\//.test(u)) net.push(`${r.status()} ${r.fromServiceWorker() ? "SW" : "net"} ${(r.headers()["content-range"] || "").slice(0, 30)} ${(r.headers()["content-type"] || "").slice(0, 20)} ${u.slice(u.indexOf("/", 9), 90)}`); });
    page.on("requestfailed", (r) => { const u = r.url(); if (/\/localf|\/vp\?|\/aud\//.test(u)) net.push(`FAILED ${r.failure() && r.failure().errorText} ${u.slice(u.indexOf("/", 9), 90)}`); });
    const consoleErrs = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text().slice(0, 140)); });
    try {
      await page.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "networkidle", timeout: 60000 });
      const row = page.getByText(/Song\s*•/).first();
      const title = (await row.locator("xpath=..").innerText().catch(() => "")).split("\n")[0];
      await row.click({ timeout: 8000 });
      let st = null;
      for (let i = 0; i < 40; i++) { await sleep(500); st = await page.evaluate(() => { const el = window.__m.el; return { t: el ? el.currentTime : -1, err: el && el.error ? el.error.code + ":" + el.error.message : null, rs: el ? el.readyState : -1, ns: el ? el.networkState : -1, ev: window.__m.events.length }; }); if (st.t > 1 || st.err) break; }
      const events = await page.evaluate(() => window.__m.events);
      const ok = st && st.t > 1 && !st.err;
      if (!ok) fails++;
      console.log(`ROUND ${round} ${ok ? "OK" : "FAIL"} title=${JSON.stringify(title)} state=${JSON.stringify(st)}`);
      if (!ok) { console.log("  events:", events.join(" | ")); console.log("  net:", net.join("\n       ")); console.log("  console:", consoleErrs.join(" | ")); }
    } catch (e) { fails++; console.log(`ROUND ${round} EXC ${String(e).slice(0, 200)}`); console.log("  net:", net.join("\n       ")); }
    await ctx.close();
  }
  console.log(`SUMMARY fails=${fails}/${ROUNDS}`);
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
