import { describe, expect, it, vi } from "vitest";

// Same harness as service-worker.shell.test.ts: mock the SvelteKit virtual
// module and stub `self` so the pure helpers can be imported.
vi.mock("$service-worker", () => ({ build: [], files: [], version: "test" }));
vi.stubGlobal("self", { addEventListener: () => {} });

const OLD = [
	"/",
	"/manifest.json",
	"/_app/immutable/entry/start.aaaa1111.js",
	"/_app/immutable/chunks/scheduler.8818e2a0.js",
	"/_app/immutable/chunks/hls.0b2c3d4e.js",
	"/_app/immutable/nodes/0.old00000.js",
	"/_app/immutable/assets/0.8ac991bc.css",
	"/_app/immutable/chunks/scheduler.8818e2a0.js", // duplicate key
];
const BUILD = new Set([
	"/_app/immutable/entry/start.bbbb2222.js", // rehashed
	"/_app/immutable/chunks/scheduler.8818e2a0.js", // unchanged
	"/_app/immutable/chunks/hls.0b2c3d4e.js", // unchanged
	"/_app/immutable/nodes/0.new11111.js",
	"/_app/immutable/assets/0.8ac991bc.css", // unchanged
]);

describe("PF3-5: carryOverPaths (deploy reuses unchanged hashed assets)", () => {
	it("keeps only immutable paths still in the new build and not already cached", async () => {
		const { carryOverPaths } = await import("./service-worker");
		const have = new Set(["/_app/immutable/assets/0.8ac991bc.css"]);
		expect(carryOverPaths(OLD, BUILD, have).sort()).toEqual([
			"/_app/immutable/chunks/hls.0b2c3d4e.js",
			"/_app/immutable/chunks/scheduler.8818e2a0.js",
		]);
	});
	it("never carries the HTML shell or non-hashed static files", async () => {
		const { carryOverPaths } = await import("./service-worker");
		const build = new Set(["/", "/manifest.json"]);
		expect(carryOverPaths(["/", "/manifest.json"], build, new Set())).toEqual([]);
	});
	it("returns nothing from an empty old cache", async () => {
		const { carryOverPaths } = await import("./service-worker");
		expect(carryOverPaths([], BUILD, new Set())).toEqual([]);
	});
});

describe("PF3-5: isOnDemandOnly (excluded from the background precache)", () => {
	it("matches hls and the non-Latin Commissioner subsets only", async () => {
		const { isOnDemandOnly } = await import("./service-worker");
		expect(isOnDemandOnly("/_app/immutable/chunks/hls.0b2c3d4e.js")).toBe(true);
		for (const sub of ["cyrillic", "cyrillic-ext", "vietnamese", "latin-ext", "greek"]) {
			expect(isOnDemandOnly(`/_app/immutable/assets/commissioner-${sub}-wght-normal.1a2b3c4d.woff2`)).toBe(true);
		}
		expect(isOnDemandOnly("/_app/immutable/assets/commissioner-latin-wght-normal.1a2b3c4d.woff2")).toBe(false);
		expect(isOnDemandOnly("/_app/immutable/chunks/player.12345678.js")).toBe(false);
		expect(isOnDemandOnly("/_app/immutable/chunks/hlsHelper.12345678.js")).toBe(false);
	});
});

describe("PF3-7: staticPrecacheList", () => {
	it("keeps manifest, favicons, logo and manifest icons; drops the rest", async () => {
		const { staticPrecacheList } = await import("./service-worker");
		const files = [
			"/manifest.json",
			"/favicon.ico",
			"/favicon.png",
			"/logo.svg",
			"/logo.png",
			"/robots.txt",
			"/apple-touch-icon-120x120.png",
			"/assets/favicon-16x16.png",
			"/assets/favicon-32x32.png",
			"/assets/mstile-150x150.png",
			"/android/android-launchericon-512-512.png",
			"/android/android-launchericon-48-48.png",
			"/maskable-icon-512x512.png",
			"/maskable.svg",
		];
		expect(staticPrecacheList(files)).toEqual([
			"/manifest.json",
			"/favicon.ico",
			"/logo.svg",
			"/assets/favicon-16x16.png",
			"/assets/favicon-32x32.png",
			"/android/android-launchericon-512-512.png",
			"/android/android-launchericon-48-48.png",
			"/maskable-icon-512x512.png",
		]);
	});
	it("covers every icon the shipped manifest lists", async () => {
		const { staticPrecacheList } = await import("./service-worker");
		const fs = await import("node:fs");
		const manifest = JSON.parse(fs.readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8"));
		const icons: string[] = manifest.icons.map((i: { src: string }) => "/" + i.src.replace(/^\//, ""));
		expect(staticPrecacheList(icons)).toEqual(icons);
	});
});
