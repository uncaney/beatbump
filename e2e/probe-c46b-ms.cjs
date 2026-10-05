// c46b: diagnostic for mediasession_real_handlers (steps-c42-core.cjs). Same sequence as the step (library Song
// click, nexttrack, seekto 0, previoustrack after 5 s = restart, previoustrack again at < 3 s = previous title)
// with a trace at every stage: Media Session title, element currentTime / paused / readyState / seeking, the
// mini-bar queue counter ("File · 2/50"), and a 500 ms trace for 8 s after each handler call. Then a second
// attempt of the early previoustrack after a 1.5 s settle, to tell a race from a queue-position problem.
// run.sh <url> <query> probe-c46b-ms.cjs
const lib = require("./c46b-lib.cjs");
const { mediaSessionHook } = require("./steps-c42-core.cjs");
const { chromium } = require("playwright");
const { URL, QUERY, RESOLVER, sleep, pollUntil } = lib;

async function state(p) {
  return p.evaluate(() => {
    const m = window.__ytmMedia;
    const el = (m && m.el) || document.querySelector("audio,video");
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const foot = document.querySelector("footer");
    const ft = foot ? (foot.innerText || "").replace(/\s+/g, " ").trim() : "";
    const q = /(\d+)\s*\/\s*(\d+)/.exec(ft);
    const ctxEl = document.querySelector('[data-testid="playback-context"]');
    return {
      t: el ? Number(el.currentTime.toFixed(2)) : -1, paused: el ? el.paused : null, seeking: el ? el.seeking : null, rs: el ? el.readyState : -1,
      src: el ? (el.currentSrc || el.src || "").slice(0, 80) : "", title: md ? String(md.title || "") : "",
      pos: q ? Number(q[1]) : null, len: q ? Number(q[2]) : null, foot: ft.slice(0, 90), ctx: ctxEl ? (ctxEl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) : "",
      handlers: Object.keys(window.__ms || {}).filter((k) => typeof window.__ms[k] === "function"), msCalls: window.__msCalls,
    };
  });
}
const fmt = (s) => `t=${s.t} ${s.paused ? "paused" : "playing"} seeking=${s.seeking} rs=${s.rs} pos=${s.pos}/${s.len} title=${JSON.stringify(s.title.slice(0, 30))} ctx=${JSON.stringify(s.ctx)}`;
async function trace(p, label, ms, every = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { console.log(`${label} +${((Date.now() - t0) / 1000).toFixed(1)}s`, fmt(await state(p))); await sleep(every); }
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=" + RESOLVER, "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const mp = await ctx.newPage();
  mp.on("pageerror", (e) => console.log("PAGEERROR", String((e && e.message) || e).slice(0, 200)));
  mp.on("console", (m) => { const t = m.text(); if (m.type() === "error" || /previous|next track|No next|Suite|continuation|position/i.test(t)) console.log("CONSOLE", m.type(), t.slice(0, 200)); });
  await mp.addInitScript(mediaSessionHook);
  try {
    let from = "library";
    await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=library", { waitUntil: "load", timeout: 45000 });
    const lib1 = mp.getByText(/Song\s*•/).first();
    if (await lib1.isVisible({ timeout: 8000 }).catch(() => false)) await lib1.click({ position: { x: 8, y: 8 }, timeout: 8000 });
    else { from = "all"; await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 }); await mp.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 }); }
    console.log("FROM", from);
    const s1 = await pollUntil(async () => { const s = await state(mp); return s.src && s.t > 1 && s.title ? s : null; }, 40000, 500);
    if (!s1) { console.log("NO TRACK", fmt(await state(mp))); return; }
    console.log("S1", fmt(s1), "handlers", s1.handlers.join(","), "msCalls", s1.msCalls);
    await mp.evaluate(() => window.__ms.nexttrack());
    console.log("CALLED nexttrack");
    await trace(mp, "after-next", 3000);
    const s2 = await pollUntil(async () => { const s = await state(mp); return s.title && s.title !== s1.title && s.src && s.t > 0 ? s : null; }, 40000, 500);
    if (!s2) { console.log("NEXT DID NOT CHANGE", fmt(await state(mp))); return; }
    console.log("S2", fmt(s2));
    await pollUntil(async () => { const s = await state(mp); return s.t >= 4 ? s : null; }, 20000, 300);
    await mp.evaluate(() => window.__ms.seekto({ seekTime: 0 }));
    console.log("CALLED seekto 0");
    await trace(mp, "after-seekto", 1500, 250);
    const at5 = await pollUntil(async () => { const s = await state(mp); return s.t > 5 ? s : null; }, 15000, 300);
    console.log("AT5", at5 ? fmt(at5) : "never reached 5 s");
    await mp.evaluate(() => window.__ms.previoustrack());
    console.log("CALLED previoustrack #1 (expect restart)");
    const rs = await pollUntil(async () => { const s = await state(mp); return s.t >= 0 && s.t < 2 ? s : null; }, 3000, 100);
    console.log("RS", rs ? fmt(rs) : "no restart", "| immediately:", fmt(await state(mp)));
    // The step calls the second previoustrack right here (early.t was 0.0 in chain 47).
    const early = await state(mp);
    console.log("EARLY", fmt(early));
    await mp.evaluate(() => window.__ms.previoustrack());
    console.log("CALLED previoustrack #2 (expect previous title)");
    await trace(mp, "after-prev2", 8000);
    const back = await state(mp);
    if (back.title !== s2.title) { console.log("RESULT: title changed ->", JSON.stringify(back.title), "pos", back.pos, back.title === s1.title ? "(first track)" : "(NOT the first track)"); }
    else {
      console.log("RESULT: title unchanged after prev #2; retry once settled");
      await mp.evaluate(() => window.__ms.seekto({ seekTime: 0 }));
      await sleep(1500);
      const e2 = await state(mp);
      console.log("EARLY-2", fmt(e2));
      await mp.evaluate(() => window.__ms.previoustrack());
      console.log("CALLED previoustrack #3 (settled)");
      await trace(mp, "after-prev3", 8000);
      const b3 = await state(mp);
      console.log("RESULT-3:", b3.title !== s2.title ? "title changed -> " + JSON.stringify(b3.title) + " pos " + b3.pos : "title STILL unchanged", "pos", b3.pos + "/" + b3.len);
    }
    await mp.screenshot({ path: lib.OUT + "/c46b-ms.png" }).catch(() => {});
  } catch (e) {
    console.log("FATAL", String((e && e.stack) || e).slice(0, 600));
  } finally { await browser.close().catch(() => {}); }
})();
