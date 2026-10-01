/// <reference types="@sveltejs/kit" />
// PWA service worker: precache the app shell (installable + offline app load),
// network-first API with cache fallback (browsed library works offline; the
// profile-scoped /api/v1/me/* answers are never cached, see G16 below), and a
// dedicated audio cache ("ytm-offline-audio") that holds every track that was
// played or explicitly saved, served cache-first with proper Range support so
// the <audio> element plays it back when the device is offline.
//
// Audio entries are keyed by URL in the Cache API (that is what the <audio>
// element requests) but INDEXED BY videoId in the meta cache
// ("ytm-offline-meta": one index document /__ytm_index__ -> {videoId: {url,
// bytes, at, lastAccess, pinned, contentType}} read in one go (K9), plus one
// backup entry per track /__ytm_meta__/<videoId>). One videoId == one cached entry: re-caching under a new signed
// URL replaces the old entry, "already" is answered by videoId, and a request
// for /aud/<id> that misses by URL is served from the videoId's entry.
//
// Page <-> SW message contract (all via navigator.serviceWorker / postMessage):
//   page -> SW  { type: "cache-audio",     url, videoId?, pinned? }   (pinned: write the entry pinned, I15)
//   SW  -> page { type: "audio-cached",    url, videoId, ok, bytes, reason?, already?, cachedUrl? }
//                 reason "quota" = could not fit even after evicting the oldest entries
//                 reason "cancelled" = aborted by abort-audio (HL3 pack "Annuler")
//   page -> SW  { type: "abort-audio",     videoId?, url? }   (withdraws the sender's cache-audio; the fetch stops with its last waiter, L8-16)
//   SW  -> page { type: "audio-aborted",   videoId, url, ok }
//   page -> SW  { type: "uncache-audio",   url, videoId? }
//   SW  -> page { type: "audio-uncached",  url, ok }
//   page -> SW  { type: "is-cached",       videoId }
//   SW  -> page { type: "audio-is-cached", videoId, cached, url?, bytes? }
//   page -> SW  { type: "now-playing",     url?, videoId? }   (never evicted; no reply; persisted 30 min in the meta cache)
//   page -> SW  { type: "list-audio" }
//   SW  -> page { type: "audio-list",      entries: [{url, videoId, bytes, at, lastAccess, contentType, pinned}], total, pinnedBytes, quota }
//   page -> SW  { type: "set-audio-quota", bytes }          (<= 0 => unlimited)
//   SW  -> page { type: "audio-quota",     quota }
//   page -> SW  { type: "get-audio-quota" }
//   SW  -> page { type: "audio-quota",     quota }
//   page -> SW  { type: "pin-audio",       videoId, pinned }
//   SW  -> page { type: "audio-pinned",    videoId, pinned, ok, reason?, pinnedBytes?, quota? }
//                 reason "not_cached" = nothing to pin yet (download it first)
//                 reason "quota"      = pinned bytes would exceed the quota (raise it in Settings)
//
// A pin lives in two places so it survives a re-cache under another URL (G6):
// the X-YTM-Pinned header of the audio entry AND `pinned` in the meta index;
// cacheAudio carries it from the previous entry of the same videoId.
import { build, files, version } from "$service-worker";
import { SharedJobs } from "$lib/utils/sharedJobs";

const SHELL = `ytm-shell-${version}`;
const API_CACHE = "ytm-api";
const AUDIO_CACHE = "ytm-offline-audio";
const META_CACHE = "ytm-offline-meta";
const QUOTA_KEY = "/__ytm_audio_quota__";
const META_PREFIX = "/__ytm_meta__/";
const DEFAULT_QUOTA = 2 * 1024 * 1024 * 1024; // ~2 GiB
const ACCESS_THROTTLE_MS = 60_000; // lastAccess is rewritten at most once a minute per track

// K3 (audit perf v2): the install used to precache the WHOLE build (~150
// immutable files, 2.8 MB, 256 requests in the first 8 s of a first visit, in
// competition with the page). Now the install only takes the shell: "/", the
// static files, the two entry scripts and the chunks the shell HTML, the root
// layout (node 0), the root error page (node 1) and the home route pull in,
// read from the client manifest (entry/app.*.js carries every node's preload
// dependency list). The rest of `build` is filled after activation in batches
// of PRECACHE_BATCH every PRECACHE_BATCH_DELAY_MS (kept alive by the API
// fetches of the page) and on demand by the fetch handler, so a second,
// offline load still boots from the cache.
const IMMUTABLE = "/_app/immutable/";
const PRECACHE_BATCH = 10;
const PRECACHE_BATCH_DELAY_MS = 2000;
const BUILD_SET = new Set<string>(build);
const FILES_SET = new Set<string>(files);

// PF3-5 (audit perf v3): chunks loaded on demand only, never worth a
// background download: hls.js (~400 KB, imported lazily by player.ts for HLS
// streams) and the non-Latin Commissioner subsets (the French UI only uses
// the latin one; the browser fetches the others through unicode-range when a
// title needs them). They are still cached on the way by the fetch handler.
export function isOnDemandOnly(path: string): boolean {
	return (
		/^\/_app\/immutable\/chunks\/hls\.[^/]+\.js$/.test(path) ||
		/^\/_app\/immutable\/assets\/commissioner-(?:cyrillic|cyrillic-ext|greek|greek-ext|vietnamese|latin-ext)-[^/]*\.woff2?$/.test(path)
	);
}

// PF3-7: the install used to precache all ~35 static files (285 KB: every
// apple-touch / mstile / launcher size, duplicated favicons). Only what an
// offline boot or the PWA install prompt needs is taken now: the manifest,
// the favicons the shell HTML links, the logo the nav paints and the icons
// the manifest lists. The rest is cached on demand by the fetch handler.
// PF4-6 (audit perf v4): of the manifest icons, only the 192 and 512 sizes
// (launcher and maskable) are what installability needs; the 48-144
// launcher sizes (64 KB) are cached on demand like the other static files.
export function staticPrecacheList(all: readonly string[]): string[] {
	const wanted = (f: string) =>
		f === "/manifest.json" ||
		f === "/favicon.ico" ||
		f === "/logo.svg" ||
		/^\/assets\/favicon-\d+x\d+\.png$/.test(f) ||
		/^\/android\/android-launchericon-(?:192-192|512-512)\.png$/.test(f) ||
		/^\/maskable-icon-(?:192x192|512x512)\.png$/.test(f);
	return all.filter(wanted);
}

/**
 * DS1: shell caches to delete at activate: every `ytm-shell-*` except the current one
 * and ONE previous one, so pages of the other build keep resolving their chunks during
 * an upgrade or a rollback.
 * L10-3: the previous one kept is the shell that was ACTIVE before this activation
 * (`lastActive`, recorded by every SW at its own activation), i.e. the build the open
 * tabs are running. Build timestamps are not the deploy order: after N -> N+1 -> rollback
 * N -> N+2, the highest number is N+1 (no tab runs it) while the tabs run N. The highest
 * numeric version is only the fallback when nothing (or nothing usable) was recorded.
 */
export function shellCachesToDelete(keys: readonly string[], current: string, lastActive?: string | null): string[] {
	const others = keys.filter((k) => k.startsWith("ytm-shell-") && k !== current);
	if (lastActive && lastActive !== current && others.includes(lastActive)) return others.filter((k) => k !== lastActive);
	const ver = (k: string) => Number(k.slice("ytm-shell-".length)) || 0;
	others.sort((a, b) => ver(b) - ver(a));
	return others.slice(1);
}

// L10-3: name of the shell cache of the last SW that activated (META_CACHE, outside
// META_PREFIX so the offline index ignores it).
const LAST_SHELL_KEY = "/__ytm_last_shell__";
async function swapLastActiveShell(): Promise<string | null> {
	try {
		const m = await caches.open(META_CACHE);
		let prev: string | null = null;
		const r = await m.match(LAST_SHELL_KEY);
		if (r) prev = (await r.text()).trim() || null;
		await m.put(LAST_SHELL_KEY, new Response(SHELL, { headers: { "Content-Type": "text/plain" } }));
		return prev;
	} catch {
		return null;
	}
}

// PF4-6: "/" and the install's static files are not content-hashed, so a
// deploy used to download them all again (14 requests, ~140 KB per device).
// They are now carried from the previous shell cache like the hashed assets,
// but revalidated before use: a conditional request answers 304 (no body)
// when the file is unchanged (the Go server sends a content ETag on every
// non-hashed build file, static_etag.go) and the new file otherwise. Pure:
// which of the install's non-hashed paths an old cache can provide.
export function carryOverStaticPaths(oldPaths: Iterable<string>, wanted: readonly string[], have: ReadonlySet<string>): string[] {
	const old = new Set<string>(oldPaths);
	return [...new Set(wanted)].filter((p) => !p.startsWith(IMMUTABLE) && old.has(p) && !have.has(p));
}

// Pure: the conditional request headers revalidating a cached response
// (ETag first; Last-Modified only when there is no ETag, the build sets
// every mtime to the build time so it alone never matches across deploys).
// null: nothing to revalidate with, the file is downloaded again.
export function conditionalHeaders(headers: { get(name: string): string | null }): Record<string, string> | null {
	const etag = headers.get("ETag");
	if (etag) return { "If-None-Match": etag };
	const lm = headers.get("Last-Modified");
	if (lm) return { "If-Modified-Since": lm };
	return null;
}

// Carry "/" and the static files of `wanted` from the most recent older
// shell cache into `c`, each revalidated (best effort, never throws): 304 ->
// the old copy, 200 -> the new file, network error -> the old copy (an
// offline boot still works), anything else -> nothing (addIfMissing then
// tries the plain download).
async function carryOverStatics(c: Cache, wanted: readonly string[]): Promise<number> {
	let reused = 0;
	try {
		const names = (await caches.keys()).filter((k) => k.startsWith("ytm-shell-") && k !== SHELL);
		if (!names.length) return 0;
		const ver = (k: string) => Number(k.slice("ytm-shell-".length)) || 0;
		names.sort((a, b) => ver(b) - ver(a));
		const old = await caches.open(names[0]);
		const byPath = new Map<string, Request>();
		for (const k of await old.keys()) byPath.set(new URL(k.url).pathname, k);
		const have = new Set((await c.keys()).map((k) => new URL(k.url).pathname));
		await Promise.all(
			carryOverStaticPaths(byPath.keys(), wanted, have).map(async (p) => {
				try {
					const prev = await old.match(byPath.get(p)!);
					if (!prev || !prev.ok) return;
					const cond = conditionalHeaders(prev.headers);
					if (!cond) return;
					let res: Response;
					try {
						res = await fetch(p, { headers: cond, cache: "no-store" });
					} catch {
						await c.put(p, prev);
						return;
					}
					if (res.status === 304) {
						await c.put(p, prev);
						reused++;
					} else if (res.ok && res.status === 200 && !isHtmlForAsset(p, res.headers.get("Content-Type"))) {
						await c.put(p, res);
					}
				} catch {
					/* skip this entry */
				}
			}),
		);
	} catch {
		/* best effort */
	}
	return reused;
}

// PF3-5: a deploy gives the SW a new SHELL cache name; hashed immutable
// assets whose path is unchanged are byte-identical, so they are copied from
// the previous ytm-shell-* cache instead of being downloaded again. Pure:
// which paths of an old cache to carry into the new one.
/**
 * L10-4: a missing build file used to come back as the SPA shell (200 text/html,
 * immutable for a year). An HTML body is never a valid answer for a script,
 * stylesheet or font: such a response must not be stored in the shell cache
 * (it would be served as that asset for the whole life of the build).
 */
export function isHtmlForAsset(pathname: string, contentType: string | null): boolean {
	if (!/\.(?:m?js|css|woff2?|json|map)$/i.test(pathname)) return false;
	return /^\s*text\/html\b/i.test(contentType ?? "");
}

export function carryOverPaths(oldPaths: Iterable<string>, buildSet: ReadonlySet<string>, have: ReadonlySet<string>): string[] {
	const out = new Set<string>();
	for (const p of oldPaths) {
		if (!p.startsWith(IMMUTABLE)) continue; // "/" and static files are not content-hashed
		if (!buildSet.has(p) || have.has(p)) continue;
		out.add(p);
	}
	return [...out];
}

// Copy the still-valid hashed entries of every older ytm-shell-* cache into
// SHELL (best effort, never throws).
async function carryOverShell(): Promise<number> {
	let copied = 0;
	try {
		const names = (await caches.keys()).filter((k) => k.startsWith("ytm-shell-") && k !== SHELL);
		if (!names.length) return 0;
		const c = await caches.open(SHELL);
		const have = new Set((await c.keys()).map((k) => new URL(k.url).pathname));
		for (const name of names) {
			const old = await caches.open(name);
			const byPath = new Map<string, Request>();
			for (const k of await old.keys()) byPath.set(new URL(k.url).pathname, k);
			for (const p of carryOverPaths(byPath.keys(), BUILD_SET, have)) {
				try {
					const res = await old.match(byPath.get(p)!);
					if (!res || !res.ok) continue;
					await c.put(p, res);
					have.add(p);
					copied++;
				} catch {
					/* skip this entry */
				}
			}
		}
	} catch {
		/* best effort */
	}
	return copied;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Cache one shell asset unless it is already there; a failing asset must not
// abort the precache (which would leave the PWA unable to boot offline).
async function addIfMissing(c: Cache, path: string): Promise<boolean> {
	try {
		if (await c.match(path)) return true;
		const res = await fetch(path);
		// Same contract as Cache.add (non-2xx rejects) plus L10-4: never an HTML body for an asset.
		if (!res.ok || isHtmlForAsset(path, res.headers.get("Content-Type"))) return false;
		await c.put(path, res);
		return true;
	} catch {
		return false; // L4: the caller decides whether a partial precache still "finished"
	}
}

async function cachedText(c: Cache, path: string): Promise<string> {
	try {
		await addIfMissing(c, path);
		const r = await c.match(path);
		return r ? await r.text() : "";
	} catch {
		return "";
	}
}

// The build paths the shell needs on a cold, offline boot of "/" or "/home".
// L5 (audit v7, P3): the regex extraction below is pulled out as a pure
// function (no Cache/SW API) so it can be unit-tested against a real Vite/
// SvelteKit `entry/app.*.js` manifest shape (see service-worker.shell.test.ts)
// without spinning up a service worker. A Vite/SvelteKit version bump can
// change that format (e.g. a `__vite__mapDeps([0,1])` index into a shared
// array instead of a literal per-node path array) and silently starve it.
export function parseShellDeps(html: string, manifest: string, entryPaths: string[]): string[] {
	const out = new Set<string>(entryPaths);
	for (const m of html.matchAll(/\/_app\/immutable\/[^"'\s)]+/g)) out.add(m[0]);
	if (manifest) {
		// node id -> preload dependencies: n(()=>import("../nodes/<id>.x.js"),["../nodes/…","../chunks/…",…])
		const deps = new Map<number, string[]>();
		for (const m of manifest.matchAll(/import\("\.\.\/nodes\/(\d+)\.[^"]+"\),\[([^\]]*)\]/g)) {
			deps.set(
				Number(m[1]),
				[...m[2].matchAll(/"\.\.\/([^"]+)"/g)].map((d) => IMMUTABLE + d[1]),
			);
		}
		// route dictionary: "/":[2], "/(app)/home":[10], …
		const wanted = new Set<number>([0, 1]);
		for (const m of manifest.matchAll(/"([^"]*)":\[([^\]]*)\]/g)) {
			if (m[1] !== "/" && !/\/home$/.test(m[1])) continue;
			for (const n of m[2].matchAll(/\d+/g)) wanted.add(Number(n[0]));
		}
		for (const id of wanted) for (const d of deps.get(id) || []) out.add(d);
	}
	return [...out];
}

// Below this count of matched shell assets, the regex above is considered to
// have (likely) starved on a manifest-format change: fall back instead of
// silently shipping a near-empty shell.
export const SHELL_MIN_ASSETS = 20;

async function shellBuildAssets(c: Cache): Promise<string[]> {
	const entries = build.filter((p) => p.startsWith(IMMUTABLE + "entry/"));
	const html = await cachedText(c, "/");
	const app = entries.find((p) => /\/entry\/app\.[^/]+\.js$/.test(p));
	const manifest = app ? await cachedText(c, app) : "";
	const found = parseShellDeps(html, manifest, entries).filter((p) => BUILD_SET.has(p));
	if (found.length >= SHELL_MIN_ASSETS) return found;
	// Fallback: every entry/* (always needed) plus every chunks/* the root
	// HTML itself references (not the whole build - K3 deliberately keeps the
	// install small; precacheRest still fills the rest in the background).
	console.warn(`[sw] shellBuildAssets matched only ${found.length} assets (< ${SHELL_MIN_ASSETS}); falling back to entry/* + chunks/* referenced by the HTML`);
	const fallback = new Set<string>(entries);
	for (const m of html.matchAll(/\/_app\/immutable\/(?:entry|chunks)\/[^"'\s)]+/g)) fallback.add(m[0]);
	return [...fallback].filter((p) => BUILD_SET.has(p));
}

// The deferred precache of everything else in `build`, once per SW lifetime
// (restarted lazily by the next trigger if the SW was stopped mid-way).
let restPrecache: Promise<void> | null = null;
let restDone = false;
function precacheRest(): Promise<void> {
	if (restDone) return Promise.resolve();
	if (!restPrecache) {
		restPrecache = (async () => {
			const c = await caches.open(SHELL);
			const have = new Set((await c.keys()).map((k) => new URL(k.url).pathname));
			const todo = build.filter((p) => !have.has(p) && !isOnDemandOnly(p));
			let allOk = true;
			for (let i = 0; i < todo.length; i += PRECACHE_BATCH) {
				if (i) await sleep(PRECACHE_BATCH_DELAY_MS);
				const results = await Promise.all(todo.slice(i, i + PRECACHE_BATCH).map((p) => addIfMissing(c, p)));
				if (results.some((ok) => !ok)) allOk = false;
			}
			// L4 (audit v7, P3): `addIfMissing` used to never fail (it swallowed
			// every error), so `restDone` was set unconditionally even after a
			// network drop mid-install left most of `build` un-cached - for the
			// rest of this SW's lifetime (hours on desktop). Only a fully
			// successful pass may mark it done; a partial one retries (the
			// batches already cached are skipped via `have`/`c.match`) on the
			// next trigger (the next API fetch that keeps this SW alive).
			if (allOk) restDone = true;
			else restPrecache = null;
		})().catch(() => {
			restPrecache = null;
		});
	}
	return restPrecache;
}

// Response headers we stamp on every cached audio entry (used by list-audio + LRU).
const H_BYTES = "X-YTM-Bytes";
const H_VIDEO = "X-YTM-VideoId";
const H_AT = "X-YTM-Cached-At";
const H_PINNED = "X-YTM-Pinned"; // "1" = pinned by the user, never evicted by the LRU

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(SHELL).then(async (c) => {
			// PF3-5: unchanged hashed assets come from the previous shell cache.
			await carryOverShell();
			// PF4-6: "/" and the static files too, revalidated (304 when
			// unchanged); "/" before shellBuildAssets reads it.
			const statics = ["/", ...staticPrecacheList(files)];
			await carryOverStatics(c, statics);
			// Shell only (K3): "/", the static files an offline boot needs
			// (PF3-7) and the build assets the shell / root layout / home route
			// need; each cached independently.
			const shell = await shellBuildAssets(c);
			await Promise.all([...new Set<string>([...statics, ...shell])].map((a) => addIfMissing(c, a)));
			await self.skipWaiting();
		}).catch(() => {}),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			// PF3-5: entries the old SW cached after this one installed.
			await carryOverShell();
			// DS1 (deploy survives): keep the PREVIOUS shell cache. A page of the
			// other build can still be open (upgrade: old page alive while this SW activates;
			// rollback: new page alive while the old SW comes back) and its lazy chunks are
			// not on the server any more: they must keep resolving from that cache.
			// L10-3: "previous" = the shell of the SW that was active before this one.
			const lastActive = await swapLastActiveShell();
			const keys = await caches.keys();
			await Promise.all(shellCachesToDelete(keys, SHELL, lastActive).map((k) => caches.delete(k)));
			await purgeProfileScopedApiCache(); // G16: entries stored by an older SW
			await self.clients.claim();
			// K3: the rest of the build, in batches, without delaying activation
			// (a pending activate waitUntil would hold every fetch of the page).
			void precacheRest();
		})(),
	);
});

// Profile-scoped API (favorites, follows, history, stats, mix, playlists): the
// backend keys them by the `bbp` profile cookie. The SW cannot read that cookie
// (no document.cookie, the Cookie header is not exposed on fetch events and
// self.cookieStore is Chromium-only), so keying the cache by profile is not
// reliably possible; and even keyed, the previous profile's favorites would stay
// on the disk of a shared device. Safer option (G16): never cache these, and
// purge any entry an older SW stored (activate). Offline, they answer
// {"offline":true} like any uncached API call.
const isProfileScopedApi = (u: URL) => u.pathname.startsWith("/api/v1/me/");
async function purgeProfileScopedApiCache(): Promise<void> {
	try {
		const c = await caches.open(API_CACHE);
		const keys = await c.keys();
		await Promise.all(keys.filter((k) => isProfileScopedApi(new URL(k.url))).map((k) => c.delete(k)));
		await pruneApiCache(c);
	} catch {
		/* best effort */
	}
}

// K15 (audit perf v2): the API cache was unbounded (every search.json, 605 KB
// raw, went in). Answers above API_MAX_BYTES are not stored; the cache is
// capped at API_MAX_ENTRIES, the oldest entries (Cache API keys are in
// insertion order) pruned at activate and every API_PRUNE_EVERY puts.
//
// L3 (audit v7, P3): `apiPuts` only lived in memory, so on Android - where the
// browser stops the SW after ~30s idle - a session rarely reaches
// API_PRUNE_EVERY puts before being restarted with the counter back at 0;
// between two SW *versions* (the only other prune point, at activate) the
// cache could then grow unbounded in time even though no single put ever
// crossed the limit. Pruning once more at the FIRST put of each SW lifetime
// closes that gap cheaply (one keys() call, ≤ ~250 entries).
const API_MAX_BYTES = 300 * 1024;
const API_MAX_ENTRIES = 200;
const API_PRUNE_EVERY = 50;
let apiPuts = 0;
async function pruneApiCache(c: Cache): Promise<void> {
	try {
		const keys = await c.keys();
		const extra = keys.length - API_MAX_ENTRIES;
		if (extra <= 0) return;
		await Promise.all(keys.slice(0, extra).map((k) => c.delete(k)));
	} catch {
		/* best effort */
	}
}
async function putApiResponse(c: Cache, req: Request, res: Response): Promise<void> {
	try {
		const declared = Number(res.headers.get("Content-Length"));
		if (declared > API_MAX_BYTES) return;
		const body = await res.arrayBuffer();
		if (body.byteLength > API_MAX_BYTES) return;
		// The body is already decoded: drop the transfer headers of the network answer.
		const headers = new Headers(res.headers);
		headers.delete("Content-Encoding");
		headers.delete("Content-Length");
		await c.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers }));
		apiPuts++;
		if (apiPuts === 1 || apiPuts % API_PRUNE_EVERY === 0) await pruneApiCache(c);
	} catch {
		/* best effort */
	}
}

// Audio (and cover) endpoints served by our own origin (lane A1 makes them
// relative: /localf?p=…, /vp?u=…, /aud/<id>, /cover?lid=…) plus the legacy
// absolute ytify/invidious/googlevideo forms still seen during the transition.
const isAudio = (u: URL) =>
	/\/(localf|vp|cover|aud)\b/.test(u.pathname) || /googlevideo|videoplayback/.test(u.href);

// ---------------------------------------------------------------------------
// Meta index: videoId -> {url, bytes, at, lastAccess}
// ---------------------------------------------------------------------------

type Meta = { url: string; bytes: number; at: number; lastAccess: number; pinned?: boolean; contentType?: string };

function metaKey(videoId: string): string {
	return META_PREFIX + encodeURIComponent(videoId);
}

// K9 (audit perf v2): one index document (INDEX_KEY -> {videoId: Meta}) is
// the read path: loaded once per SW lifetime into memory, written through by
// setMeta / deleteMeta (serialised, last write wins), read in one go by
// allMeta / listEntries. The per-videoId /__ytm_meta__/<id> entries are kept
// as the backup copy and are the migration source when the index is absent
// (older SW): the first load enumerates them once and writes the index.
const INDEX_KEY = "/__ytm_index__";
let indexMem: Map<string, Meta> | null = null;
let indexLoad: Promise<Map<string, Meta>> | null = null;
let indexWrite: Promise<void> = Promise.resolve();

async function enumerateMeta(m: Cache): Promise<Map<string, Meta>> {
	const out = new Map<string, Meta>();
	try {
		const keys = await m.keys();
		for (const k of keys) {
			const p = new URL(k.url).pathname;
			if (!p.startsWith(META_PREFIX)) continue;
			const r = await m.match(k);
			if (!r) continue;
			try {
				const v = await r.json();
				if (v && typeof v.url === "string") out.set(decodeURIComponent(p.slice(META_PREFIX.length)), v as Meta);
			} catch {
				/* skip corrupt meta */
			}
		}
	} catch {
		/* ignore */
	}
	return out;
}
function writeIndex(m: Cache, map: Map<string, Meta>): Promise<void> {
	return m.put(INDEX_KEY, new Response(JSON.stringify(Object.fromEntries(map)), { headers: { "Content-Type": "application/json" } }));
}
function loadIndex(): Promise<Map<string, Meta>> {
	if (indexMem) return Promise.resolve(indexMem);
	if (!indexLoad) {
		indexLoad = (async () => {
			const m = await caches.open(META_CACHE);
			let map: Map<string, Meta> | null = null;
			try {
				const r = await m.match(INDEX_KEY);
				const j = r ? await r.json() : null;
				if (j && typeof j === "object" && !Array.isArray(j)) {
					map = new Map();
					for (const [id, v] of Object.entries(j as Record<string, unknown>)) {
						if (v && typeof (v as Meta).url === "string") map.set(id, v as Meta);
					}
				}
			} catch {
				map = null;
			}
			if (!map) {
				map = await enumerateMeta(m); // migration from the per-videoId entries
				await writeIndex(m, map).catch(() => {});
			}
			indexMem = map;
			return map;
		})().catch(async () => {
			indexLoad = null; // retried by the next call; meanwhile read the entries directly
			return enumerateMeta(await caches.open(META_CACHE));
		});
	}
	return indexLoad;
}
function persistIndex(): Promise<void> {
	const map = indexMem;
	if (!map) return Promise.resolve();
	indexWrite = indexWrite.then(async () => writeIndex(await caches.open(META_CACHE), map)).catch(() => {});
	return indexWrite;
}

async function getMeta(videoId: string): Promise<Meta | null> {
	if (!videoId) return null;
	try {
		return (await loadIndex()).get(videoId) ?? null;
	} catch {
		return null;
	}
}
async function setMeta(videoId: string, meta: Meta): Promise<void> {
	if (!videoId) return;
	try {
		const map = await loadIndex();
		map.set(videoId, meta);
		const m = await caches.open(META_CACHE);
		await m.put(metaKey(videoId), new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
		await persistIndex();
	} catch {
		/* meta is best-effort: the audio entry itself still carries its headers */
	}
}
async function deleteMeta(videoId: string): Promise<void> {
	if (!videoId) return;
	try {
		const map = await loadIndex();
		map.delete(videoId);
		const m = await caches.open(META_CACHE);
		await m.delete(metaKey(videoId));
		await persistIndex();
	} catch {
		/* ignore */
	}
}
async function allMeta(): Promise<Map<string, Meta>> {
	try {
		return new Map(await loadIndex());
	} catch {
		return new Map();
	}
}
// Which cached entry (if any) holds this videoId: the meta URL must still be in
// the audio cache (Cache API evictions do not touch the meta cache).
async function cachedForVideo(c: Cache, videoId: string): Promise<{ meta: Meta; hit: Response } | null> {
	const meta = await getMeta(videoId);
	if (!meta) return null;
	const hit = await c.match(meta.url, { ignoreMethod: true });
	if (!hit || hit.type === "opaque" || hit.status !== 200) {
		await deleteMeta(videoId);
		return null;
	}
	return { meta, hit };
}

const lastTouched = new Map<string, number>();
function touch(videoId: string, meta: Meta | null): void {
	if (!videoId) return;
	const now = Date.now();
	const prev = lastTouched.get(videoId) || 0;
	if (now - prev < ACCESS_THROTTLE_MS) return;
	lastTouched.set(videoId, now);
	void (async () => {
		const m = meta || (await getMeta(videoId));
		if (m) await setMeta(videoId, { ...m, lastAccess: now });
		// Still being served = still playing: keep the persisted copy fresh (G15).
		if (nowPlaying.videoId && nowPlaying.videoId === videoId) await persistNowPlaying();
	})();
}

// ---------------------------------------------------------------------------
// Range-aware serving from the audio cache
// ---------------------------------------------------------------------------

function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)/i.exec(header.trim());
	if (!m) return "invalid";
	const [, a, b] = m;
	let start: number;
	let end: number;
	if (a === "" && b === "") return "invalid";
	if (a === "") {
		// suffix range: last N bytes
		const n = parseInt(b, 10);
		if (!(n > 0)) return "invalid";
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		start = parseInt(a, 10);
		end = b === "" ? size - 1 : Math.min(parseInt(b, 10), size - 1);
	}
	if (!(start >= 0) || start >= size || end < start) return "invalid";
	return { start, end };
}

// Builds the response for `req` from a cached full (200) audio response:
// 206 sliced from the cached body when the request carries Range, otherwise
// the full 200; HEAD returns headers only. Opaque entries (legacy no-cors
// cross-origin, unreadable) are returned untouched.
async function serveFromCache(hit: Response, req: Request): Promise<Response> {
	if (hit.type === "opaque" || hit.status !== 200) return hit;
	const blob = await hit.clone().blob();
	const size = blob.size;
	const type = hit.headers.get("Content-Type") || blob.type || "application/octet-stream";
	const baseHeaders: Record<string, string> = {
		"Content-Type": type,
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-store",
		"X-YTM-Offline": "1",
	};
	const range = parseRange(req.headers.get("Range"), size);
	if (range === "invalid") {
		return new Response(null, {
			status: 416,
			statusText: "Range Not Satisfiable",
			headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
		});
	}
	if (range) {
		const { start, end } = range;
		const len = end - start + 1;
		const headers = {
			...baseHeaders,
			"Content-Range": `bytes ${start}-${end}/${size}`,
			"Content-Length": String(len),
		};
		return new Response(req.method === "HEAD" ? null : blob.slice(start, end + 1, type), {
			status: 206,
			statusText: "Partial Content",
			headers,
		});
	}
	const headers = { ...baseHeaders, "Content-Length": String(size) };
	return new Response(req.method === "HEAD" ? null : blob, { status: 200, headers });
}

// Stable identity of an audio request beyond its exact URL: /aud/<videoId>
// carries the videoId in its path; /localf?p=<path> is stable by itself
// (matched on pathname+search, host-independent).
function videoIdFromUrl(url: URL): string {
	const m = /^\/aud\/([^/?#]+)/.exec(url.pathname);
	return m ? decodeURIComponent(m[1]) : "";
}

async function matchAudio(c: Cache, req: Request, url: URL): Promise<Response | undefined> {
	const byUrl = (await c.match(req, { ignoreMethod: true })) || (await c.match(url.pathname + url.search, { ignoreMethod: true }));
	if (byUrl) {
		touch(byUrl.headers.get(H_VIDEO) || "", null);
		return byUrl;
	}
	// Miss by URL: try the stable identity (videoId) recorded in the meta index.
	const vid = videoIdFromUrl(url);
	if (vid) {
		const found = await cachedForVideo(c, vid);
		if (found) {
			touch(vid, found.meta);
			return found.hit;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// BEGIN ytm-covers (lane c25b, K2): /cover?lid=… cache-first, bounded LRU.
// A cover is addressed by a stable lid and the backend now stamps a one-week
// immutable Cache-Control on its 200s; the home page requests ~22 of them
// (p50 ~500 ms each) and the audio cache never stored them. Cache-first in a
// dedicated cache, capped at COVER_MAX entries: Cache API keys() returns the
// entries in insertion order, so deleting the first ones is a simple LRU
// (a hit is re-put to move it to the end).
// ---------------------------------------------------------------------------
const COVER_CACHE = "ytm-covers";
const COVER_MAX = 200;
const isCover = (u: URL) => u.origin === location.origin && u.pathname === "/cover" && u.searchParams.has("lid");

// L1 (audit v7, P2): a HIT used to be a delete+put of the full image (up to
// 1 MB, uncropped `/cover`) on EVERY access - 22 disk rewrites per home load
// - and let two concurrent <img> requests for the same cover (same album in
// "Recents" and "Pour toi") interleave delete(A)/match(B) into a transient
// miss. True recency is now tracked in memory; the cache's physical,
// insertion-ordered entry is only refreshed (re-put) at most once per
// COVER_TOUCH_THROTTLE_MS for a given url, so a repeat view of the same
// home page does no disk writes at all. Pruning prefers this in-memory
// recency (an entry hit often but throttled out of reinsertion must not
// look "oldest"); keys() insertion order is only the fallback for an entry
// this SW lifetime never saw a hit for.
const COVER_TOUCH_THROTTLE_MS = 10 * 60 * 1000;
const coverLastHit = new Map<string, number>();

// PF3-11: trimCoverCache enumerates the whole cache (keys() + sort); it ran
// after every put (15-22 per cold home). Now on the first put of each SW
// lifetime (Android restarts the SW often, so an in-memory counter alone
// would let the cache grow) and then every COVER_TRIM_EVERY puts; COVER_MAX
// may be exceeded by at most COVER_TRIM_EVERY - 1 entries in between.
const COVER_TRIM_EVERY = 25;
let coverPuts = 0;
export function coverTrimDue(putsSoFar: number, every = COVER_TRIM_EVERY): boolean {
	return putsSoFar === 1 || (putsSoFar > 1 && putsSoFar % every === 0);
}
function shouldTrimCovers(): boolean {
	coverPuts++;
	return coverTrimDue(coverPuts);
}

async function trimCoverCache(c: Cache): Promise<void> {
	try {
		const keys = await c.keys();
		const excess = keys.length - COVER_MAX;
		if (excess <= 0) return;
		const byRecency = [...keys].sort((a, b) => (coverLastHit.get(a.url) ?? 0) - (coverLastHit.get(b.url) ?? 0));
		for (let i = 0; i < excess; i++) {
			await c.delete(byRecency[i]);
			coverLastHit.delete(byRecency[i].url);
		}
	} catch {
		/* best effort */
	}
}

// PF3-1: a lid without embedded art answers 404 after 0.5-6 s upstream and
// was asked again on every view. Its URL is remembered COVER_MISS_TTL_MS in a
// bounded in-memory set and answered locally meanwhile (the Go proxy also
// stamps those 404s cacheable for an hour). Pure, unit-tested.
const COVER_MISS_TTL_MS = 60 * 60 * 1000;
const COVER_MISS_MAX = 500;
export function createCoverMissSet(max = COVER_MISS_MAX, ttlMs = COVER_MISS_TTL_MS) {
	const until = new Map<string, number>(); // insertion order = oldest first
	return {
		has(url: string, now = Date.now()): boolean {
			const t = until.get(url);
			if (t === undefined) return false;
			if (now >= t) {
				until.delete(url);
				return false;
			}
			return true;
		},
		add(url: string, now = Date.now()): void {
			until.delete(url);
			until.set(url, now + ttlMs);
			while (until.size > max) {
				const oldest = until.keys().next().value as string;
				until.delete(oldest);
			}
		},
		delete(url: string): void {
			until.delete(url);
		},
		get size(): number {
			return until.size;
		},
	};
}
const coverMisses = createCoverMissSet();
const coverMissResponse = () =>
	new Response("no art", {
		status: 404,
		headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=3600", "X-Ytm-Cover": "sw-miss" },
	});

async function coverFetch(req: Request): Promise<Response> {
	let c: Cache | null = null;
	try {
		c = await caches.open(COVER_CACHE);
		const hit = await c.match(req.url);
		if (hit) {
			const now = Date.now();
			const last = coverLastHit.get(req.url) || 0;
			coverLastHit.set(req.url, now); // true recency, updated on every hit
			if (now - last > COVER_TOUCH_THROTTLE_MS) {
				// Re-insert at the end of keys() so the physical LRU keeps it
				// (clone before the body of `hit` is handed to the page and locked).
				const copy = hit.clone();
				c.delete(req.url)
					.then(() => c!.put(req.url, copy))
					.catch(() => {});
			}
			return hit;
		}
	} catch {
		c = null;
	}
	if (coverMisses.has(req.url)) return coverMissResponse();
	const res = await fetch(req);
	if (res.status === 404) coverMisses.add(req.url);
	if (c && res.ok && res.status === 200 && req.method === "GET") {
		coverLastHit.set(req.url, Date.now());
		const copy = res.clone();
		c.put(req.url, copy)
			.then(() => (shouldTrimCovers() ? trimCoverCache(c!) : undefined))
			.catch(() => {});
	}
	return res;
}
// ---------------------------------------------------------------------------
// END ytm-covers
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
	const req = event.request;
	let url: URL;
	try {
		url = new URL(req.url);
	} catch {
		return;
	}

	// BEGIN ytm-covers branch (c25b, K2): before isAudio, whose regex also matches /cover
	if (req.method === "GET" && isCover(url)) {
		event.respondWith(coverFetch(req));
		return;
	}
	// END ytm-covers branch

	// offline-cached audio + covers → cache-first (served when offline), Range-aware
	if (isAudio(url) && (req.method === "GET" || req.method === "HEAD")) {
		event.respondWith(
			(async () => {
				const c = await caches.open(AUDIO_CACHE);
				const hit = await matchAudio(c, req, url);
				if (hit) {
					try {
						return await serveFromCache(hit, req);
					} catch {
						/* fall through to network */
					}
				}
				try {
					return await fetch(req);
				} catch {
					return hit || Response.error();
				}
			})(),
		);
		return;
	}

	if (req.method !== "GET") return;

	// app-shell assets → cache-first; a miss (not yet precached, K3) is fetched
	// and stored on the way so the next offline boot has it.
	// Any hashed /_app/immutable/ asset is looked up across every cache (caches.match),
	// so a chunk of the previous build still answers from the kept previous shell cache.
	if (url.origin === location.origin && (BUILD_SET.has(url.pathname) || FILES_SET.has(url.pathname) || url.pathname.startsWith(IMMUTABLE))) {
		event.respondWith(
			(async () => {
				const hit = await caches.match(req);
				if (hit) return hit;
				const res = await fetch(req);
				// PF3-7: static files are no longer all precached; keep the ones
				// fetched so the next offline boot has them (own build / static files only).
				// L10-4: an HTML body for a .js/.css request is the shell fallback of a
				// missing file: returned as is, never stored.
				if (
					res.ok &&
					res.status === 200 &&
					(BUILD_SET.has(url.pathname) || FILES_SET.has(url.pathname)) &&
					!isHtmlForAsset(url.pathname, res.headers.get("Content-Type"))
				) {
					const copy = res.clone();
					event.waitUntil(caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {}));
				}
				return res;
			})(),
		);
		return;
	}

	// API GET → network-first, fall back to last cached (browsed data offline).
	// Profile-scoped answers (/api/v1/me/*) are NEVER cached nor replayed (G16).
	if (url.pathname.startsWith("/api/")) {
		const profileScoped = isProfileScopedApi(url);
		// K3: an API call means the page is up; the deferred precache may run
		// now, kept alive by this event (idempotent, one run per SW lifetime).
		if (!restDone) event.waitUntil(precacheRest());
		event.respondWith(
			(async () => {
				const c = await caches.open(API_CACHE);
				try {
					const res = await fetch(req);
					// Only JSON is an API answer worth replaying offline: an HTML shell
					// (SPA fallback for an unknown path) must never be cached as data.
					if (!profileScoped && res.ok && /json/i.test(res.headers.get("Content-Type") || "")) {
						event.waitUntil(putApiResponse(c, req, res.clone())); // K15: bounded
					}
					return res;
				} catch {
					const hit = profileScoped ? undefined : await c.match(req);
					return hit || new Response('{"offline":true}', { headers: { "Content-Type": "application/json" } });
				}
			})(),
		);
		return;
	}

	// navigations → network-first, fall back to cached shell ("/")
	if (req.mode === "navigate") {
		event.respondWith(
			(async () => {
				try {
					return await fetch(req);
				} catch {
					const c = await caches.open(SHELL);
					return (await c.match("/")) || (await c.match(req)) || Response.error();
				}
			})(),
		);
		return;
	}
});

// ---------------------------------------------------------------------------
// Audio cache management (messages from the page)
// ---------------------------------------------------------------------------

const AUDIO_TYPE = /^(audio\/|video\/(webm|mp4|ogg)|application\/(octet-stream|ogg|x-mpegurl)?$)/i;

function isAudioContentType(ct: string | null): boolean {
	if (!ct) return false;
	const mime = ct.split(";")[0].trim().toLowerCase();
	if (mime.startsWith("text/") || mime.includes("html") || mime.includes("json")) return false;
	return AUDIO_TYPE.test(mime);
}

async function getQuota(): Promise<number> {
	try {
		const m = await caches.open(META_CACHE);
		const r = await m.match(QUOTA_KEY);
		if (!r) return DEFAULT_QUOTA;
		const v = Number(await r.text());
		return Number.isFinite(v) ? v : DEFAULT_QUOTA;
	} catch {
		return DEFAULT_QUOTA;
	}
}
async function setQuota(bytes: number): Promise<number> {
	const q = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0; // 0 => unlimited
	const m = await caches.open(META_CACHE);
	await m.put(QUOTA_KEY, new Response(String(q), { headers: { "Content-Type": "text/plain" } }));
	return q;
}

type Entry = { url: string; videoId: string; bytes: number; at: number; lastAccess: number; contentType: string; pinned: boolean };

// Every audio entry with its size, cached-at and last-access times. K9: one
// `c.keys()` plus the in-memory index answer every entry the index knows
// (url, bytes and contentType recorded); only an entry the index does not
// cover (legacy, no videoId, index written by an older SW without
// contentType) is read from the cache, and its index record is completed
// on the way so the next call is O(1) Cache API operations. Index records
// whose URL is no longer in the cache (browser eviction) are dropped.
async function listEntries(c: Cache): Promise<Entry[]> {
	const keys = await c.keys();
	const metas = await allMeta();
	const byUrl = new Map<string, { videoId: string; meta: Meta }>();
	for (const [videoId, meta] of metas) byUrl.set(meta.url, { videoId, meta });
	const out: Entry[] = [];
	const present = new Set<string>();
	for (const k of keys) {
		present.add(k.url);
		const ix = byUrl.get(k.url);
		if (ix && ix.meta.bytes > 0 && typeof ix.meta.contentType === "string") {
			out.push({
				url: k.url,
				videoId: ix.videoId,
				bytes: ix.meta.bytes,
				at: ix.meta.at || 0,
				lastAccess: ix.meta.lastAccess || ix.meta.at || 0,
				contentType: ix.meta.contentType,
				pinned: ix.meta.pinned === true,
			});
			continue;
		}
		const r = await c.match(k);
		if (!r) continue;
		let bytes = parseInt(r.headers.get(H_BYTES) || r.headers.get("Content-Length") || "0", 10);
		if (!(bytes > 0) && r.type !== "opaque") {
			try {
				bytes = (await r.clone().blob()).size;
			} catch {
				bytes = 0;
			}
		}
		const videoId = r.headers.get(H_VIDEO) || "";
		const at = parseInt(r.headers.get(H_AT) || "0", 10) || 0;
		const meta = videoId ? metas.get(videoId) : undefined;
		const sameEntry = !!meta && meta.url === k.url;
		const entry: Entry = {
			url: k.url,
			videoId,
			bytes: bytes > 0 ? bytes : 0,
			at: sameEntry && meta!.at ? meta!.at : at,
			lastAccess: sameEntry && meta!.lastAccess ? meta!.lastAccess : at,
			contentType: r.headers.get("Content-Type") || (r.type === "opaque" ? "opaque" : ""),
			// Header first; the meta index is the backup copy of the flag (G6).
			pinned: r.headers.get(H_PINNED) === "1" || (sameEntry && meta!.pinned === true),
		};
		out.push(entry);
		// Complete the index record so this entry is answered from the index next time.
		if (sameEntry && entry.bytes > 0) {
			await setMeta(videoId, { ...meta!, bytes: entry.bytes, at: entry.at, lastAccess: entry.lastAccess, pinned: entry.pinned, contentType: entry.contentType });
		} else if (videoId && !meta && entry.bytes > 0) {
			// L2 (audit v7, P3): the audio entry survived a cache put but the
			// index write (or the whole SW) was killed before setMeta /
			// persistIndex ran (e.g. the browser stopping a SW mid cache-audio
			// batch). Backfill from the entry's own headers so `is-cached` /
			// "déjà en cache" answer true again instead of re-downloading a
			// track that is already on disk.
			await setMeta(videoId, {
				url: entry.url,
				bytes: entry.bytes,
				at: entry.at || Date.now(),
				lastAccess: entry.lastAccess || entry.at || Date.now(),
				pinned: entry.pinned,
				contentType: entry.contentType,
			});
		}
	}
	for (const [videoId, meta] of metas) if (!present.has(meta.url)) await deleteMeta(videoId);
	return out;
}

// The entry the page is currently playing (message "now-playing"): never
// evicted. Persisted in the META cache (G15/F16) so a service worker that the
// browser stopped and restarted mid-track still protects it: the copy is
// honoured for NOW_PLAYING_TTL_MS and refreshed every time the track is served
// (touch), so a long track stays protected while it is actually being played.
const NOW_PLAYING_KEY = "/__ytm_now_playing__";
const NOW_PLAYING_TTL_MS = 30 * 60 * 1000;
let nowPlaying: { url: string; videoId: string } = { url: "", videoId: "" };
let nowPlayingLoaded: Promise<void> | null = null;
function loadNowPlaying(): Promise<void> {
	if (!nowPlayingLoaded) {
		nowPlayingLoaded = (async () => {
			try {
				const m = await caches.open(META_CACHE);
				const r = await m.match(NOW_PLAYING_KEY);
				if (!r) return;
				const v = await r.json();
				const fresh = v && typeof v.at === "number" && Date.now() - v.at < NOW_PLAYING_TTL_MS;
				// A "now-playing" message that arrived first wins over the stored copy.
				if (fresh && !nowPlaying.url && !nowPlaying.videoId) {
					nowPlaying = { url: typeof v.url === "string" ? v.url : "", videoId: typeof v.videoId === "string" ? v.videoId : "" };
				}
			} catch {
				/* no stored copy: nothing to protect beyond pins */
			}
		})();
	}
	return nowPlayingLoaded;
}
async function persistNowPlaying(): Promise<void> {
	try {
		const m = await caches.open(META_CACHE);
		if (!nowPlaying.url && !nowPlaying.videoId) {
			await m.delete(NOW_PLAYING_KEY);
			return;
		}
		await m.put(NOW_PLAYING_KEY, new Response(JSON.stringify({ ...nowPlaying, at: Date.now() }), { headers: { "Content-Type": "application/json" } }));
	} catch {
		/* best effort: the in-memory copy still protects the track until the SW stops */
	}
}
type Keep = string | ReadonlySet<string>;
function isProtected(e: { url: string; videoId: string; pinned?: boolean }, keep: Keep): boolean {
	if (e.pinned) return true; // pinned by the user (X-YTM-Pinned): only an explicit uncache removes it
	if (typeof keep === "string" ? keep && e.url === keep : keep.has(e.url)) return true;
	if (nowPlaying.url && e.url === nowPlaying.url) return true;
	if (nowPlaying.videoId && e.videoId && e.videoId === nowPlaying.videoId) return true;
	return false;
}

async function deleteEntry(c: Cache, e: { url: string; videoId: string }): Promise<boolean> {
	const ok = await c.delete(e.url);
	if (e.videoId) {
		const meta = await getMeta(e.videoId);
		if (meta && meta.url === e.url) await deleteMeta(e.videoId);
	}
	return ok;
}

// J11 / I14 multi-tab: an eviction (LRU, QuotaExceededError recovery or a
// lowered quota) is told to EVERY window, not only the tab whose request
// triggered it, so the "Prêt hors-ligne" badges of the other tabs follow.
// SW -> every page { type: "audio-evicted", videoIds, count }.
async function broadcastEvicted(evicted: ReadonlyArray<{ url: string; videoId: string }>): Promise<void> {
	if (!evicted.length) return;
	const videoIds = evicted.map((e) => e.videoId).filter((id) => !!id);
	try {
		const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		for (const cl of cs) cl.postMessage({ type: "audio-evicted", videoIds, count: evicted.length });
	} catch {
		/* no client to tell: the next list-audio answer carries the truth */
	}
}

// LRU by lastAccess (refreshed on every served hit, throttled), never evicting
// `keep` (the entry just written) nor the track being played. Serialized so
// two concurrent callers cannot both act on a stale total and over-evict.
let quotaLock: Promise<void> = Promise.resolve();
function enforceQuota(c: Cache, keep: Keep): Promise<void> {
	const run = quotaLock.then(async () => {
		const quota = await getQuota();
		if (!(quota > 0)) return;
		await loadNowPlaying();
		const entries = await listEntries(c);
		let total = entries.reduce((s, e) => s + e.bytes, 0);
		if (total <= quota) return;
		entries.sort((a, b) => a.lastAccess - b.lastAccess || a.at - b.at);
		const evicted: Entry[] = [];
		for (const e of entries) {
			if (total <= quota) break;
			if (isProtected(e, keep)) continue;
			if (await deleteEntry(c, e)) {
				total -= e.bytes;
				evicted.push(e);
			}
		}
		await broadcastEvicted(evicted);
	});
	quotaLock = run.catch(() => {});
	return run;
}

// K9: cacheAudio no longer enforces the quota after EVERY write (a batch of
// M downloads cost M full listings); writes within QUOTA_DEBOUNCE_MS share
// one run that protects every entry written in the batch. `quotaSettled()`
// is what a message handler waits for (keeps the SW alive until it ran).
const QUOTA_DEBOUNCE_MS = 2000;
let quotaTimer: ReturnType<typeof setTimeout> | undefined;
let quotaKeep = new Set<string>();
let quotaPending: Promise<void> | null = null;
let quotaResolve: (() => void) | undefined;
function scheduleEnforceQuota(c: Cache, keep: string): Promise<void> {
	if (keep) quotaKeep.add(keep);
	if (!quotaPending) quotaPending = new Promise<void>((res) => (quotaResolve = res));
	const pending = quotaPending;
	clearTimeout(quotaTimer);
	quotaTimer = setTimeout(() => {
		const keeps = quotaKeep;
		const done = quotaResolve;
		quotaKeep = new Set();
		quotaPending = null;
		quotaResolve = undefined;
		quotaTimer = undefined;
		enforceQuota(c, keeps)
			.catch(() => {})
			.then(() => done?.());
	}, QUOTA_DEBOUNCE_MS);
	return pending;
}
function quotaSettled(): Promise<void> {
	return quotaPending ?? Promise.resolve();
}

// Evict the `n` least recently used entries (for QuotaExceededError recovery).
async function evictOldest(c: Cache, keep: Keep, n: number): Promise<number> {
	await loadNowPlaying();
	const entries = (await listEntries(c)).filter((e) => !isProtected(e, keep));
	entries.sort((a, b) => a.lastAccess - b.lastAccess || a.at - b.at);
	let freed = 0;
	const evicted: Entry[] = [];
	for (const e of entries.slice(0, n)) {
		if (await deleteEntry(c, e)) {
			freed += e.bytes;
			evicted.push(e);
		}
	}
	await broadcastEvicted(evicted);
	return freed;
}

function isQuotaError(e: unknown): boolean {
	const err = e as { name?: string; code?: number; message?: string } | null;
	return !!err && (err.name === "QuotaExceededError" || err.code === 22 || /quota/i.test(String(err.message || "")));
}

function sameOrigin(u: string): boolean {
	try {
		return new URL(u, self.location.href).origin === self.location.origin;
	} catch {
		return false;
	}
}

type CacheResult = { ok: boolean; bytes: number; reason?: string; already?: boolean; cachedUrl?: string; pinnedBytes?: number; quota?: number };

// Fetch the full audio and store it. Same-origin: a real (non-opaque) response
// whose status and Content-Type we can verify, so a PoW/error HTML page is never
// cached in place of audio. Cross-origin: try CORS (verifiable); as a last
// resort a no-cors fetch yields an opaque response with no status, headers or
// readable body, so there is NO reliable signal that it is audio and not an
// error page: we deliberately do not cache it (reported as reason "opaque").
async function cacheAudio(rawUrl: string, videoId: string, pinNow = false, signal?: AbortSignal): Promise<CacheResult> {
	const abs = new URL(rawUrl, self.location.href).href;
	const c = await caches.open(AUDIO_CACHE);

	// Already cached under this videoId (any URL: signed /vp URLs rotate) ?
	if (videoId) {
		const found = await cachedForVideo(c, videoId);
		if (found) {
			const bytes = parseInt(found.hit.headers.get(H_BYTES) || found.hit.headers.get("Content-Length") || "0", 10) || found.meta.bytes || 0;
			if (bytes > 0) {
				touch(videoId, found.meta);
				return { ok: true, bytes, already: true, cachedUrl: found.meta.url };
			}
		}
	}
	const existing = await c.match(abs);
	if (existing && existing.type !== "opaque" && existing.status === 200) {
		const bytes = parseInt(existing.headers.get(H_BYTES) || existing.headers.get("Content-Length") || "0", 10) || 0;
		if (bytes > 0) {
			if (videoId && !(await getMeta(videoId))) {
				const at = parseInt(existing.headers.get(H_AT) || "0", 10) || Date.now();
				await setMeta(videoId, {
					url: abs,
					bytes,
					at,
					lastAccess: Date.now(),
					pinned: existing.headers.get(H_PINNED) === "1",
					contentType: existing.headers.get("Content-Type") || "",
				});
			}
			return { ok: true, bytes, already: true, cachedUrl: abs };
		}
	}

	// HL3: an `abort-audio` message aborts this fetch (pack "Annuler"): the
	// download stops within the second and the page gets reason "cancelled".
	const cancelled = (): CacheResult => ({ ok: false, bytes: 0, reason: "cancelled" });
	if (signal?.aborted) return cancelled();
	let res: Response | null = null;
	if (sameOrigin(abs)) {
		try {
			res = await fetch(abs, { credentials: "same-origin", cache: "no-store", signal });
		} catch (e) {
			if (signal?.aborted) return cancelled();
			throw e;
		}
	} else {
		try {
			res = await fetch(abs, { mode: "cors", cache: "no-store", signal });
		} catch {
			res = null;
		}
		if (signal?.aborted) return cancelled();
		if (!res) {
			// Last resort: opaque. Not cacheable without a reliable signal (see above).
			try {
				const op = await fetch(abs, { mode: "no-cors", cache: "no-store", signal });
				if (op.type === "opaque") return { ok: false, bytes: 0, reason: "opaque" };
			} catch {
				/* ignore */
			}
			return signal?.aborted ? cancelled() : { ok: false, bytes: 0, reason: "network" };
		}
	}
	if (!res.ok) return { ok: false, bytes: 0, reason: "status " + res.status };
	const ct = res.headers.get("Content-Type");
	if (!isAudioContentType(ct)) return { ok: false, bytes: 0, reason: "content-type " + (ct || "none") };
	let buf: ArrayBuffer;
	try {
		buf = await res.arrayBuffer();
	} catch (e) {
		if (signal?.aborted) return cancelled();
		throw e;
	}
	if (signal?.aborted) return cancelled();
	if (!buf.byteLength) return { ok: false, bytes: 0, reason: "empty" };

	const now = Date.now();
	const headers = new Headers();
	headers.set("Content-Type", (ct || "application/octet-stream").split(";")[0].trim());
	headers.set("Content-Length", String(buf.byteLength));
	headers.set("Accept-Ranges", "bytes");
	headers.set(H_BYTES, String(buf.byteLength));
	headers.set(H_VIDEO, videoId || "");
	headers.set(H_AT, String(now));

	// One entry per videoId: drop the previous URL of this track (if any), then
	// re-insert this URL. QuotaExceededError → evict the least recently used
	// entries and retry once; still failing → reason "quota".
	// The pin of the previous entry (header or meta) is carried over (G6): a
	// rotated /vp URL, recacheEvicted() or a re-download must not unpin a track.
	// I15: `pinNow` (cache-audio { pinned: true }) stamps X-YTM-Pinned at write
	// time, so a "Garder hors-ligne" download is never evicted between its
	// write and its pin.
	// J10: same rule as pin-audio (G7): pinned entries are never evicted, so a
	// pinned write must keep the pinned total within the quota, else the LRU
	// could never bring the cache back under it. Refused with reason "quota":
	// nothing written, nothing evicted. The previous entry of this track is
	// replaced by this write, so its bytes do not count.
	if (pinNow) {
		const quota = await getQuota();
		if (quota > 0) {
			const others = (await listEntries(c)).reduce((s, x) => s + (x.pinned && !(videoId && x.videoId === videoId) ? x.bytes : 0), 0);
			const pinnedBytes = others + buf.byteLength;
			if (pinnedBytes > quota) return { ok: false, bytes: 0, reason: "quota", pinnedBytes, quota };
		}
	}
	let pinned = pinNow;
	if (videoId) {
		const old = await getMeta(videoId);
		if (old) {
			// J9: a stale meta (URL rotated, entry evicted but meta kept) must
			// never clear the pin the request (pinNow) or the previous entry carried.
			pinned = pinNow || old.pinned === true;
			try {
				const oldResp = await c.match(old.url);
				if (oldResp && oldResp.headers.get(H_PINNED) === "1") pinned = true;
			} catch {
				/* unreadable old entry: the meta flag is all we have */
			}
			if (old.url !== abs) await c.delete(old.url);
		}
	}
	const prevSameUrl = await c.match(abs);
	if (prevSameUrl && prevSameUrl.headers.get(H_PINNED) === "1") pinned = true;
	if (pinned) headers.set(H_PINNED, "1");
	await c.delete(abs);
	const put = () => c.put(abs, new Response(buf, { status: 200, headers }));
	try {
		await put();
	} catch (e) {
		if (!isQuotaError(e)) throw e;
		const freed = await evictOldest(c, abs, Math.max(3, Math.ceil((await listEntries(c)).length / 10)));
		try {
			await put();
		} catch (e2) {
			if (!isQuotaError(e2)) throw e2;
			return { ok: false, bytes: 0, reason: "quota" + (freed ? "" : " (nothing evictable)") };
		}
	}
	if (videoId) await setMeta(videoId, { url: abs, bytes: buf.byteLength, at: now, lastAccess: now, pinned, contentType: headers.get("Content-Type") || "" });
	void scheduleEnforceQuota(c, abs); // K9: one LRU pass per batch, 2 s after the last write
	return { ok: true, bytes: buf.byteLength, cachedUrl: abs };
}

// In-flight dedup: one download per videoId (or per URL when no videoId).
// L8-16: each cache-audio message is one waiter of the shared download
// (SharedJobs); abort-audio withdraws the sender's waiter only, and the
// fetch itself is aborted when no waiter is left.
const inflight = new SharedJobs<CacheResult>(() => ({ ok: false, bytes: 0, reason: "cancelled" }));
function inflightKey(rawUrl: string, videoId: string): string {
	try {
		return videoId ? "id:" + videoId : "url:" + new URL(rawUrl, self.location.href).href;
	} catch {
		return "url:" + rawUrl;
	}
}
/** The id of the page that sent a message ("" when unknown). */
function senderId(event: ExtendableMessageEvent): string {
	const src = event.source as Client | null;
	return (src && typeof src.id === "string" && src.id) || "";
}
function cacheAudioDeduped(rawUrl: string, videoId: string, pinNow: boolean, owner: string): Promise<CacheResult> {
	return inflight.join(inflightKey(rawUrl, videoId), owner, (signal) => cacheAudio(rawUrl, videoId, pinNow, signal));
}
/** HL3: withdraw `owner`'s wait on the download of `videoId` / `url`; false when it has none. */
function abortCacheAudio(rawUrl: string, videoId: string, owner: string): boolean {
	return inflight.cancel(inflightKey(rawUrl, videoId), owner);
}

function reply(event: ExtendableMessageEvent, msg: Record<string, unknown>): Promise<void> {
	const src = event.source as Client | null;
	if (src && typeof (src as Client).postMessage === "function") {
		src.postMessage(msg);
		return Promise.resolve();
	}
	return self.clients.matchAll({ includeUncontrolled: true }).then((cs) => cs.forEach((cl) => cl.postMessage(msg)));
}

self.addEventListener("message", (event) => {
	const data = (event as ExtendableMessageEvent).data;
	if (!data || typeof data.type !== "string") return;
	const ev = event as ExtendableMessageEvent;

	if (data.type === "cache-audio" && typeof data.url === "string") {
		const videoId = typeof data.videoId === "string" ? data.videoId : "";
		const pinNow = data.pinned === true;
		ev.waitUntil(
			cacheAudioDeduped(data.url, videoId, pinNow, senderId(ev))
				.catch((e) => ({ ok: false, bytes: 0, reason: isQuotaError(e) ? "quota" : String((e && e.message) || e || "error") }))
				.then((r) => reply(ev, { type: "audio-cached", url: data.url, videoId, ...r }))
				.then(() => quotaSettled()), // K9: stay alive for the debounced LRU pass
		);
		return;
	}
	// HL3: page -> SW { type: "abort-audio", videoId?, url? } -> { type: "audio-aborted", videoId, url, ok }
	// The aborted cache-audio answers its own "audio-cached" with reason "cancelled".
	// L8-16: only the sender's own cache-audio is withdrawn; another page
	// waiting on the same download keeps it (the fetch stops with its last waiter).
	if (data.type === "abort-audio" && (typeof data.url === "string" || typeof data.videoId === "string")) {
		const videoId = typeof data.videoId === "string" ? data.videoId : "";
		const rawUrl = typeof data.url === "string" ? data.url : "";
		ev.waitUntil(reply(ev, { type: "audio-aborted", videoId, url: rawUrl, ok: abortCacheAudio(rawUrl, videoId, senderId(ev)) }));
		return;
	}
	if (data.type === "uncache-audio" && (typeof data.url === "string" || typeof data.videoId === "string")) {
		const videoId = typeof data.videoId === "string" ? data.videoId : "";
		const rawUrl = typeof data.url === "string" ? data.url : "";
		ev.waitUntil(
			caches
				.open(AUDIO_CACHE)
				.then(async (c) => {
					let ok = false;
					if (rawUrl) {
						const abs = new URL(rawUrl, self.location.href).href;
						ok = (await c.delete(abs)) || (await c.delete(rawUrl));
					}
					if (videoId) {
						const meta = await getMeta(videoId);
						if (meta) ok = (await c.delete(meta.url)) || ok;
						await deleteMeta(videoId);
					}
					return reply(ev, { type: "audio-uncached", url: rawUrl, videoId, ok });
				})
				.catch(() => reply(ev, { type: "audio-uncached", url: rawUrl, videoId, ok: false })),
		);
		return;
	}
	if (data.type === "is-cached" && typeof data.videoId === "string") {
		const videoId = data.videoId;
		ev.waitUntil(
			(async () => {
				const c = await caches.open(AUDIO_CACHE);
				const found = await cachedForVideo(c, videoId);
				if (!found) return reply(ev, { type: "audio-is-cached", videoId, cached: false });
				const bytes = parseInt(found.hit.headers.get(H_BYTES) || found.hit.headers.get("Content-Length") || "0", 10) || found.meta.bytes || 0;
				return reply(ev, { type: "audio-is-cached", videoId, cached: true, url: found.meta.url, bytes });
			})().catch(() => reply(ev, { type: "audio-is-cached", videoId, cached: false })),
		);
		return;
	}
	if (data.type === "now-playing") {
		let url = "";
		try {
			url = typeof data.url === "string" && data.url ? new URL(data.url, self.location.href).href : "";
		} catch {
			url = "";
		}
		nowPlaying = { url, videoId: typeof data.videoId === "string" ? data.videoId : "" };
		nowPlayingLoaded = Promise.resolve(); // the page's word beats any stored copy
		ev.waitUntil(persistNowPlaying());
		if (nowPlaying.videoId) touch(nowPlaying.videoId, null);
		return;
	}
	// page -> SW { type: "pin-audio", videoId, pinned }  ->  { type: "audio-pinned", videoId, pinned, ok, reason? }
	// Re-puts the cached response with the X-YTM-Pinned header and mirrors the
	// flag in the meta index; pinned entries are never evicted.
	// ok:false reasons: "not_cached" (download it first), "error".
	if (data.type === "pin-audio" && typeof data.videoId === "string") {
		const videoId = data.videoId as string;
		const pinned = !!data.pinned;
		ev.waitUntil(
			(async () => {
				const c = await caches.open(AUDIO_CACHE);
				const entries = await listEntries(c);
				const e = entries.find((x) => x.videoId === videoId);
				const r = e ? await c.match(e.url) : undefined;
				if (!e || !r) return reply(ev, { type: "audio-pinned", videoId, pinned, ok: false, reason: "not_cached" });
				// Pinned entries are never evicted, so their total must stay within
				// the quota or the LRU can never bring the cache back under it (G7).
				if (pinned && !e.pinned) {
					const quota = await getQuota();
					const pinnedBytes = entries.reduce((s, x) => s + (x.pinned ? x.bytes : 0), 0) + e.bytes;
					if (quota > 0 && pinnedBytes > quota) return reply(ev, { type: "audio-pinned", videoId, pinned, ok: false, reason: "quota", pinnedBytes, quota });
				}
				const headers = new Headers(r.headers);
				if (pinned) headers.set(H_PINNED, "1");
				else headers.delete(H_PINNED);
				const body = await r.arrayBuffer();
				await c.put(e.url, new Response(body, { status: r.status, statusText: r.statusText, headers }));
				const meta = await getMeta(videoId);
				if (meta && meta.url === e.url) await setMeta(videoId, { ...meta, pinned });
				return reply(ev, { type: "audio-pinned", videoId, pinned, ok: true });
			})().catch(() => reply(ev, { type: "audio-pinned", videoId, pinned, ok: false, reason: "error" })),
		);
		return;
	}
	if (data.type === "list-audio") {
		ev.waitUntil(
			(async () => {
				const c = await caches.open(AUDIO_CACHE);
				const entries = await listEntries(c);
				const total = entries.reduce((s, e) => s + e.bytes, 0);
				const pinnedBytes = entries.reduce((s, e) => s + (e.pinned ? e.bytes : 0), 0);
				return reply(ev, { type: "audio-list", entries, total, pinnedBytes, quota: await getQuota() });
			})().catch(() => reply(ev, { type: "audio-list", entries: [], total: 0, pinnedBytes: 0, quota: DEFAULT_QUOTA })),
		);
		return;
	}
	if (data.type === "set-audio-quota") {
		ev.waitUntil(
			(async () => {
				const q = await setQuota(Number(data.bytes));
				const c = await caches.open(AUDIO_CACHE);
				await enforceQuota(c, "");
				return reply(ev, { type: "audio-quota", quota: q });
			})().catch(() => reply(ev, { type: "audio-quota", quota: DEFAULT_QUOTA })),
		);
		return;
	}
	if (data.type === "get-audio-quota") {
		ev.waitUntil(getQuota().then((q) => reply(ev, { type: "audio-quota", quota: q })));
	}
});
