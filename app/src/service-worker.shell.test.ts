import { describe, expect, it, vi } from "vitest";

// service-worker.ts imports `build`/`files`/`version` from the SvelteKit
// virtual module "$service-worker" (only resolvable inside an actual SW
// build). Mock it so the file's pure helpers (parseShellDeps, SHELL_MIN_ASSETS)
// can be unit-tested directly, without a service-worker runtime.
vi.mock("$service-worker", () => ({
	build: [],
	files: [],
	version: "test",
}));

// service-worker.ts registers its event listeners (install/activate/fetch/…)
// at module top level against the real `self` (ServiceWorkerGlobalScope),
// which doesn't exist in the vitest environment. Stub just enough of it so
// importing the module for its pure helpers doesn't throw; none of these
// listeners are ever invoked by this test.
vi.stubGlobal("self", { addEventListener: () => {} });

const ENTRY_APP = "/_app/immutable/entry/app.aca7a511.js";
const ENTRY_START = "/_app/immutable/entry/start.ebe642fe.js";

// L5 (audit v7, P3): a real fixture, taken verbatim from an actual
// `app/build/_app/immutable/entry/app.*.js` of this app (production build,
// node ids 0 = root layout, 1 = root error page, 2 = "/", 10 = "/home").
const REAL_MANIFEST_FIXTURE = `
import("../nodes/0.a69cc9c8.js"),["../nodes/0.a69cc9c8.js","../chunks/0.a33a3ea1.js","../chunks/preload-helper.a4192956.js","../chunks/scheduler.8818e2a0.js","../chunks/index.cc909c4f.js","../chunks/api.7c5e8576.js","../chunks/navigation.f212a274.js","../chunks/singletons.5110c423.js","../chunks/index.824a9edc.js","../chunks/Icon.9e1a1041.js","../assets/Icon.d2dfcb4b.css","../chunks/debounce.7b04f24d.js","../chunks/stores.d52a5fbf.js","../chunks/utils.34079d63.js","../chunks/channel.85922e67.js","../chunks/sessionList.62ef7a86.js","../chunks/offline.0bcf8bcb.js","../chunks/nowPlayingSync.e1d06755.js","../chunks/me.a7c96bec.js","../chunks/local.0546bbf0.js","../chunks/Modal.a3add5a6.js","../chunks/index.828fc4f8.js","../chunks/index.9e983473.js","../assets/Modal.15e4fadb.css","../chunks/buffer.8e6379eb.js","../chunks/slide.7e12ed77.js","../chunks/favourites.d4ba4340.js","../chunks/service.31d3b2fd.js","../assets/favourites.3978c5a6.css","../chunks/dropdowns.config.a11a395f.js","../chunks/url.8e575cc4.js","../chunks/stores.eca7e38a.js","../chunks/scrollObserver.c767f464.js","../chunks/utils.e69c6c84.js","../chunks/environment.60829b93.js","../chunks/pwa.39926a0d.js","../assets/0.8ac991bc.css","../assets/DropdownItem.1f7e5edc.css"]
import("../nodes/1.1751ffcc.js"),["../nodes/1.1751ffcc.js","../chunks/scheduler.8818e2a0.js","../chunks/index.cc909c4f.js","../chunks/navigation.f212a274.js","../chunks/singletons.5110c423.js","../chunks/index.824a9edc.js","../chunks/stores.eca7e38a.js","../assets/1.6de94984.css"]
import("../nodes/2.7348d6b0.js"),["../nodes/2.7348d6b0.js","../chunks/index.6f9d1f14.js","../chunks/control.c2cf8273.js","../chunks/scheduler.8818e2a0.js","../chunks/index.cc909c4f.js"]
import("../nodes/10.9531e318.js"),["../nodes/10.9531e318.js","../chunks/api.7c5e8576.js","../chunks/index.cc909c4f.js","../chunks/scheduler.8818e2a0.js","../chunks/navigation.f212a274.js","../chunks/singletons.5110c423.js","../chunks/index.824a9edc.js","../chunks/stores.eca7e38a.js","../chunks/viewport.7af7a1d2.js","../chunks/Carousel.8312e160.js","../chunks/Icon.9e1a1041.js","../assets/Icon.d2dfcb4b.css","../chunks/CarouselItem.7be12574.js","../chunks/Loading.83ecea35.js","../chunks/index.828fc4f8.js","../chunks/index.9e983473.js","../assets/Loading.0adfd08a.css","../chunks/favourites.d4ba4340.js","../chunks/me.a7c96bec.js","../chunks/service.31d3b2fd.js","../chunks/utils.34079d63.js","../chunks/stores.d52a5fbf.js","../chunks/preload-helper.a4192956.js","../assets/favourites.3978c5a6.css","../chunks/queueActions.865483b5.js","../chunks/offline.0bcf8bcb.js","../chunks/sessionList.62ef7a86.js","../chunks/dropdowns.config.a11a395f.js","../chunks/buffer.8e6379eb.js","../chunks/noop.cb277961.js","../chunks/url.8e575cc4.js","../assets/CarouselItem.f8bb48cc.css","../assets/DropdownItem.1f7e5edc.css","../chunks/observer.97c295cd.js","../assets/Carousel.c899874e.css","../chunks/Header.8f6b7e47.js","../chunks/nowPlayingSync.e1d06755.js","../chunks/contexts.095c2fc9.js","../chunks/getContext.52c71826.js","../chunks/PlayAllBar.577a6e75.js","../assets/PlayAllBar.cef83b49.css","../assets/10.fad8fed8.css"]
const routes=[{id:"/"},{id:"/(app)/downloads"}];
"/":[2],"/(app)/downloads":[6],"/(app)/explore":[7],"/(app)/favorites":[9],"/(app)/home":[10],"/(app)/library":[11]
`;

const REAL_HTML_FIXTURE = `<!doctype html><html><head>
<link rel="modulepreload" href="/_app/immutable/entry/start.ebe642fe.js">
<link rel="modulepreload" href="/_app/immutable/chunks/scheduler.8818e2a0.js">
<link rel="modulepreload" href="/_app/immutable/chunks/index.cc909c4f.js">
<link rel="modulepreload" href="/_app/immutable/chunks/singletons.5110c423.js">
<link rel="modulepreload" href="/_app/immutable/chunks/index.824a9edc.js">
<link rel="modulepreload" href="/_app/immutable/chunks/control.c2cf8273.js">
<link rel="modulepreload" href="/_app/immutable/chunks/preload-helper.a4192956.js">
</head><body><script type="module">import "/_app/immutable/entry/app.aca7a511.js";</script></body></html>`;

describe("L5 (audit v7, P3): shellBuildAssets regex fed the real entry/app.*.js shape", () => {
	it("parseShellDeps finds the root layout (0), error page (1), \"/\" (2) and home (10) dependencies", async () => {
		const { parseShellDeps } = await import("./service-worker");
		const found = parseShellDeps(REAL_HTML_FIXTURE, REAL_MANIFEST_FIXTURE, [ENTRY_APP, ENTRY_START]);
		expect(found).toContain(ENTRY_APP);
		expect(found).toContain(ENTRY_START);
		expect(found).toContain("/_app/immutable/chunks/0.a33a3ea1.js"); // node 0 only
		expect(found).toContain("/_app/immutable/chunks/viewport.7af7a1d2.js"); // node 10 (home) only
		expect(found).toContain("/_app/immutable/chunks/control.c2cf8273.js"); // node 2 ("/") only, also from HTML
		// K3: an unrelated route's node (e.g. "/(app)/explore" -> 7) must not be pulled in.
		expect(found.some((p) => p.includes("explore"))).toBe(false);
	});

	it("finds at least SHELL_MIN_ASSETS (20) on the real fixture - the guard must not fire on a healthy build", async () => {
		const { parseShellDeps, SHELL_MIN_ASSETS } = await import("./service-worker");
		const found = parseShellDeps(REAL_HTML_FIXTURE, REAL_MANIFEST_FIXTURE, [ENTRY_APP, ENTRY_START]);
		expect(found.length).toBeGreaterThanOrEqual(SHELL_MIN_ASSETS);
	});

	it("SHELL_MIN_ASSETS is 20 (the guard threshold the audit asked for)", async () => {
		const { SHELL_MIN_ASSETS } = await import("./service-worker");
		expect(SHELL_MIN_ASSETS).toBe(20);
	});

	it("a manifest format change (e.g. __vite__mapDeps) starves the regex down to just the entries + HTML refs", async () => {
		const { parseShellDeps } = await import("./service-worker");
		const mutatedManifest = REAL_MANIFEST_FIXTURE.replace(/import\("\.\.\/nodes\/\d+\.[^"]+"\),\[[^\]]*\]/g, "__vite__mapDeps([0,1])");
		const found = parseShellDeps(REAL_HTML_FIXTURE, mutatedManifest, [ENTRY_APP, ENTRY_START]);
		// Still gets the entries + whatever the HTML itself references, just not the node-dependency expansion.
		expect(found).toContain(ENTRY_APP);
		expect(found).toContain("/_app/immutable/chunks/control.c2cf8273.js"); // from the HTML, not the manifest
		expect(found).not.toContain("/_app/immutable/chunks/viewport.7af7a1d2.js"); // only the manifest knew about this one
	});
});

describe("shellCachesToDelete (DS1: keep the previous shell cache)", () => {
	it("keeps the current and the most recent previous shell, deletes older ones and ignores other caches", async () => {
		const { shellCachesToDelete } = await import("./service-worker");
		const keys = ["ytm-api", "ytm-shell-100", "ytm-shell-300", "ytm-offline-audio", "ytm-shell-200", "ytm-shell-400"];
		expect(shellCachesToDelete(keys, "ytm-shell-400").sort()).toEqual(["ytm-shell-100", "ytm-shell-200"]);
	});
	it("deletes nothing when only the current shell exists", async () => {
		const { shellCachesToDelete } = await import("./service-worker");
		expect(shellCachesToDelete(["ytm-shell-400", "ytm-api"], "ytm-shell-400")).toEqual([]);
	});
	it("on a rollback the newer cache is the one kept", async () => {
		const { shellCachesToDelete } = await import("./service-worker");
		expect(shellCachesToDelete(["ytm-shell-400", "ytm-shell-300", "ytm-shell-200"], "ytm-shell-300")).toEqual(["ytm-shell-200"]);
	});
	it("L10-3: keeps the last ACTIVE shell, not the highest build number (N, N+1, rollback N, N+2)", async () => {
		const { shellCachesToDelete } = await import("./service-worker");
		// Simulate the activate sequence: each SW reads the last active shell, then records its own.
		const N = "ytm-shell-100", N1 = "ytm-shell-200", N2 = "ytm-shell-300";
		let caches = [N];
		let last: string | null = null;
		const activate = (current: string) => {
			if (!caches.includes(current)) caches.push(current);
			const del = shellCachesToDelete(caches, current, last);
			caches = caches.filter((k) => !del.includes(k));
			last = current;
			return del;
		};
		expect(activate(N)).toEqual([]);
		expect(activate(N1)).toEqual([]); // upgrade: N kept for the tabs still on N
		expect(activate(N)).toEqual([]); // rollback: N+1 kept for the tabs opened on N+1
		expect(caches.sort()).toEqual([N, N1]);
		expect(activate(N2)).toEqual([N1]); // tabs run N (since the rollback): N kept, N+1 dropped
		expect(caches.sort()).toEqual([N, N2]);
	});
	it("L10-3: falls back to the highest number when the recorded shell is unknown, gone or the current one", async () => {
		const { shellCachesToDelete } = await import("./service-worker");
		const keys = ["ytm-shell-100", "ytm-shell-200", "ytm-shell-300"];
		expect(shellCachesToDelete(keys, "ytm-shell-300", null)).toEqual(["ytm-shell-100"]);
		expect(shellCachesToDelete(keys, "ytm-shell-300", "ytm-shell-050")).toEqual(["ytm-shell-100"]);
		expect(shellCachesToDelete(keys, "ytm-shell-300", "ytm-shell-300")).toEqual(["ytm-shell-100"]);
		expect(shellCachesToDelete(keys, "ytm-shell-300", "ytm-shell-100")).toEqual(["ytm-shell-200"]);
	});
});

describe("isHtmlForAsset (L10-4: the shell fallback is never stored as a chunk)", () => {
	it("flags an HTML answer for a script, stylesheet or font", async () => {
		const { isHtmlForAsset } = await import("./service-worker");
		expect(isHtmlForAsset("/_app/immutable/chunks/doesnotexist-abc123.js", "text/html; charset=UTF-8")).toBe(true);
		expect(isHtmlForAsset("/_app/immutable/assets/0.8ac991bc.css", "text/html")).toBe(true);
		expect(isHtmlForAsset("/_app/immutable/assets/commissioner-latin-wght-normal.956dca77.woff2", "TEXT/HTML")).toBe(true);
	});
	it("accepts the real content types and leaves HTML documents alone", async () => {
		const { isHtmlForAsset } = await import("./service-worker");
		expect(isHtmlForAsset("/_app/immutable/chunks/a.js", "application/javascript")).toBe(false);
		expect(isHtmlForAsset("/_app/immutable/chunks/a.js", "text/javascript; charset=utf-8")).toBe(false);
		expect(isHtmlForAsset("/_app/immutable/assets/a.css", "text/css")).toBe(false);
		expect(isHtmlForAsset("/_app/immutable/chunks/a.js", null)).toBe(false);
		expect(isHtmlForAsset("/", "text/html")).toBe(false);
		expect(isHtmlForAsset("/logo.svg", "text/html")).toBe(false);
	});
});
