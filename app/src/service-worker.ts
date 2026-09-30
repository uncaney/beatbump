/// <reference types="@sveltejs/kit" />
// PWA service worker: precache the app shell (installable + offline app load),
// network-first API with cache fallback (browsed library works offline), and a
// dedicated audio cache for tracks explicitly "downloaded for offline".
import { build, files, version } from "$service-worker";

const SHELL = `ytm-shell-${version}`;
const API_CACHE = "ytm-api";
const AUDIO_CACHE = "ytm-offline-audio";
const SHELL_ASSETS = [...build, ...files, "/"];

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

const isAudio = (u: URL) =>
	/\/(localf|vp|cover)\b/.test(u.pathname) || /googlevideo|videoplayback/.test(u.href);

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;
	let url: URL;
	try {
		url = new URL(req.url);
	} catch {
		return;
	}

	// app-shell assets → cache-first
	if (url.origin === location.origin && (build.includes(url.pathname) || files.includes(url.pathname))) {
		event.respondWith(caches.match(req).then((r) => r || fetch(req)));
		return;
	}

	// offline-downloaded audio + covers → cache-first (served when offline)
	if (isAudio(url)) {
		event.respondWith(
			(async () => {
				const c = await caches.open(AUDIO_CACHE);
				const hit = (await c.match(req)) || (await c.match(url.pathname + url.search));
				if (hit) return hit;
				try {
					return await fetch(req);
				} catch {
					return hit || Response.error();
				}
			})(),
		);
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

// Download-for-offline: the page fetches a full (non-Range) audio response and
// hands it here to store, so the SW serves it when offline.
self.addEventListener("message", (event) => {
	const data = (event as ExtendableMessageEvent).data;
	if (data && data.type === "cache-audio" && typeof data.url === "string") {
		event.waitUntil(
			caches.open(AUDIO_CACHE).then(async (c) => {
				try {
					// audio is cross-origin (ytify.ekaii.fr/localf) → no-cors opaque, cacheable
					const res = await fetch(data.url, { mode: "no-cors", cache: "no-store" });
					if (res.ok || res.type === "opaque") await c.put(data.url, res.clone());
				} catch {
					/* ignore */
				}
			}),
		);
	}
	if (data && data.type === "uncache-audio" && typeof data.url === "string") {
		event.waitUntil(caches.open(AUDIO_CACHE).then((c) => c.delete(data.url)));
	}
});
