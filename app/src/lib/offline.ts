// Offline core: every track that gets played (player.ts) or prefetched (lane A4,
// via the window "ytm:prefetched" CustomEvent) is handed to the service worker
// to cache in full, and remembered in localStorage ("ytm-offline-tracks") so the
// library can list it and the SW serves it (Range-aware) when the device is
// offline. Pairs with src/service-worker.ts (cache-audio / audio-cached msgs).
//
// Consumed event (emitted by the session list / prefetcher):
//   window.dispatchEvent(new CustomEvent("ytm:prefetched", { detail: { item, url } }))
//   -> cacheTrackOffline(item, url)
import { APIClient } from "$lib/api";

const KEY = "ytm-offline-tracks";
const ACK_TIMEOUT_MS = 120_000; // a full track fetch on a slow link can take a while

export type OfflineTrack = Record<string, any> & {
	videoId: string;
	_offlineUrl: string;
	_at: number;
	_cached?: boolean;
	_bytes?: number;
};
export type OfflineResult = { ok: boolean; reason?: string; fellBack?: boolean; bytes?: number; cached?: boolean };

function read(): OfflineTrack[] {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) || "[]");
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}
function write(list: OfflineTrack[]) {
	try {
		localStorage.setItem(KEY, JSON.stringify(list));
	} catch {
		/* quota / private mode: the SW cache still works, only the listing is lost */
	}
}
function patch(videoId: string, fields: Partial<OfflineTrack>) {
	const list = read();
	const i = list.findIndex((t) => t.videoId === videoId);
	if (i === -1) return;
	list[i] = { ...list[i], ...fields };
	write(list);
}

export function getOfflineTracks(): OfflineTrack[] {
	return read();
}
export function isDownloaded(videoId: string): boolean {
	return read().some((t) => t.videoId === videoId);
}
export function isCached(videoId: string): boolean {
	return read().some((t) => t.videoId === videoId && t._cached === true);
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(fallback), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			() => {
				clearTimeout(t);
				resolve(fallback);
			},
		);
	});
}

async function resolveAudioUrl(lid: string): Promise<string> {
	try {
		const p = await withTimeout(
			APIClient.fetch(`/api/v1/player.json?videoId=${lid}`).then((r) => r.json()),
			15_000,
			null as any,
		);
		const fmts = (p && p.streamingData && p.streamingData.adaptiveFormats) || [];
		const audio = fmts.find((f: any) => /audio/i.test(f.mimeType || "") && f.url) || fmts[0];
		return (audio && audio.url) || "";
	} catch {
		return "";
	}
}

export function isIOS(): boolean {
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent || "";
	// iPhone/iPod, plus iPadOS which now reports as Mac but has touch
	return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);
}

// Only http(s) / same-origin-relative URLs are cacheable by the SW (no blob:,
// data:, m3u8 playlists…).
function cacheableUrl(url: string): boolean {
	if (!url || typeof url !== "string") return false;
	if (/^(blob|data|file):/i.test(url)) return false;
	if (/\.m3u8(\?|$)/i.test(url)) return false;
	return /^(https?:)?\/\//i.test(url) || url.startsWith("/");
}

// ---------------------------------------------------------------------------
// Service worker plumbing: one message listener, per-URL pending acks
// ---------------------------------------------------------------------------

type Ack = { ok: boolean; bytes?: number; reason?: string; already?: boolean; videoId?: string };
const pending = new Map<string, Array<(a: Ack) => void>>();
const inflight = new Map<string, Promise<OfflineResult>>();
let listening = false;

function ackKey(url: string): string {
	try {
		return new URL(url, location.href).href;
	} catch {
		return url;
	}
}

function ensureListener() {
	if (listening || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
	listening = true;
	navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
		const d = ev.data;
		if (!d || d.type !== "audio-cached" || typeof d.url !== "string") return;
		const k = ackKey(d.url);
		const rs = pending.get(k);
		if (!rs) return;
		pending.delete(k);
		rs.forEach((r) => r(d as Ack));
	});
}

function waitAck(url: string, ms: number): Promise<Ack | null> {
	const k = ackKey(url);
	return new Promise((resolve) => {
		const t = setTimeout(() => {
			const rs = pending.get(k);
			if (rs) {
				const rest = rs.filter((r) => r !== done);
				if (rest.length) pending.set(k, rest);
				else pending.delete(k);
			}
			resolve(null);
		}, ms);
		const done = (a: Ack) => {
			clearTimeout(t);
			resolve(a);
		};
		pending.set(k, [...(pending.get(k) || []), done]);
	});
}

async function getSW(): Promise<ServiceWorker | null> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
	try {
		if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
		const reg = await withTimeout(navigator.serviceWorker.ready, 5_000, null as ServiceWorkerRegistration | null);
		return navigator.serviceWorker.controller || (reg && reg.active) || null;
	} catch {
		return null;
	}
}

/** Generic request/response to the SW (list-audio, set-audio-quota…). */
export async function swRequest<T = any>(msg: Record<string, unknown>, replyType: string, ms = 10_000): Promise<T | null> {
	const sw = await getSW();
	if (!sw) return null;
	return new Promise<T | null>((resolve) => {
		const t = setTimeout(() => {
			navigator.serviceWorker.removeEventListener("message", on);
			resolve(null);
		}, ms);
		const on = (ev: MessageEvent) => {
			if (ev.data && ev.data.type === replyType) {
				clearTimeout(t);
				navigator.serviceWorker.removeEventListener("message", on);
				resolve(ev.data as T);
			}
		};
		navigator.serviceWorker.addEventListener("message", on);
		sw.postMessage(msg);
	});
}
export function listCachedAudio() {
	return swRequest<{ type: "audio-list"; entries: { url: string; videoId: string; bytes: number; at: number; contentType: string }[]; total: number; quota: number }>(
		{ type: "list-audio" },
		"audio-list",
	);
}
export function setAudioQuota(bytes: number) {
	return swRequest<{ type: "audio-quota"; quota: number }>({ type: "set-audio-quota", bytes }, "audio-quota");
}

// ---------------------------------------------------------------------------
// cacheTrackOffline: the single entry point (player, prefetcher, explicit save)
// ---------------------------------------------------------------------------

/**
 * Idempotent: asks the SW to cache `url` for `item`, records the track at the
 * head of "ytm-offline-tracks" (no duplicate by videoId), waits for the SW's
 * "audio-cached" ack (with timeout) and stores `_cached` / `_bytes`.
 * Concurrent calls for the same URL share one in-flight promise. Never throws.
 */
export function cacheTrackOffline(item: any, url: string): Promise<OfflineResult> {
	const lid = item && item.videoId;
	if (!lid) return Promise.resolve({ ok: false, reason: "no id" });
	if (!cacheableUrl(url)) return Promise.resolve({ ok: false, reason: "not cacheable" });
	const k = ackKey(url);
	const running = inflight.get(k);
	if (running) return running;
	const p = (async (): Promise<OfflineResult> => {
		try {
			const sw = await getSW();
			if (!sw) return { ok: false, reason: "no service worker" };
			ensureListener();

			// Record first (head of list, no duplicate) so the library shows it at once.
			const prev = read().find((t) => t.videoId === lid);
			const list = read().filter((t) => t.videoId !== lid);
			const entry: OfflineTrack = {
				...(prev || {}),
				...item,
				videoId: lid,
				_offlineUrl: url,
				_at: Date.now(),
				_cached: prev && prev._offlineUrl === url ? prev._cached : false,
				_bytes: prev && prev._offlineUrl === url ? prev._bytes : undefined,
			};
			list.unshift(entry);
			write(list);

			const ack = waitAck(url, ACK_TIMEOUT_MS);
			sw.postMessage({ type: "cache-audio", url, videoId: lid });
			const a = await ack;
			if (!a) {
				// No ack in time: the SW may still finish; leave _cached as-is.
				return { ok: false, reason: "timeout", cached: entry._cached === true };
			}
			patch(lid, { _cached: !!a.ok, _bytes: a.ok ? a.bytes : entry._bytes });
			return { ok: !!a.ok, cached: !!a.ok, bytes: a.bytes, reason: a.ok ? undefined : a.reason || "sw refused" };
		} catch (e: any) {
			return { ok: false, reason: String((e && e.message) || e || "error") };
		} finally {
			inflight.delete(k);
		}
	})();
	inflight.set(k, p);
	return p;
}

// Prefetch hook (lane A4): window CustomEvent("ytm:prefetched", { detail: { item, url } }).
let prefetchHooked = false;
export function installPrefetchHook() {
	if (prefetchHooked || typeof window === "undefined" || typeof document === "undefined") return;
	prefetchHooked = true;
	window.addEventListener("ytm:prefetched", (ev: Event) => {
		const d = (ev as CustomEvent).detail || {};
		if (d && d.item && typeof d.url === "string") void cacheTrackOffline(d.item, d.url);
	});
}
installPrefetchHook();

/**
 * Explicit "save for offline" (alias of cacheTrackOffline with URL resolution).
 * Falls back to an on-device download when no service worker is usable.
 */
export async function downloadForOffline(item: any): Promise<OfflineResult> {
	const lid = item && item.videoId;
	if (!lid) return { ok: false, reason: "no id" };

	const url = await resolveAudioUrl(lid);
	if (!url) return { ok: false, reason: "no stream url" };
	const isLocal = /\/localf\b/.test(url);

	// Service-worker offline cache (works on macOS/Chrome/Android). iOS Safari/Brave
	// in private mode or an in-app webview exposes no serviceWorker → degrade.
	if (await getSW()) return cacheTrackOffline(item, url);

	// No usable service worker. If we own the file locally, save it straight to the
	// device (Fichiers on iOS) — that survives offline without the SW. Otherwise be honest.
	if (isLocal) {
		const r = await downloadToDevice(item);
		if (r.ok) return { ok: true, fellBack: true };
		return r;
	}
	if (isIOS()) {
		return {
			ok: false,
			reason:
				"Sauvegarde hors-ligne indisponible ici (Safari/Brave privé ou navigateur intégré). Ajoute music.ekaii.fr à l'écran d'accueil et ouvre-la depuis l'app, ou suis l'artiste pour l'acquérir en local.",
		};
	}
	return { ok: false, reason: "service worker indisponible — recharge la page ou ajoute le site à l'écran d'accueil" };
}

// ---------------------------------------------------------------------------
// Download to device
// ---------------------------------------------------------------------------

function sanitizeName(s: string): string {
	return (s || "").replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}
function trackFilename(item: any, url: string, contentType?: string | null): string {
	const title = sanitizeName(item && item.title);
	const artist = sanitizeName((item && item.artistInfo && item.artistInfo.artist && item.artistInfo.artist[0] && item.artistInfo.artist[0].text) || (item && item.artist) || "");
	const base = artist && title ? artist + " - " + title : title || (item && item.videoId) || "track";
	const m = /\.(opus|webm|m4a|mp3|ogg|flac)(\b|$)/i.exec(url);
	let ext = m ? m[1].toLowerCase() : "";
	if (!ext && contentType) {
		const ct = contentType.split(";")[0].trim().toLowerCase();
		ext = ct === "audio/mp4" || ct === "video/mp4" ? "m4a" : ct === "audio/mpeg" ? "mp3" : ct === "audio/webm" || ct === "video/webm" ? "webm" : ct === "audio/ogg" || ct === "application/ogg" ? "ogg" : ct === "audio/flac" ? "flac" : "";
	}
	return base + "." + (ext || "opus");
}
function triggerAnchor(href: string, name: string) {
	const a = document.createElement("a");
	a.href = href;
	a.download = name;
	a.rel = "noopener";
	document.body.appendChild(a);
	a.click();
	a.remove();
}

/**
 * Real on-device download: saves the actual audio file to the device.
 * - Owned/local tracks (/localf) use the bridge's dl=1 (Content-Disposition) path.
 * - Otherwise fetch(url) (same-origin, served from the SW cache when the track was
 *   played, so it works offline) → blob → anchor with a proper filename.
 * - If that fetch fails for any reason, NEVER block: hand the URL to the browser
 *   as a direct anchor download (it sends cookies itself) and report fellBack.
 * Never waits on server-side acquisition: if the API can't resolve a URL, the
 * URL remembered from a previous play/cache is used.
 */
export async function downloadToDevice(item: any): Promise<OfflineResult> {
	const lid = item && item.videoId;
	if (!lid) return { ok: false, reason: "no id" };
	const known = read().find((t) => t.videoId === lid);
	let url = await resolveAudioUrl(lid);
	if (!url && known && known._offlineUrl) url = known._offlineUrl;
	if (!url) return { ok: false, reason: "no stream url" };

	// Local library file -> bridge force-download (fast, correct filename).
	if (/\/localf\b/.test(url)) {
		const dlUrl = url + (url.includes("?") ? "&" : "?") + "dl=1";
		triggerAnchor(dlUrl, trackFilename(item, url));
		return { ok: true };
	}

	// Same-origin stream (cache-first through the SW) -> blob -> save with a name.
	try {
		const res = await fetch(url, { credentials: "same-origin" });
		if (!res.ok) throw new Error("stream " + res.status);
		const ct = res.headers.get("Content-Type") || "";
		if (/text\/html/i.test(ct)) throw new Error("html");
		const blob = await res.blob();
		if (!blob || blob.size === 0) throw new Error("empty");
		const objUrl = URL.createObjectURL(blob);
		triggerAnchor(objUrl, trackFilename(item, url, ct));
		setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
		return { ok: true };
	} catch {
		// Direct browser download: no waiting on anything, the browser streams it
		// itself (with cookies). Filename hint only honoured same-origin.
		triggerAnchor(url, trackFilename(item, url));
		return { ok: true, fellBack: true };
	}
}

export function removeOffline(item: any) {
	const lid = item && item.videoId;
	const t = read().find((x) => x.videoId === lid);
	const ctrl = typeof navigator !== "undefined" && navigator.serviceWorker && navigator.serviceWorker.controller;
	if (t && t._offlineUrl && ctrl) ctrl.postMessage({ type: "uncache-audio", url: t._offlineUrl });
	write(read().filter((x) => x.videoId !== lid));
}
