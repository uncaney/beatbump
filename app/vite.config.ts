import { sveltekit } from "@sveltejs/kit/vite";
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
export default config;
