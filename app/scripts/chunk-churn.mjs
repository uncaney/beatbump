#!/usr/bin/env node
// PF4-1 (audit perf v4): how much of a build's `_app/immutable` survives the
// next deploy. The service worker carries every unchanged hashed path over
// from the previous shell cache (carryOverShell), so a file whose path is
// identical in both builds costs nothing on deploy; a renamed one is
// downloaded again by every device.
//
// Usage:
//   node scripts/chunk-churn.mjs <old> <new> [--min 70] [--json]
//
// <old> / <new> is either
//   - a directory: a build dir, its `_app/immutable` dir or anything in
//     between (walked recursively, sizes read from disk), or
//   - a text listing, one file per line, `<path>` or `<size> <path>` (e.g.
//     `find build/_app/immutable -type f -printf '%s %P\n'`, or the
//     `tar -tvf` of an image layer: the size is the 3rd column there).
// Paths are compared from `_app/immutable/` on when they contain it.
//
// Output: files of <new> reused as is, renamed (same logical name, new
// hash; "same size" = most likely only an import changed), new, removed,
// and the bytes a device downloads on deploy. Exit 1 when the reused share
// of <new> is below --min percent (default 70, the PF4-1 target across two
// real deploys; >= 85 expected for two builds that differ by one line in a
// leaf component), 2 on bad usage.
import fs from "node:fs";
import path from "node:path";

const HASHED = /^(.*)\.([A-Za-z0-9_-]{8})(\.[A-Za-z0-9]+)$/;

/** "chunks/scheduler.8818e2a0.js" -> "chunks/scheduler.js" (unhashed paths unchanged). */
export function logicalName(p) {
	const m = HASHED.exec(p);
	return m ? m[1] + m[3] : p;
}

function rel(p) {
	const n = p.replace(/\\/g, "/");
	const i = n.indexOf("_app/immutable/");
	return i >= 0 ? n.slice(i + "_app/immutable/".length) : n.replace(/^\.?\//, "");
}

/** Parse a listing: lines `<path>`, `<size> <path>` or `tar -tvf` lines. */
export function parseListing(text) {
	const out = new Map();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.endsWith("/")) continue;
		const parts = line.split(/\s+/);
		let size = null;
		let p = parts[parts.length - 1];
		if (parts.length === 2 && /^\d+$/.test(parts[0])) size = Number(parts[0]);
		else if (parts.length >= 6 && /^[-dlrwxst]{10}$/.test(parts[0])) {
			if (parts[0][0] !== "-") continue; // directories, links
			size = Number(parts[2]);
		}
		if (parts.length > 2 && size === null && !/^[-dlrwxst]{10}$/.test(parts[0])) p = line; // path with spaces
		out.set(rel(p), size);
	}
	return out;
}

function walk(dir, base = dir, out = new Map()) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const f = path.join(dir, e.name);
		if (e.isDirectory()) walk(f, base, out);
		else if (e.isFile()) out.set(rel(path.relative(base, f)), fs.statSync(f).size);
	}
	return out;
}

export function load(src) {
	const st = fs.statSync(src);
	if (st.isDirectory()) {
		const imm = path.join(src, "_app", "immutable");
		return walk(fs.existsSync(imm) ? imm : src);
	}
	return parseListing(fs.readFileSync(src, "utf8"));
}

/** Compare two listings (Map path -> size|null). Pure. */
export function churn(oldFiles, newFiles) {
	const oldByLogical = new Map();
	for (const [p, size] of oldFiles) oldByLogical.set(logicalName(p), { p, size });
	const r = { total: newFiles.size, reused: [], renamed: [], sameSize: [], added: [], removed: [], downloadBytes: 0, reusedBytes: 0 };
	const seenLogical = new Set();
	for (const [p, size] of newFiles) {
		const ln = logicalName(p);
		seenLogical.add(ln);
		if (oldFiles.has(p)) {
			r.reused.push(p);
			r.reusedBytes += size ?? 0;
			continue;
		}
		r.downloadBytes += size ?? 0;
		const prev = oldByLogical.get(ln);
		if (prev) {
			r.renamed.push(p);
			if (size != null && prev.size === size) r.sameSize.push(p);
		} else r.added.push(p);
	}
	for (const [p] of oldFiles) if (!newFiles.has(p) && !seenLogical.has(logicalName(p))) r.removed.push(p);
	r.reusedPct = r.total ? (100 * r.reused.length) / r.total : 100;
	return r;
}

function main(argv) {
	const args = argv.slice(2);
	const json = args.includes("--json");
	const mi = args.indexOf("--min");
	const min = mi >= 0 ? Number(args[mi + 1]) : 70;
	const pos = args.filter((a, i) => !a.startsWith("--") && !(mi >= 0 && i === mi + 1));
	if (pos.length !== 2 || !Number.isFinite(min)) {
		console.error("usage: node scripts/chunk-churn.mjs <old dir|listing> <new dir|listing> [--min 70] [--json]");
		return 2;
	}
	const r = churn(load(pos[0]), load(pos[1]));
	if (json) {
		console.log(JSON.stringify({ ...r, min }, null, 2));
	} else {
		const kb = (b) => (b / 1024).toFixed(1) + " KB";
		console.log(`files in new build: ${r.total}`);
		console.log(`reused (same path): ${r.reused.length} (${r.reusedPct.toFixed(1)}%, ${kb(r.reusedBytes)})`);
		console.log(`renamed (new hash): ${r.renamed.length}, of which same size: ${r.sameSize.length}`);
		console.log(`new logical names:  ${r.added.length}; removed: ${r.removed.length}`);
		console.log(`downloaded on deploy: ${r.total - r.reused.length} files, ${kb(r.downloadBytes)} (raw)`);
		const top = r.sameSize.slice(0, 15);
		if (top.length) console.log("same-size renames (import churn):\n  " + top.join("\n  ") + (r.sameSize.length > top.length ? "\n  ..." : ""));
		console.log(r.reusedPct >= min ? `OK: reused >= ${min}%` : `FAIL: reused < ${min}%`);
	}
	return r.reusedPct >= min ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("chunk-churn.mjs")) {
	process.exitCode = main(process.argv);
}
