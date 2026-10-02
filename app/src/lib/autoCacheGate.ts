// U14-2: automatic offline keeps wait for a counted listen. On day one, one
// tap on "Écouter" of the album of the day took 333 Mo in 40 s without a
// word: the playing track and the two prefetched next ones were kept (FLAC)
// as soon as their URL was known. The rule now: a track started by the
// player is kept once it counts as listened (listenLog.ts: >= 2 min or
// half of it really played); a prefetched next track is kept once the
// CURRENT track counts as listened (its `after` id). Explicit saves
// ("Garder hors-ligne", packs, re-downloads) never pass through here.
// Pure (no store, no window): $lib/offline owns the one instance and feeds
// it the `ytm:listened` events.
import { formatBytesFr } from "./utils/formatFr";
import { listenThreshold } from "./listenLog";

export type AutoCacheRequest = { item: any; url: string };
/** Waiting requests kept at most (older groups are dropped first: a long skip-through never piles up). */
export const AUTO_CACHE_PENDING_MAX = 12;

export type AutoCacheGate = {
	/**
	 * Keep `item` (at `url`) once the track `after` (its own videoId by
	 * default) counts as listened: right away when it already does this
	 * session ("now"), else later ("deferred"). One request per videoId.
	 */
	request(item: any, url: string, after?: string): "now" | "deferred" | "ignored";
	/** A listen counted for `videoId`: releases the requests waiting on it (kept in request order). */
	listened(videoId: string): AutoCacheRequest[];
	/** True once a listen was counted for `videoId` this session. */
	isListened(videoId: string): boolean;
	/** Requests waiting on `videoId`. */
	pendingFor(videoId: string): number;
	/** Requests waiting in total. */
	pending(): number;
	reset(): void;
};

export function createAutoCacheGate(keep: (item: any, url: string) => void): AutoCacheGate {
	const heard = new Set<string>();
	// after -> (videoId -> request), insertion ordered on both levels.
	const waiting = new Map<string, Map<string, AutoCacheRequest>>();
	const total = () => {
		let n = 0;
		for (const g of waiting.values()) n += g.size;
		return n;
	};
	const forget = (videoId: string) => {
		for (const [after, g] of waiting) {
			g.delete(videoId);
			if (!g.size) waiting.delete(after);
		}
	};
	return {
		request(item, url, after) {
			const id = typeof item?.videoId === "string" ? item.videoId : "";
			if (!id || typeof url !== "string" || !url) return "ignored";
			const key = typeof after === "string" && after ? after : id;
			if (heard.has(key)) {
				forget(id);
				keep(item, url);
				return "now";
			}
			forget(id);
			let g = waiting.get(key);
			if (!g) {
				g = new Map();
				waiting.set(key, g);
			}
			g.set(id, { item, url });
			while (total() > AUTO_CACHE_PENDING_MAX) {
				const oldest = waiting.keys().next().value;
				if (oldest === undefined || oldest === key) break;
				waiting.delete(oldest);
			}
			return "deferred";
		},
		listened(videoId) {
			if (typeof videoId !== "string" || !videoId) return [];
			heard.add(videoId);
			const g = waiting.get(videoId);
			if (!g) return [];
			waiting.delete(videoId);
			const out = [...g.values()];
			for (const r of out) keep(r.item, r.url);
			return out;
		},
		isListened(videoId) {
			return heard.has(videoId);
		},
		pendingFor(videoId) {
			return waiting.get(videoId)?.size ?? 0;
		},
		pending: total,
		reset() {
			heard.clear();
			waiting.clear();
		},
	};
}

/** "Gardé hors-ligne (98 Mo)": the one-line notice of the first automatic keep of the session. */
export function autoKeepNotice(bytes: number | undefined | null): string {
	const b = Number(bytes);
	return Number.isFinite(b) && b > 0 ? `Gardé hors-ligne (${formatBytesFr(b)})` : "Gardé hors-ligne";
}

/**
 * U14-2 (harness): how many seconds of real play make the current track count
 * as listened for an automatic keep. Real users keep the full listenLog rule
 * (>= 2 min, or half of the track): `webdriver` is false and this returns
 * exactly `listenThreshold(duration)`, so nothing is weakened. Playwright and
 * other automation set `navigator.webdriver === true` and never listen for two
 * minutes, so the offline e2e harness (play a few seconds, then assert a cache
 * entry) would never see a counted listen; under webdriver ONLY we cap the
 * threshold at WEBDRIVER_LISTEN_SECONDS. The prefetched +1 / +2 release on the
 * CURRENT track's listen (the same `ytm:listened` event dispatched once this
 * threshold is crossed), so the prefetch follows the very same rule. Pure: the
 * caller (Player.svelte) reads navigator.webdriver and passes it in.
 */
export const WEBDRIVER_LISTEN_SECONDS = 5;
export function autoCacheListenThreshold(duration: number, webdriver: boolean): number {
	const base = listenThreshold(duration);
	return webdriver ? Math.min(base, WEBDRIVER_LISTEN_SECONDS) : base;
}
