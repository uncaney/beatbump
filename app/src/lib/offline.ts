// Offline core: every track that gets played (player.ts) or prefetched (lane A4,
// via the window "ytm:prefetched" CustomEvent) is handed to the service worker
// to cache in full, and remembered in localStorage ("ytm-offline-tracks") so the
// library can list it and the SW serves it (Range-aware) when the device is
// offline. Pairs with src/service-worker.ts (cache-audio / audio-cached msgs).
//
// Consumed event (emitted by the session list / prefetcher):
//   window.dispatchEvent(new CustomEvent("ytm:prefetched", { detail: { item, url } }))
//   -> cacheTrackOffline(item, url)
import { APIClient, PREFETCH_INIT } from "$lib/api";
import { settings } from "$lib/stores/settings";
import { derived, get, readable, writable, type Readable } from "svelte/store";

const KEY = "ytm-offline-tracks";
const ACK_TIMEOUT_MS = 120_000; // a full track fetch on a slow link can take a while

export type OfflineTrack = Record<string, any> & {
	videoId: string;
	_offlineUrl: string;
	_at: number;
	_cached?: boolean;
	_bytes?: number;
	/** Stable (/localf, /aud) entry the SW no longer holds: re-downloadable via recacheEvicted(). */
	_evicted?: boolean;
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
	offlineTracksStore.set(list);
}

// V1: the "ytm-offline-tracks" list as a store (every write() above, plus
// other tabs through the storage event), and the derived set of videoIds
// that are really cached, for the "Prêt hors-ligne" badge on rows / cards.
const offlineTracksStore = writable<OfflineTrack[]>([], (set) => {
	if (typeof window === "undefined") return;
	set(read());
	const on = (e: StorageEvent) => {
		if (e.key === KEY || e.key === null) set(read());
	};
	window.addEventListener("storage", on);
	return () => window.removeEventListener("storage", on);
});
export const offlineTracks: Readable<OfflineTrack[]> = { subscribe: offlineTracksStore.subscribe };
/**
 * I14: last `list-audio` answer of the SW (videoIds it really holds, and when
 * it was asked). null until the SW answered once.
 */
export type SwAudioSnapshot = { ids: Set<string>; at: number };
const swAudioSnapshot = writable<SwAudioSnapshot | null>(null);

/**
 * I14: the "Prêt hors-ligne" set, over the local list's tracks. Without a
 * SW answer: `_cached === true`. With one, the SW decides: a track it holds
 * is ready (even when the list missed the ack), one its LRU evicted is not
 * (even though the list still says cached); only a track recorded after
 * that answer (`_at` newer, cached since) is taken from the list. A track
 * removed from the list loses its badge at once.
 */
export function cachedIdsFrom(list: ReadonlyArray<Partial<OfflineTrack> | null | undefined>, sw: SwAudioSnapshot | null): Set<string> {
	const ids = new Set<string>();
	for (const t of list) {
		if (!t || !t.videoId) continue;
		const listSays = t._cached === true;
		if (!sw) {
			if (listSays) ids.add(t.videoId);
		} else if (sw.ids.has(t.videoId) || (listSays && typeof t._at === "number" && t._at > sw.at)) {
			ids.add(t.videoId);
		}
	}
	return ids;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

/** videoIds whose audio is in the SW cache (I14: per the SW once it answered, else the local list). */
export const cachedIds: Readable<Set<string>> = (() => {
	let last: Set<string> | null = null;
	return derived([offlineTracksStore, swAudioSnapshot], ([list, sw], set) => {
		const next = cachedIdsFrom(list, sw);
		// Re-emit only when the set changed (every ack rewrites the list).
		if (!last || !sameSet(last, next)) {
			last = next;
			set(next);
		}
	}, new Set<string>());
})();

/** I14: record a SW `list-audio` answer as the badge source of truth. */
export function setSwAudioSnapshot(entries: ReadonlyArray<{ videoId?: string }> | null | undefined, at = Date.now()): void {
	if (!Array.isArray(entries)) return;
	const ids = new Set<string>();
	for (const e of entries) if (e && typeof e.videoId === "string" && e.videoId) ids.add(e.videoId);
	swAudioSnapshot.set({ ids, at });
}

// I14: after a cache change (an audio-cached / audio-pinned / audio-uncached
// answer: the SW LRU may have evicted other tracks) ask the SW again,
// debounced, so the badges follow its real content.
const SW_REFRESH_DEBOUNCE_MS = 1_500;
let swRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleSwAudioRefresh(): void {
	if (typeof window === "undefined") return;
	if (swRefreshTimer) clearTimeout(swRefreshTimer);
	swRefreshTimer = setTimeout(() => {
		swRefreshTimer = null;
		const asked = Date.now();
		void listCachedAudio()
			.then((l) => {
				if (l && Array.isArray(l.entries)) setSwAudioSnapshot(l.entries, asked);
			})
			.catch(() => {});
	}, SW_REFRESH_DEBOUNCE_MS);
}
const CACHE_CHANGE_REPLIES = new Set(["audio-cached", "audio-pinned", "audio-uncached", "audio-quota", "audio-evicted"]);

/**
 * J11 / I14 multi-tab: the SW broadcast `audio-evicted { videoIds }` (sent to
 * every window after an LRU / quota eviction). Applied at once, before the
 * debounced `list-audio` refresh: the ids leave the SW snapshot (badges), and
 * the local list marks them `_cached: false` (+ `_evicted` when the URL is
 * stable, so the Offline page says "à retélécharger", like reconcile).
 */
export function applySwEviction(videoIds: ReadonlyArray<unknown>): void {
	const ids = new Set<string>();
	for (const id of videoIds) if (typeof id === "string" && id) ids.add(id);
	if (ids.size === 0) return;
	swAudioSnapshot.update((s) => {
		if (!s) return s;
		let changed = false;
		const next = new Set(s.ids);
		for (const id of ids) if (next.delete(id)) changed = true;
		return changed ? { ids: next, at: s.at } : s;
	});
	const list = read();
	let changed = false;
	for (let i = 0; i < list.length; i++) {
		const t = list[i];
		if (!t || !ids.has(t.videoId)) continue;
		const evicted = isStableAudioUrl(t._offlineUrl);
		if (t._cached === false && (!evicted || t._evicted === true)) continue;
		list[i] = evicted ? { ...t, _cached: false, _evicted: true } : { ...t, _cached: false };
		changed = true;
	}
	if (changed) write(list);
}
if (typeof navigator !== "undefined" && typeof window !== "undefined" && "serviceWorker" in navigator) {
	try {
		navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
			const t = ev.data && ev.data.type;
			if (t === "audio-evicted" && Array.isArray(ev.data.videoIds)) applySwEviction(ev.data.videoIds);
			if (typeof t === "string" && CACHE_CHANGE_REPLIES.has(t)) scheduleSwAudioRefresh();
		});
	} catch {
		/* no SW messaging: the local list stays the badge source */
	}
}
/** deviceOffline() as a store: follows the window online / offline events. */
export const networkOffline: Readable<boolean> = readable(false, (set) => {
	if (typeof window === "undefined") return;
	const upd = () => set(deviceOffline());
	upd();
	window.addEventListener("online", upd);
	window.addEventListener("offline", upd);
	return () => {
		window.removeEventListener("online", upd);
		window.removeEventListener("offline", upd);
	};
});
/** Toast for a click on a row that cannot play without a connection. */
export const UNAVAILABLE_OFFLINE_MSG = "Indisponible hors connexion";
function patch(videoId: string, fields: Partial<OfflineTrack>) {
	const list = read();
	const i = list.findIndex((t) => t.videoId === videoId);
	if (i === -1) return;
	list[i] = { ...list[i], ...fields };
	write(list);
}

// What we persist per track: enough for the offline library (title, artist,
// album, a couple of thumbnails, length, track number) plus our own fields.
// Full Beatbump items (subtitle runs, loggingContext, …) weigh 2-3 KB each and
// blow the localStorage cap around 2 000 tracks.
const KEEP_KEYS = ["title", "videoId", "artistInfo", "album", "length", "index", "playlistId", "_offlineUrl", "_cached", "_bytes", "_at", "_evicted", "_pinned"] as const;
export function slimTrack(item: any): OfflineTrack {
	const out: Record<string, any> = {};
	for (const k of KEEP_KEYS) if (item && item[k] !== undefined) out[k] = item[k];
	const th = item && Array.isArray(item.thumbnails) ? item.thumbnails : [];
	if (th.length) out.thumbnails = th.slice(0, 2).map((t: any) => ({ url: t && t.url, width: t && t.width, height: t && t.height }));
	// Keep the artist from the subtitle runs when artistInfo is missing (local tracks).
	if (!out.artistInfo && item && Array.isArray(item.subtitle)) {
		const a = item.subtitle.find((s: any) => s && /ARTIST/.test(s.pageType || "") && s.text);
		if (a) out.artistInfo = { artist: [{ text: a.text, browseId: a.browseId }] };
	}
	if (!out.album && item && Array.isArray(item.subtitle)) {
		const al = item.subtitle.find((s: any) => s && /ALBUM/.test(s.pageType || "") && (s.text || s.browseId));
		if (al) out.album = { text: al.text, browseId: al.browseId };
	}
	if (typeof item?.artist === "string" && !out.artistInfo) out.artist = item.artist;
	return out as OfflineTrack;
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
/** The URL under which `videoId` is cached by the SW (per our list), or "" when not cached. */
export function getCachedUrl(videoId: string): string {
	const t = read().find((x) => x.videoId === videoId && x._cached === true);
	return (t && t._offlineUrl) || "";
}
/** Whether `_offlineUrl` points at a locally owned file (served without any upstream). */
export function isLocalUrl(url: string | undefined): boolean {
	return !!url && /\/localf\b/.test(url);
}
// Stable (unsigned, re-fetchable) audio URLs: library files and iv-vp (/aud/<id>).
// Signed /vp URLs rotate and must not be kept once they fell out of the cache.
export function isStableAudioUrl(url: string | undefined): boolean {
	return !!url && /\/(localf|aud)\b/.test(url);
}

/**
 * settings.offline.autoCache: default on, only an explicit `false` disables
 * automatic offline caching (played tracks in player.ts, prefetched +1/+2 here).
 */
export function autoCacheEnabled(): boolean {
	try {
		return get(settings)?.offline?.autoCache !== false;
	} catch {
		return true;
	}
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
		// Resolution only (save for offline / download to device), not a play:
		// X-Ytm-Prefetch keeps the backend from acquiring album + lookahead (F12).
		const p = await withTimeout(
			APIClient.fetch(`/api/v1/player.json?videoId=${lid}`, PREFETCH_INIT).then((r) => r.json()),
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

type Ack = { ok: boolean; bytes?: number; reason?: string; already?: boolean; videoId?: string; cachedUrl?: string };
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
export type AudioListEntry = { url: string; videoId: string; bytes: number; at: number; lastAccess?: number; contentType: string; pinned?: boolean };
export function listCachedAudio() {
	return swRequest<{ type: "audio-list"; entries: AudioListEntry[]; total: number; pinnedBytes?: number; quota: number }>({ type: "list-audio" }, "audio-list");
}
/**
 * Pin (or unpin) a cached track: the service worker stamps X-YTM-Pinned on the
 * entry (and its meta index) and never evicts it; the local list mirrors the
 * flag (`_pinned`). `reason` when not ok: "not_cached" (download it first),
 * "quota" (pinned bytes would exceed the quota: raise it in Settings),
 * "no_sw" (no service worker / no answer), "error".
 */
export type PinResult = { ok: boolean; reason?: "not_cached" | "quota" | "no_sw" | "error" | string };
export async function pinOffline(item: { videoId?: string }, pinned: boolean): Promise<PinResult> {
	const videoId = item && item.videoId ? String(item.videoId) : "";
	if (!videoId) return { ok: false, reason: "error" };
	const r = await swRequest<{ type: "audio-pinned"; ok: boolean; reason?: string }>({ type: "pin-audio", videoId, pinned }, "audio-pinned");
	if (!r) return { ok: false, reason: "no_sw" };
	if (!r.ok) return { ok: false, reason: r.reason || "error" };
	// O10: the first pin asks the browser to keep this origin's storage.
	if (pinned) void requestPersistentStorage();
	try {
		write(read().map((t) => (t.videoId === videoId ? { ...t, _pinned: pinned } : t)));
	} catch {
		/* list write best effort */
	}
	return { ok: true };
}
export function setAudioQuota(bytes: number) {
	return swRequest<{ type: "audio-quota"; quota: number }>({ type: "set-audio-quota", bytes }, "audio-quota");
}

/**
 * Light asynchronous check with the SW: is `videoId` really in the audio cache
 * (by videoId, whatever URL it was cached under)? `null` = no answer (no SW,
 * timeout): callers then trust the local list. On a definite answer the local
 * list is patched (`_cached`, and `_offlineUrl` when the SW holds another URL).
 */
export async function verifyCached(videoId: string, ms = 1_500): Promise<{ cached: boolean; url: string } | null> {
	if (!videoId) return null;
	const r = await swRequest<{ type: "audio-is-cached"; videoId: string; cached: boolean; url?: string; bytes?: number }>(
		{ type: "is-cached", videoId },
		"audio-is-cached",
		ms,
	);
	if (!r || r.videoId !== videoId) return null;
	const known = read().find((t) => t.videoId === videoId);
	if (known) {
		if (r.cached) {
			const fields: Partial<OfflineTrack> = { _cached: true };
			if (r.url && r.url !== known._offlineUrl) fields._offlineUrl = r.url;
			if (typeof r.bytes === "number" && r.bytes > 0) fields._bytes = r.bytes;
			if (known._cached !== true || fields._offlineUrl || (fields._bytes && fields._bytes !== known._bytes)) patch(videoId, fields);
		} else if (known._cached === true) {
			patch(videoId, { _cached: false });
		}
	}
	return { cached: !!r.cached, url: (r.cached && r.url) || "" };
}

/**
 * HL3: abort the SW download of `videoId` (pack "Annuler"): the in-flight
 * cache-audio then acks ok:false reason "cancelled" and cacheTrackOffline
 * resolves at once. No reply awaited (an older SW ignores the message; the
 * caller races its own abort anyway). Never throws.
 */
export function abortCacheAudio(videoId: string | undefined, url?: string) {
	try {
		const ctrl = typeof navigator !== "undefined" && navigator.serviceWorker && navigator.serviceWorker.controller;
		if (ctrl && (videoId || url)) ctrl.postMessage({ type: "abort-audio", videoId: videoId || "", url: url || "" });
	} catch {
		/* ignore */
	}
}

/** Tell the SW which URL/track is playing so its LRU never evicts it. */
export function announceNowPlaying(url: string | undefined, videoId: string | undefined) {
	try {
		const ctrl = typeof navigator !== "undefined" && navigator.serviceWorker && navigator.serviceWorker.controller;
		if (ctrl) ctrl.postMessage({ type: "now-playing", url: url || "", videoId: videoId || "" });
	} catch {
		/* ignore */
	}
}

// Grace period for entries still being downloaded (recorded `_cached:false`
// before the SW ack): reconcile must not drop them.
const RECONCILE_GRACE_MS = 5 * 60 * 1000;

/**
 * Reconcile "ytm-offline-tracks" with what the SW really holds (`list-audio`):
 * `_cached` follows the cache, `_offlineUrl` follows the URL the SW has for the
 * videoId, entries with neither cached audio nor a local-file URL are removed
 * (except very recent ones still in flight). Entries are slimmed on the way.
 * Returns the reconciled list; `null` when the SW gave no answer (list untouched).
 */
export async function reconcileOfflineList(): Promise<OfflineTrack[] | null> {
	const asked = Date.now();
	const l = await listCachedAudio();
	if (!l || !Array.isArray(l.entries)) return null;
	setSwAudioSnapshot(l.entries, asked); // I14: badges follow the SW
	const byId = new Map<string, AudioListEntry>();
	const byUrl = new Map<string, AudioListEntry>();
	for (const e of l.entries) {
		if (e.videoId) byId.set(e.videoId, e);
		if (e.url) byUrl.set(ackKey(e.url), e);
	}
	const now = Date.now();
	const out: OfflineTrack[] = [];
	for (const raw of read()) {
		if (!raw || !raw.videoId) continue;
		const t = slimTrack(raw);
		const hit = byId.get(t.videoId) || (t._offlineUrl ? byUrl.get(ackKey(t._offlineUrl)) : undefined);
		if (hit) {
			t._cached = true;
			t._pinned = !!hit.pinned;
			if (t._evicted) delete t._evicted;
			if (hit.url) t._offlineUrl = hit.url;
			if (hit.bytes > 0) t._bytes = hit.bytes;
			if (!t._at && hit.at) t._at = hit.at;
		} else {
			t._cached = false;
			const recent = typeof t._at === "number" && now - t._at < RECONCILE_GRACE_MS;
			const stable = isStableAudioUrl(t._offlineUrl);
			if (!stable && !recent) continue;
			// Stable URL but gone from the cache and not in flight: the SW evicted
			// it (quota). Keep the entry, flagged, so the Offline page can tell
			// "to re-download" from "caching in progress" (F5); recacheEvicted()
			// re-runs the download for them.
			if (stable && !recent) t._evicted = true;
		}
		out.push(t);
	}
	write(out);
	return out;
}
if (typeof window !== "undefined" && typeof document !== "undefined") {
	// Once per page load, after the SW had a chance to claim the page.
	setTimeout(() => void reconcileOfflineList().catch(() => {}), 4_000);
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
export function cacheTrackOffline(item: any, url: string, opts: { pinned?: boolean } = {}): Promise<OfflineResult> {
	const lid = item && item.videoId;
	if (!lid) return Promise.resolve({ ok: false, reason: "no id" });
	if (!cacheableUrl(url)) return Promise.resolve({ ok: false, reason: "not cacheable" });
	// One in-flight request per track (the SW dedups by videoId too, but this
	// spares the round-trip and the duplicate list write).
	const k = "id:" + lid;
	const running = inflight.get(k);
	if (running) return running;
	const p = (async (): Promise<OfflineResult> => {
		try {
			const sw = await getSW();
			if (!sw) return { ok: false, reason: "no service worker" };
			ensureListener();

			// Already cached under this videoId: the SW answers `already` by
			// videoId whatever the URL, so keep the URL it holds (the stable one).
			const prev = read().find((t) => t.videoId === lid);
			if (prev && prev._cached === true && prev._offlineUrl && prev._offlineUrl !== url) {
				// Refresh the metadata only; no new download for a rotated signed URL.
				const list = read().filter((t) => t.videoId !== lid);
				list.unshift(slimTrack({ ...prev, ...item, videoId: lid, _offlineUrl: prev._offlineUrl, _cached: true, _bytes: prev._bytes, _at: prev._at }));
				write(list);
				return { ok: true, cached: true, bytes: prev._bytes };
			}

			// Record first (head of list, no duplicate) so the library shows it at once.
			const list = read().filter((t) => t.videoId !== lid);
			const entry: OfflineTrack = slimTrack({
				...(prev || {}),
				...item,
				videoId: lid,
				_offlineUrl: url,
				_at: Date.now(),
				_cached: prev && prev._offlineUrl === url ? prev._cached : false,
				_bytes: prev && prev._offlineUrl === url ? prev._bytes : undefined,
				_evicted: undefined, // a (re)download is in flight again
			});
			list.unshift(entry);
			write(list);

			const ack = waitAck(url, ACK_TIMEOUT_MS);
			// I15: `pinned` makes the SW write the entry pinned (atomic pin).
			sw.postMessage(opts.pinned ? { type: "cache-audio", url, videoId: lid, pinned: true } : { type: "cache-audio", url, videoId: lid });
			const a = await ack;
			if (!a) {
				// No ack in time: the SW may still finish; leave _cached as-is.
				return { ok: false, reason: "timeout", cached: entry._cached === true };
			}
			const fields: Partial<OfflineTrack> = { _cached: !!a.ok, _bytes: a.ok ? a.bytes : entry._bytes };
			if (a.ok && opts.pinned) fields._pinned = true;
			// The SW may hold the track under another (earlier) URL: that is the
			// one the <audio> element must request to hit the cache.
			if (a.ok && typeof a.cachedUrl === "string" && a.cachedUrl) fields._offlineUrl = a.cachedUrl;
			patch(lid, fields);
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
		// Auto-cache OFF: the prefetched URL still serves next(), but nothing is
		// stored or listed (F7). Explicit saves go through downloadForOffline.
		if (!autoCacheEnabled()) return;
		const d = (ev as CustomEvent).detail || {};
		if (d && d.item && typeof d.url === "string") void cacheTrackOffline(d.item, d.url);
	});
}
installPrefetchHook();

/**
 * Re-download every entry flagged `_evicted` by reconcileOfflineList (stable
 * /localf or /aud URL the service worker no longer holds). Sequential so a long
 * list does not flood the SW; never throws. Returns how many were attempted / OK.
 */
export async function recacheEvicted(): Promise<{ total: number; ok: number }> {
	const targets = read().filter((t) => t._evicted === true && isStableAudioUrl(t._offlineUrl));
	let ok = 0;
	for (const t of targets) {
		const r = await cacheTrackOffline(t, t._offlineUrl);
		if (r.ok) ok++;
	}
	return { total: targets.length, ok };
}

/**
 * Explicit "save for offline" (alias of cacheTrackOffline with URL resolution).
 * Falls back to an on-device download when no service worker is usable.
 */
export async function downloadForOffline(item: any, opts: { pinned?: boolean } = {}): Promise<OfflineResult> {
	const lid = item && item.videoId;
	if (!lid) return { ok: false, reason: "no id" };

	const url = await resolveAudioUrl(lid);
	if (!url) return { ok: false, reason: "no stream url" };
	const isLocal = /\/localf\b/.test(url);

	// Service-worker offline cache (works on macOS/Chrome/Android). iOS Safari/Brave
	// in private mode or an in-app webview exposes no serviceWorker → degrade.
	if (await getSW()) return cacheTrackOffline(item, url, opts);

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
	if (ctrl && (t || lid)) ctrl.postMessage({ type: "uncache-audio", url: (t && t._offlineUrl) || "", videoId: lid || "" });
	write(read().filter((x) => x.videoId !== lid));
}

// ---- me/* pages offline (audit v4 H2) ----
// The SW never caches /api/v1/me/* (G16: no cross-profile leak); offline it
// answers {"offline":true} in 200 instead, and without a SW the fetch throws.
// Pages use these two checks to show "Hors connexion" instead of an empty or
// logged-out state.

/** Whether the device reports no connection (`navigator.onLine === false`). */
export function deviceOffline(): boolean {
	try {
		return typeof navigator !== "undefined" && navigator.onLine === false;
	} catch {
		return false;
	}
}

/** Whether a me/* JSON answer is the SW's offline placeholder (`{"offline":true}`). */
export function isOfflineAnswer(r: unknown): boolean {
	return !!r && typeof r === "object" && (r as { offline?: unknown }).offline === true;
}

/**
 * A me/* load outcome: offline when the answer is the SW placeholder, or when
 * the call threw (`err` set) while the device is offline.
 */
export function meLoadOffline(answers: unknown[], err?: unknown): boolean {
	if (answers.some(isOfflineAnswer)) return true;
	return err !== undefined && deviceOffline();
}

// ---- O10: persistent storage ----
// Without navigator.storage.persist() the browser may wipe the whole offline
// cache of a PWA opened rarely. Asked once per page at the first pin / first
// "Garder hors-ligne", and when the PWA is installed (or runs standalone).

let persistAsked = false;
/**
 * Ask for persistent storage (once per page unless `force`). Resolves true
 * when granted (or already), false when refused, null when unsupported.
 */
export async function requestPersistentStorage(force = false): Promise<boolean | null> {
	try {
		const st = typeof navigator !== "undefined" ? navigator.storage : undefined;
		if (!st || typeof st.persist !== "function") return null;
		if (typeof st.persisted === "function" && (await st.persisted())) return true;
		if (persistAsked && !force) return false;
		persistAsked = true;
		return await st.persist();
	} catch {
		return null;
	}
}

/** Settings > Offline: persisted flag (null = unknown) + storage.estimate(). */
export async function storageStatus(): Promise<{ persisted: boolean | null; usage: number; quota: number }> {
	const out = { persisted: null as boolean | null, usage: 0, quota: 0 };
	try {
		const st = typeof navigator !== "undefined" ? navigator.storage : undefined;
		if (!st) return out;
		if (typeof st.persisted === "function") out.persisted = await st.persisted();
		if (typeof st.estimate === "function") {
			const e = await st.estimate();
			out.usage = Number(e?.usage) || 0;
			out.quota = Number(e?.quota) || 0;
		}
	} catch {
		/* unsupported / blocked: unknown */
	}
	return out;
}

if (typeof window !== "undefined") {
	try {
		window.addEventListener("appinstalled", () => void requestPersistentStorage(true));
		if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) void requestPersistentStorage();
	} catch {
		/* no matchMedia (tests) */
	}
}
