import { sveltekit } from "@sveltejs/kit/vite";
import { svelteRuntimeChunk } from "./scripts/svelteRuntimeChunk";
import type { ConfigEnv } from "vite";
import type { UserConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const version = new Date(Date.now());
const version_fmt = `${version.getUTCFullYear()}.${version
	.getMonth()
	.toString()
	.padStart(2, "0")}.${version.getDate().toString().padStart(2, "0")}`;

const config: UserConfig = {
	// PF4-1: svelteRuntimeChunk emits the stable svelte-runtime chunk (client build only).
	plugins: [sveltekit(), svelteRuntimeChunk()],
	build: {
		minify: "esbuild",
		cssTarget: ["chrome58", "edge16", "firefox57", "safari11"],
		rollupOptions: {
			output: {
				// PF4-1 (audit perf v4): readable, stable export names for every
				// shared chunk; minified ones ("kt", "Tt") were reassigned whenever
				// a chunk's export set changed, renaming all its importers.
				minifyInternalExports: false,
				// hls.js (~400 KB raw) is statically imported by $lib/player.ts and
				// used to make up ~87% of the shared "window" chunk, so every app
				// change re-downloaded it. Keep it in its own long-lived chunk.
				// PF4-1: in the client build, svelteRuntimeChunk puts the Svelte
				// runtime in its own stable chunk ahead of this rule (instead of the
				// tree-shaken "scheduler" chunk that 81 files import).
				manualChunks(id) {
					if (id.includes("/node_modules/hls.js/")) return "hls";
				},
			},
		},
	},
	define: {
		"process.env.APP_VERSION": JSON.stringify(version_fmt),
	},
	esbuild: {
		treeShaking: true,
		minifyWhitespace: true,
		minifyIdentifiers: true,
		minifySyntax: true,
	},
	server: {
		hmr: {
			overlay: false,
		},
		fs: {
			strict: false,
			allow: ["../", "./"],
		},
	},
	test: {
		include: ["src/**/*.{test,spec}.{js,ts}"],
		// c52d: component tests (`// @vitest-environment jsdom`) mount real .svelte
		// files. Vitest 0.32 externalises `svelte` and Node resolves its default
		// export, src/runtime/ssr.js, where onMount is a no-op (the card never
		// loaded its cache listing). The bare specifier is aliased to the browser
		// runtime file for tests only; its internals are the same module instance
		// the compiled components import through svelte/internal.
		alias: [{ find: /^svelte$/, replacement: fileURLToPath(new URL("./node_modules/svelte/src/runtime/index.js", import.meta.url)) }],
	},
	worker: {
		plugins: [],
		format: "es",
		rollupOptions: {
			treeshake: { preset: "recommended" },
			external: ["hls.js", "peerjs"],
			output: { format: "iife" },
		},
	},
};
// PF3-12 (audit perf v3): 66 console.log sites ship to production (one of
// them reactive on /home). In a production build the console.log / debug /
// info / trace calls are marked pure so the minifier removes them, and
// `debugger` statements are dropped; console.error / console.warn (Logger.err,
// clientLog, the SW warnings) are kept. Dev server and vitest are untouched.
const PROD_PURE_CONSOLE = ["console.log", "console.debug", "console.info", "console.trace"];
export default ({ command }: ConfigEnv): UserConfig =>
	command === "build"
		? { ...config, esbuild: { ...config.esbuild, drop: ["debugger"], pure: PROD_PURE_CONSOLE } }
		: config;
