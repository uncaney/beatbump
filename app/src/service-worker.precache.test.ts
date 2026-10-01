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
			"/android/android-launchericon-192-192.png",
			"/android/android-launchericon-144-144.png",
			"/android/android-launchericon-48-48.png",
			"/maskable-icon-512x512.png",
			"/maskable-icon-192x192.png",
			"/maskable.svg",
		];
		expect(staticPrecacheList(files)).toEqual([
			"/manifest.json",
			"/favicon.ico",
			"/logo.svg",
			"/assets/favicon-16x16.png",
			"/assets/favicon-32x32.png",
			"/android/android-launchericon-512-512.png",
			"/android/android-launchericon-192-192.png",
			"/maskable-icon-512x512.png",
			"/maskable-icon-192x192.png",
		]);
	});
	it("PF4-6: covers the 192 and 512 icons of the shipped manifest, not the smaller ones", async () => {
		const { staticPrecacheList } = await import("./service-worker");
		const fs = await import("node:fs");
		const manifest = JSON.parse(fs.readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8"));
		const icons: string[] = manifest.icons.map((i: { src: string }) => "/" + i.src.replace(/^\//, ""));
		const big = icons.filter((i) => /(?:192|512)\D/.test(i.replace(/^.*\//, "")));
		expect(big.length).toBe(4); // launcher + maskable, 192 and 512
		expect(staticPrecacheList(icons)).toEqual(big);
	});
});

describe("PF4-6: static files carried over and revalidated on deploy", () => {
	it("carries the install's non-hashed paths the old cache has, once, unless already cached", async () => {
		const { carryOverStaticPaths } = await import("./service-worker");
		const wanted = ["/", "/manifest.json", "/favicon.ico", "/logo.svg", "/manifest.json"];
		const oldPaths = ["/", "/manifest.json", "/logo.svg", "/_app/immutable/chunks/scheduler.8818e2a0.js", "/robots.txt"];
		expect(carryOverStaticPaths(oldPaths, wanted, new Set(["/logo.svg"]))).toEqual(["/", "/manifest.json"]);
	});
	it("never takes a hashed asset or a file outside the install list", async () => {
		const { carryOverStaticPaths } = await import("./service-worker");
		const p = "/_app/immutable/chunks/scheduler.8818e2a0.js";
		expect(carryOverStaticPaths([p, "/robots.txt"], [p, "/manifest.json"], new Set())).toEqual([]);
		expect(carryOverStaticPaths([], ["/"], new Set())).toEqual([]);
	});
	it("revalidates with the ETag, else Last-Modified, else not at all", async () => {
		const { conditionalHeaders } = await import("./service-worker");
		const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
		expect(conditionalHeaders(h({ etag: 'W/"abc"', "last-modified": "Thu, 01 Oct 2026 18:18:06 GMT" }))).toEqual({ "If-None-Match": 'W/"abc"' });
		expect(conditionalHeaders(h({ "last-modified": "Thu, 01 Oct 2026 18:18:06 GMT" }))).toEqual({ "If-Modified-Since": "Thu, 01 Oct 2026 18:18:06 GMT" });
		expect(conditionalHeaders(h({}))).toBeNull();
	});
});

describe("L11-4 + L10-7: install never carries the previous build's \"/\", statics read from this shell first", () => {
	it("stores \"/\" only from a fresh 200 text/html", async () => {
		const { staticCarryAction } = await import("./service-worker");
		expect(staticCarryAction("/", { networkError: true })).toBe("none");
		expect(staticCarryAction("/", { status: 304 })).toBe("none");
		expect(staticCarryAction("/", { status: 200, contentType: "text/html; charset=utf-8" })).toBe("new");
		expect(staticCarryAction("/", { status: 200, contentType: "application/json" })).toBe("none");
		expect(staticCarryAction("/", { status: 500, contentType: "text/html" })).toBe("none");
	});
	it("keeps the previous copy of other statics on 304 or a network error, the new one on 200", async () => {
		const { staticCarryAction } = await import("./service-worker");
		expect(staticCarryAction("/manifest.json", { networkError: true })).toBe("old");
		expect(staticCarryAction("/manifest.json", { status: 304 })).toBe("old");
		expect(staticCarryAction("/manifest.json", { status: 200, contentType: "application/manifest+json" })).toBe("new");
		expect(staticCarryAction("/manifest.json", { status: 200, contentType: "text/html" })).toBe("none");
		expect(staticCarryAction("/logo.svg", { status: 404 })).toBe("none");
	});
	it("isInstallableResponse: \"/\" needs 200 HTML, assets a 200 that is not the HTML fallback", async () => {
		const { isInstallableResponse } = await import("./service-worker");
		expect(isInstallableResponse("/", 200, "text/html")).toBe(true);
		expect(isInstallableResponse("/", 200, null)).toBe(false);
		expect(isInstallableResponse("/", 204, "text/html")).toBe(false);
		expect(isInstallableResponse("/_app/immutable/entry/app.x.js", 200, "text/html")).toBe(false);
		expect(isInstallableResponse("/_app/immutable/entry/app.x.js", 200, "text/javascript")).toBe(true);
		expect(isInstallableResponse("/favicon.ico", 200, "image/x-icon")).toBe(true);
	});
	it("carries from the last active shell when it is still there, else the highest build", async () => {
		const { carrySourceShell } = await import("./service-worker");
		const keys = ["ytm-shell-100", "ytm-shell-300", "ytm-shell-200", "ytm-offline-meta"];
		expect(carrySourceShell(keys, "ytm-shell-400", "ytm-shell-100")).toBe("ytm-shell-100");
		expect(carrySourceShell(keys, "ytm-shell-400", "ytm-shell-999")).toBe("ytm-shell-300");
		expect(carrySourceShell(keys, "ytm-shell-400", null)).toBe("ytm-shell-300");
		expect(carrySourceShell(keys, "ytm-shell-300", "ytm-shell-300")).toBe("ytm-shell-200");
		expect(carrySourceShell(["ytm-shell-400"], "ytm-shell-400", null)).toBeNull();
	});
	it("non-hashed paths are looked up in the current shell first, hashed ones anywhere", async () => {
		const { currentShellFirst } = await import("./service-worker");
		expect(currentShellFirst("/manifest.json")).toBe(true);
		expect(currentShellFirst("/logo.svg")).toBe(true);
		expect(currentShellFirst("/")).toBe(true);
		expect(currentShellFirst("/_app/immutable/chunks/scheduler.8818e2a0.js")).toBe(false);
	});
});

describe("PF3-1: cover 404 memory", () => {
	it("answers a missed lid for an hour, then asks again", async () => {
		const { createCoverMissSet } = await import("./service-worker");
		const m = createCoverMissSet(3, 1000);
		m.add("/cover?lid=a", 0);
		expect(m.has("/cover?lid=a", 999)).toBe(true);
		expect(m.has("/cover?lid=b", 10)).toBe(false);
		expect(m.has("/cover?lid=a", 1000)).toBe(false);
		expect(m.size).toBe(0); // expired entry dropped on read
	});
	it("stays bounded, evicting the oldest", async () => {
		const { createCoverMissSet } = await import("./service-worker");
		const m = createCoverMissSet(3, 1000);
		for (const l of ["a", "b", "c"]) m.add("/cover?lid=" + l, 0);
		m.add("/cover?lid=a", 1); // refreshed: now the newest
		m.add("/cover?lid=d", 2);
		expect(m.size).toBe(3);
		expect(m.has("/cover?lid=b", 3)).toBe(false);
		expect(m.has("/cover?lid=a", 3)).toBe(true);
		expect(m.has("/cover?lid=c", 3)).toBe(true);
		expect(m.has("/cover?lid=d", 3)).toBe(true);
	});
});

describe("PF3-11: cover cache trim cadence", () => {
	it("trims on the first put of a SW lifetime, then every 25", async () => {
		const { coverTrimDue } = await import("./service-worker");
		const due = Array.from({ length: 80 }, (_, i) => i + 1).filter((n) => coverTrimDue(n));
		expect(due).toEqual([1, 25, 50, 75]);
	});
});
