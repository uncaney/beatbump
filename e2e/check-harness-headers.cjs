#!/usr/bin/env node
// c52c (B9-13): static self-check, no browser. Every Playwright context created under e2e/ must send the request
// header X-Ytm-Harness: 1 (api/me_stats.go harnessRequest ignores such plays in prod stats; staging keeps
// YTM_STATS_INCLUDE_HARNESS=1). A context created with a human UA and without the header writes real plays into
// the prod database (brainstorm v9 section 0: 17 "active" profiles were the harness playing Gangnam Style).
//
// Rule: each `newContext(` / `launchPersistentContext(` call in a .cjs file (node_modules, out, profiles skipped)
// must, inside the call text, either inline the header (`"X-Ytm-Harness"`), spread HARNESS_HEADERS, or be the
// harness-core / harness-offline helper `newHarnessContext(`. Step modules call `newCtx(browser, ...)` (the
// compat shim: deps.newHarnessContext || inline fallback), which never matches `newContext(` and is therefore
// never flagged; the shim's fallback line itself carries the header and is checked like any other call.
// Escape hatch for a deliberate exception: the comment `// no-harness-header: <reason>` on the same line.
//
// Usage: node check-harness-headers.cjs [dir]   (default: the directory of this file). Exit 1 lists each
// offending file:line, exit 0 prints the count of checked calls. stage-cycle.sh runs it before the harness.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || __dirname);
const SKIP_DIRS = new Set(["node_modules", "out", "profiles"]);
const OK_RE = /"X-Ytm-Harness"|'X-Ytm-Harness'|HARNESS_HEADERS|newHarnessContext\(/;
const CALL_RE = /\b(newContext|launchPersistentContext)\(/g;
const ESCAPE = "no-harness-header:";

function walk(dir, acc) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), acc); }
    else if (e.isFile() && e.name.endsWith(".cjs") && e.name !== path.basename(__filename)) acc.push(path.join(dir, e.name));
  }
  return acc;
}

// Text of the call from its opening "(" to the matching ")" (brackets of every kind balanced; capped).
function callText(src, open) {
  let depth = 0;
  const end = Math.min(src.length, open + 4000);
  for (let i = open; i < end; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open, end);
}

const files = walk(ROOT, []).sort();
const bad = [];
let calls = 0, filesWithCalls = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  let seen = false;
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src))) {
    const lineNo = src.slice(0, m.index).split("\n").length;
    const line = lines[lineNo - 1] || "";
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue; // a comment
    calls++; seen = true;
    if (line.includes(ESCAPE)) continue;
    const text = callText(src, m.index + m[0].length - 1);
    if (OK_RE.test(text)) continue;
    bad.push(`${path.relative(ROOT, f)}:${lineNo}: ${trimmed.slice(0, 140)}`);
  }
  if (seen) filesWithCalls++;
}

if (bad.length) {
  console.log(`check-harness-headers: ${bad.length} context(s) WITHOUT X-Ytm-Harness (of ${calls} calls in ${filesWithCalls} files under ${ROOT}):`);
  for (const b of bad) console.log("  " + b);
  console.log('fix: inline `extraHTTPHeaders: { "X-Ytm-Harness": "1" }`, call newHarnessContext(browser, opts) / newCtx(browser, opts), or justify with `// no-harness-header: <reason>`');
  process.exit(1);
}
console.log(`check-harness-headers: OK, ${calls} context calls in ${filesWithCalls} files (${files.length} .cjs scanned under ${ROOT}) all carry X-Ytm-Harness: 1`);
