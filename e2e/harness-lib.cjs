// harness-lib.cjs: helpers shared by every harness entry point (harness-core, harness-offline,
// harness-smoke, the probes) and by the steps-c*.cjs modules. No side effect at load time.
//
//   loadFixtures()                 fixtures.json next to this file, or the file named by HARNESS_FIXTURES
//                                  (run.sh sets it from its own HARNESS_FIXTURES=<path>). Missing = {}.
//   rawRequest(base, method, path, headers, timeoutMs)
//                                  Node-side HTTP(S) request derived from the harness URL: the scheme, host and
//                                  port come from <base>; with HARNESS_RESOLVE_IP set (Camille's box: 127.0.0.1,
//                                  the hairpin NAT is broken) the socket goes to that IP with SNI + Host kept.
//                                  Self-signed certificates are accepted. Resolves { status, headers, body, ms }.
//   servedStats(base)              parsed /api/v1/stats/library or null (never throws)
//   servedVersion(base)            its "version" field or null
//   skip(reason)                   throws a precondition-skip error: step() reports "SKIP <name> - <reason>",
//                                  counted apart from passed / failed (report.skipped)
//   isSkip(err)                    true for an error thrown by skip()
//   libraryAtLeast(base, n)        true when the served library holds at least n tracks (false when unreadable)
//   requireLibrary(base, n, what)  skip() unless libraryAtLeast(base, n); <what> names the step's need
//   typoOf(query)                  a one-letter-dropped variant of the query (typo-tolerant search steps)
//   headerFor(base)                HARNESS_HEADERS, the X-Ytm-Harness: 1 header every browser context sends
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const HARNESS_HEADERS = { "X-Ytm-Harness": "1" };

function fixturesPath() {
  const env = process.env.HARNESS_FIXTURES;
  if (env) return path.isAbsolute(env) ? env : path.join(__dirname, env);
  return path.join(__dirname, "fixtures.json");
}

function loadFixtures() {
  const f = fixturesPath();
  try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch (e) {
    console.log(`fixtures not loaded (${f}: ${String(e.message || e).slice(0, 60)}): API lookups`);
    return {};
  }
}

function parseBase(base) {
  const u = new (require("url").URL)(String(base).replace(/\/$/, "") + "/");
  const secure = u.protocol === "https:";
  return { secure, hostname: u.hostname, port: Number(u.port) || (secure ? 443 : 80), origin: u.origin };
}

function rawRequest(base, method, reqPath, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const { secure, hostname, port } = parseBase(base);
    const resolveIp = (process.env.HARNESS_RESOLVE_IP || "").trim();
    const isIp = /^[\d.]+$|^\[?[0-9a-f:]+\]?$/i.test(hostname);
    const host = resolveIp && !isIp ? resolveIp : hostname;
    const t0 = Date.now();
    const opts = { host, port, path: reqPath, method, headers: { Host: port === (secure ? 443 : 80) ? hostname : `${hostname}:${port}`, ...headers } };
    if (secure) { opts.servername = hostname; opts.rejectUnauthorized = false; }
    const req = (secure ? https : http).request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - t0 }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs} ms ${method} ${reqPath}`)));
    req.end();
  });
}

async function servedStats(base) {
  try {
    const r = await rawRequest(base, "GET", "/api/v1/stats/library", { Accept: "application/json" }, 10000);
    if (r.status !== 200) return null;
    const d = JSON.parse(r.body);
    return d && typeof d === "object" ? d : null;
  } catch { return null; }
}

async function servedVersion(base) {
  const d = await servedStats(base);
  return (d && d.version) || null;
}

function skip(reason) {
  const e = new Error(String(reason || "precondition not met"));
  e.skip = true;
  throw e;
}
const isSkip = (e) => !!(e && e.skip === true);

const statsCache = new Map();
async function libraryStats(base) {
  if (!statsCache.has(base)) statsCache.set(base, await servedStats(base));
  return statsCache.get(base);
}
async function libraryAtLeast(base, n) {
  const d = await libraryStats(base);
  return !!(d && Number(d.tracks) >= n);
}
async function requireLibrary(base, n, what) {
  if (await libraryAtLeast(base, n)) return;
  const d = await libraryStats(base);
  skip(`${what || "this step"} needs a library of at least ${n} tracks (served: ${d && d.tracks != null ? d.tracks : "unreadable"})`);
}

// "daft punk" -> "daft pnk": drop one inner letter of the last word longer than 3 characters.
function typoOf(query) {
  const words = String(query || "").trim().split(/\s+/);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w.length > 3) { words[i] = w.slice(0, 2) + w.slice(3); return words.join(" "); }
  }
  return words.join(" ");
}

module.exports = { HARNESS_HEADERS, loadFixtures, fixturesPath, parseBase, rawRequest, servedStats, servedVersion, skip, isSkip, libraryStats, libraryAtLeast, requireLibrary, typoOf };
