// c46b-lib.cjs: runs one step module (steps-c42-core / c43-ux / c44-core / c44-offline) alone, with the same
// contract harness-core.cjs / harness-offline.cjs give it (step, pollUntil, sleep, media, loginAs, fixtures),
// and with the module's own C4x_SKIP entry for the step under diagnosis removed (the coordinator keeps the
// entry in the module; this wrapper bypasses it). Launched by run.sh through a thin probe-c46b-*.cjs:
//   require("./c46b-lib.cjs").main({ module: "./steps-c43-ux.cjs", skipSet: "C43_SKIP", unskip: ["ux_v12_open_fixes"], extraSkip: [] });
// The media helper handed over is harness-core's (window.__ytmMedia IS the element): the modules that hook
// their own contexts must not depend on it (chain 47, artist_of_day_stable).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith("--" + k + "=")); return a ? a.slice(k.length + 3) : d; };
const URL = String(arg("url", "https://staging-music.ekaii.fr")).replace(/\/$/, "");
const QUERY = arg("query", "daft punk");
const OUT = arg("out", "/e2e/out/c46b");
const RESOLVER = arg("resolver", "MAP *.ekaii.fr 127.0.0.1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, timeoutMs, everyMs = 1000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); }
  return last;
}
async function media(page) {
  return page.evaluate(() => {
    const el = window.__ytmMedia || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused } : null;
  });
}
const loginAs = async (p, name) => p.evaluate(async (n) => {
  const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
  try { sessionStorage.removeItem("ytm-whoami"); } catch {}
  return x.status;
}, name);
function loadFixtures() {
  for (const f of ["/e2e/fixtures.json", path.join(__dirname, "fixtures.json")]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ }
  }
  return {};
}

const steps = [];
let shotN = 0;
async function step(page, name, fn) {
  const t0 = Date.now();
  try {
    const detail = (await fn()) || "";
    const f = `${String(++shotN).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: path.join(OUT, f) }).catch(() => {});
    steps.push({ name, ok: true, detail: String(detail), durationMs: Date.now() - t0 });
    console.log("PASS", name, detail, `[${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    return true;
  } catch (e) {
    const full = String((e && e.message) || e);
    const msg = full.split("\n")[0];
    if (full.includes("\n")) console.log("FAIL-DETAIL", full.replace(/\s+/g, " ").slice(0, 700));
    const f = `${String(++shotN).padStart(2, "0")}-FAIL_${name}.png`;
    await page.screenshot({ path: path.join(OUT, f) }).catch(() => {});
    steps.push({ name, ok: false, detail: msg, durationMs: Date.now() - t0 });
    console.log("FAIL", name, "-", msg, `[${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    return false;
  }
}

async function main(spec) {
  fs.mkdirSync(OUT, { recursive: true });
  const mod = require(spec.module);
  const skipSet = mod[spec.skipSet];
  for (const n of spec.unskip || []) if (skipSet && skipSet.delete) { skipSet.delete(n); console.log("c46b: unskipped", n); }
  for (const n of spec.extraSkip || []) if (skipSet && skipSet.add) { skipSet.add(n); console.log("c46b: skipped", n); }
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=" + RESOLVER, "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", String((e && e.message) || e).slice(0, 200)));
  try {
    await page.goto(URL + "/home", { waitUntil: "load", timeout: 60000 });
    await mod.run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: loadFixtures() });
  } catch (e) {
    console.log("FATAL", String((e && e.stack) || e).slice(0, 600));
  } finally {
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ url: URL, module: spec.module, steps }, null, 2));
    console.log(`c46b report: ${steps.filter((s) => s.ok).length} passed / ${steps.filter((s) => !s.ok).length} failed -> ${OUT}/report.json`);
    await browser.close().catch(() => {});
  }
}

module.exports = { main, step, pollUntil, sleep, media, loginAs, loadFixtures, URL, QUERY, OUT, RESOLVER };
