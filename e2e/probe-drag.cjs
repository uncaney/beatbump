const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") console.log("CONSOLE", m.text().slice(0, 120)); });
  await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
  await sleep(5000);
  await page.locator("footer img").first().click({ timeout: 5000 });
  await sleep(1500);
  const rows = page.locator('[data-testid="queue-row"]');
  const titles = async () => { const out = []; for (let i = 0; i < 4; i++) out.push((await rows.nth(i).innerText()).replace(/\s+/g, " ").trim().slice(0, 28)); return out; };
  console.log("ROWS", await rows.count(), JSON.stringify(await titles()));
  const info = await rows.nth(2).evaluate((el) => { const g = el.querySelector(".drag-handle"); const cs = g && getComputedStyle(g); return { grip: !!g, draggable: g && g.getAttribute("draggable"), op: cs && cs.opacity, pe: cs && cs.pointerEvents, touch: cs && cs.touchAction }; });
  console.log("GRIP", JSON.stringify(info));
  // A: locator.dragTo
  await rows.nth(2).hover();
  await rows.nth(2).locator(".drag-handle").first().dragTo(rows.nth(1), { timeout: 8000 }).catch((e) => console.log("dragTo err", e.message.slice(0, 80)));
  await sleep(1200);
  console.log("AFTER_DRAGTO", JSON.stringify(await titles()));
  // B: pointer sequence with pointer capture semantics (dispatch synthetic events)
  const res = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('[data-testid="queue-row"]')];
    const src = rows[2], dst = rows[1];
    const g = src.querySelector(".drag-handle") || src;
    const r = g.getBoundingClientRect(), d = dst.getBoundingClientRect();
    const ev = (type, target, x, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, ...extra }));
    ev("pointerdown", g, r.x + r.width / 2, r.y + r.height / 2);
    await new Promise((f) => setTimeout(f, 50));
    for (let k = 1; k <= 10; k++) { const y = r.y + (d.y + d.height / 3 - r.y) * k / 10; ev("pointermove", g, r.x + r.width / 2, y); const over = document.elementFromPoint(r.x + r.width / 2, y); if (over) ev("pointerenter", over.closest('[data-testid="queue-row"]') || over, r.x + r.width / 2, y); await new Promise((f) => setTimeout(f, 30)); }
    ev("pointerup", g, r.x + r.width / 2, d.y + d.height / 3, { buttons: 0 });
    await new Promise((f) => setTimeout(f, 800));
    return [...document.querySelectorAll('[data-testid="queue-row"]')].slice(0, 4).map((e) => e.innerText.replace(/\s+/g, " ").trim().slice(0, 28));
  });
  console.log("AFTER_POINTER", JSON.stringify(res));
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
