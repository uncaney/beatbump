// PF4-1 (audit perf v4): a stable Svelte runtime chunk.
//
// Every compiled component imports its DOM helpers from `svelte/internal`.
// Rollup tree-shakes that module, so the shared runtime chunk (it used to be
// named `chunks/scheduler.*.js`, imported by 81 of 217 build files) only
// holds the helpers the app uses TODAY: when one component starts or stops
// using a helper (`exclude_internal_props`, ...) its content changes, the
// minified export names reshuffle, its hash changes, and the hash of every
// importer changes with it (Rollup 3 hashes include the dependencies'
// hashes). Measured: ~54% of the build renamed per deploy, code unchanged.
//
// The fix keeps the runtime's content independent from the app:
//   - `svelteRuntimeChunk()` emits one extra entry chunk, `svelte-runtime`,
//     that re-exports the WHOLE client surface of `svelte/internal` plus
//     `svelte/store`, `/transition`, `/easing`, `/animate` and `/motion`
//     (which the app also imports, and which would otherwise be tree-shaken
//     into the same chunk) with `preserveSignature: "strict"`: nothing is
//     tree-shaken out of it. The dev-only (`dev.js`) and server-only
//     (`ssr.js`) internal helpers are left out (about 30 KB min / 12 KB gz
//     in all with Svelte 4.2, i.e. roughly +18 KB raw / +7 KB gz once,
//     against ~550 KB gz per device per deploy);
//   - its `outputOptions` hook adds the `svelteManualChunk()` rule in front
//     of the configured manualChunks: that entry and every
//     `node_modules/svelte/` module share the chunk, so the components
//     import from it;
//   - `output.minifyInternalExports: false` (vite.config.ts) keeps the
//     export names of every shared chunk readable and stable.
// The chunk now only changes with a Svelte upgrade. Client build only (the
// SSR build and the dev server are untouched); if `svelte/internal` cannot
// be resolved or no longer has the expected `export * from` shape, nothing
// is emitted and the build is exactly the previous one (a warning says so).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

export const SVELTE_RUNTIME_CHUNK = "svelte-runtime";
export const SVELTE_RUNTIME_ID = "\0ytm-svelte-runtime.js";
const EXCLUDED = new Set(["dev.js", "ssr.js"]);
/** The public svelte/* modules kept whole too (src/runtime/<name>/index.js). */
const PUBLIC_MODULES = ["store", "transition", "easing", "animate", "motion"];

/** The runtime files `svelte/internal/index.js` re-exports, minus dev / ssr. Pure. */
export function runtimeSurface(indexSource: string): string[] {
	return [...indexSource.matchAll(/export \* from ['"]\.\/([\w.-]+\.js)['"]/g)].map((m) => m[1]).filter((f) => !EXCLUDED.has(f));
}

/** manualChunks rule: the runtime entry and every svelte module share one chunk. */
export function svelteManualChunk(id: string): string | undefined {
	if (id === SVELTE_RUNTIME_ID || id.includes("/node_modules/svelte/")) return SVELTE_RUNTIME_CHUNK;
	return undefined;
}

/** Resolve the directory of the svelte/internal runtime the app compiles against. */
export function resolveRuntimeDir(root: string): string | null {
	try {
		const req = createRequire(path.join(root, "package.json"));
		return path.dirname(fs.realpathSync(req.resolve("svelte/internal")));
	} catch {
		return null;
	}
}

export function svelteRuntimeChunk(opts: { root?: string; force?: boolean } = {}): Plugin {
	let enabled = !!opts.force;
	let root = opts.root ?? process.cwd();
	let source = "";
	return {
		name: "ytm-svelte-runtime-chunk",
		apply: "build",
		configResolved(c) {
			enabled = opts.force || !c.build.ssr;
			root = opts.root ?? c.root;
		},
		buildStart() {
			source = "";
			if (!enabled) return;
			const dir = resolveRuntimeDir(root);
			const files = dir ? runtimeSurface(fs.readFileSync(path.join(dir, "index.js"), "utf8")) : [];
			if (!dir || files.length < 5) {
				this.warn("svelte/internal not found or not in the expected shape: no stable svelte-runtime chunk");
				return;
			}
			const mods = files.map((f) => path.join(dir, f));
			for (const m of PUBLIC_MODULES) {
				const f = path.join(path.dirname(dir), m, "index.js");
				if (fs.existsSync(f)) mods.push(f);
			}
			source = mods.map((f) => `export * from ${JSON.stringify(f)};`).join("\n") + "\n";
			this.emitFile({ type: "chunk", id: SVELTE_RUNTIME_ID, name: SVELTE_RUNTIME_CHUNK, preserveSignature: "strict" });
		},
		resolveId(id) {
			return id === SVELTE_RUNTIME_ID ? id : null;
		},
		load(id) {
			return id === SVELTE_RUNTIME_ID ? source : null;
		},
		outputOptions(o) {
			if (!source) return null;
			const prev = o.manualChunks;
			if (prev && typeof prev !== "function") return null; // object form: left alone
			return {
				...o,
				manualChunks: (id, meta) => svelteManualChunk(id) ?? (prev ? prev(id, meta) : undefined),
			};
		},
	};
}
