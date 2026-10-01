import { sveltekit } from "@sveltejs/kit/vite";
import type { ConfigEnv } from "vite";
import type { UserConfig } from "vitest/config";

const version = new Date(Date.now());
const version_fmt = `${version.getUTCFullYear()}.${version
	.getMonth()
	.toString()
	.padStart(2, "0")}.${version.getDate().toString().padStart(2, "0")}`;

const config: UserConfig = {
	plugins: [sveltekit()],
	build: {
		minify: "esbuild",
		cssTarget: ["chrome58", "edge16", "firefox57", "safari11"],
		rollupOptions: {
			output: {
				// hls.js (~400 KB raw) is statically imported by $lib/player.ts and
				// used to make up ~87% of the shared "window" chunk, so every app
				// change re-downloaded it. Keep it in its own long-lived chunk.
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
