/// <reference types="@sveltejs/kit" />
// PWA service worker: precache the app shell (installable + offline app load),
// network-first API with cache fallback (browsed library works offline), and a
// dedicated audio cache ("ytm-offline-audio") that holds every track that was
// played or explicitly saved, served cache-first with proper Range support so
// the <audio> element plays it back when the device is offline.
//
// Page <-> SW message contract (all via navigator.serviceWorker / postMessage):
//   page -> SW  { type: "cache-audio",     url, videoId? }
//   SW  -> page { type: "audio-cached",    url, videoId, ok, bytes, reason?, already? }
//   page -> SW  { type: "uncache-audio",   url }
//   SW  -> page { type: "audio-uncached",  url, ok }
//   page -> SW  { type: "list-audio" }
//   SW  -> page { type: "audio-list",      entries: [{url, videoId, bytes, at, contentType}], total, quota }
//   page -> SW  { type: "set-audio-quota", bytes }          (<= 0 => unlimited)
//   SW  -> page { type: "audio-quota",     quota }
//   page -> SW  { type: "get-audio-quota" }
//   SW  -> page { type: "audio-quota",     quota }
import { build, files, version } from "$service-worker";

const SHELL = `ytm-shell-${version}`;
const API_CACHE = "ytm-api";
const AUDIO_CACHE = "ytm-offline-audio";
const META_CACHE = "ytm-offline-meta";
const QUOTA_KEY = "/__ytm_audio_quota__";
const DEFAULT_QUOTA = 2 * 1024 * 1024 * 1024; // ~2 GiB
const SHELL_ASSETS = [...build, ...files, "/"];

// Response headers we stamp on every cached audio entry (used by list-audio + LRU).
const H_BYTES = "X-YTM-Bytes";
const H_VIDEO = "X-YTM-VideoId";
const H_AT = "X-YTM-Cached-At";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(SHELL).then(async (c) => {
			// Cache each shell asset independently so one failing asset can't abort
			// the whole precache (which would leave the PWA unable to boot offline).
			await Promise.all(SHELL_ASSETS.map((a) => c.add(a).catch(() => {})));
			await self.skipWaiting();
		}).catch(() => {}),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(keys.filter((k) => k.startsWith("ytm-shell-") && k !== SHELL).map((k) => caches.delete(k)));
			await self.clients.claim();
		})(),
	);
});

// Audio (and cover) endpoints served by our own origin (lane A1 makes them
// relative: /localf?p=…, /vp?u=…, /aud/<id>, /cover?lid=…) plus the legacy
// absolute ytify/invidious/googlevideo forms still seen during the transition.
const isAudio = (u: URL) =>
	/\/(localf|vp|cover|aud)\b/.test(u.pathname) || /googlevideo|videoplayback/.test(u.href);

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

async function matchAudio(c: Cache, req: Request, url: URL): Promise<Response | undefined> {
	return (await c.match(req, { ignoreMethod: true })) || (await c.match(url.pathname + url.search, { ignoreMethod: true }));
}

self.addEventListener("fetch", (event) => {
	const req = event.request;
	let url: URL;
	try {
		url = new URL(req.url);
	} catch {
		return;
	}

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

	// app-shell assets → cache-first
	if (url.origin === location.origin && (build.includes(url.pathname) || files.includes(url.pathname))) {
		event.respondWith(caches.match(req).then((r) => r || fetch(req)));
		return;
	}

	// API GET → network-first, fall back to last cached (browsed data offline)
	if (url.pathname.startsWith("/api/")) {
		event.respondWith(
			(async () => {
				const c = await caches.open(API_CACHE);
				try {
					const res = await fetch(req);
					if (res.ok) c.put(req, res.clone());
					return res;
				} catch {
					return (await c.match(req)) || new Response('{"offline":true}', { headers: { "Content-Type": "application/json" } });
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

type Entry = { url: string; videoId: string; bytes: number; at: number; contentType: string };

// Entries in insertion order (Cache.keys() preserves insertion order), which
// is what our LRU eviction relies on: oldest inserted = first evicted.
async function listEntries(c: Cache): Promise<Entry[]> {
	const keys = await c.keys();
	const out: Entry[] = [];
	for (const k of keys) {
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
		out.push({
			url: k.url,
			videoId: r.headers.get(H_VIDEO) || "",
			bytes: bytes > 0 ? bytes : 0,
			at: parseInt(r.headers.get(H_AT) || "0", 10) || 0,
			contentType: r.headers.get("Content-Type") || (r.type === "opaque" ? "opaque" : ""),
		});
	}
	return out;
}

// Simple LRU-by-insertion: evict the oldest entries until total <= quota,
// never evicting `keep` (the entry we just wrote).
async function enforceQuota(c: Cache, keep: string): Promise<void> {
	const quota = await getQuota();
	if (!(quota > 0)) return;
	const entries = await listEntries(c);
	let total = entries.reduce((s, e) => s + e.bytes, 0);
	for (const e of entries) {
		if (total <= quota) break;
		if (e.url === keep) continue;
		if (await c.delete(e.url)) total -= e.bytes;
	}
}

function sameOrigin(u: string): boolean {
	try {
		return new URL(u, self.location.href).origin === self.location.origin;
	} catch {
		return false;
	}
}

// Fetch the full audio and store it. Same-origin: a real (non-opaque) response
// whose status and Content-Type we can verify, so a PoW/error HTML page is never
// cached in place of audio. Cross-origin: try CORS (verifiable); as a last
// resort a no-cors fetch yields an opaque response with no status, headers or
// readable body, so there is NO reliable signal that it is audio and not an
// error page: we deliberately do not cache it (reported as reason "opaque").
async function cacheAudio(rawUrl: string, videoId: string): Promise<{ ok: boolean; bytes: number; reason?: string; already?: boolean }> {
	const abs = new URL(rawUrl, self.location.href).href;
	const c = await caches.open(AUDIO_CACHE);
	const existing = await c.match(abs);
	if (existing && existing.type !== "opaque" && existing.status === 200) {
		const bytes = parseInt(existing.headers.get(H_BYTES) || existing.headers.get("Content-Length") || "0", 10) || 0;
		if (bytes > 0) return { ok: true, bytes, already: true };
	}

	let res: Response | null = null;
	if (sameOrigin(abs)) {
		res = await fetch(abs, { credentials: "same-origin", cache: "no-store" });
	} else {
		try {
			res = await fetch(abs, { mode: "cors", cache: "no-store" });
		} catch {
			res = null;
		}
		if (!res) {
			// Last resort: opaque. Not cacheable without a reliable signal (see above).
			try {
				const op = await fetch(abs, { mode: "no-cors", cache: "no-store" });
				if (op.type === "opaque") return { ok: false, bytes: 0, reason: "opaque" };
			} catch {
				/* ignore */
			}
			return { ok: false, bytes: 0, reason: "network" };
		}
	}
	if (!res.ok) return { ok: false, bytes: 0, reason: "status " + res.status };
	const ct = res.headers.get("Content-Type");
	if (!isAudioContentType(ct)) return { ok: false, bytes: 0, reason: "content-type " + (ct || "none") };
	const buf = await res.arrayBuffer();
	if (!buf.byteLength) return { ok: false, bytes: 0, reason: "empty" };

	const headers = new Headers();
	headers.set("Content-Type", (ct || "application/octet-stream").split(";")[0].trim());
	headers.set("Content-Length", String(buf.byteLength));
	headers.set("Accept-Ranges", "bytes");
	headers.set(H_BYTES, String(buf.byteLength));
	headers.set(H_VIDEO, videoId || "");
	headers.set(H_AT, String(Date.now()));
	// Re-insert (delete first) so a re-cache moves the entry to the newest slot.
	await c.delete(abs);
	await c.put(abs, new Response(buf, { status: 200, headers }));
	await enforceQuota(c, abs);
	return { ok: true, bytes: buf.byteLength };
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
		ev.waitUntil(
			cacheAudio(data.url, videoId)
				.catch((e) => ({ ok: false, bytes: 0, reason: String((e && e.message) || e || "error") }))
				.then((r) => reply(ev, { type: "audio-cached", url: data.url, videoId, ...r })),
		);
		return;
	}
	if (data.type === "uncache-audio" && typeof data.url === "string") {
		ev.waitUntil(
			caches
				.open(AUDIO_CACHE)
				.then(async (c) => {
					const abs = new URL(data.url, self.location.href).href;
					const ok = (await c.delete(abs)) || (await c.delete(data.url));
					return reply(ev, { type: "audio-uncached", url: data.url, ok });
				})
				.catch(() => reply(ev, { type: "audio-uncached", url: data.url, ok: false })),
		);
		return;
	}
	if (data.type === "list-audio") {
		ev.waitUntil(
			(async () => {
				const c = await caches.open(AUDIO_CACHE);
				const entries = await listEntries(c);
				const total = entries.reduce((s, e) => s + e.bytes, 0);
				return reply(ev, { type: "audio-list", entries, total, quota: await getQuota() });
			})().catch(() => reply(ev, { type: "audio-list", entries: [], total: 0, quota: DEFAULT_QUOTA })),
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
