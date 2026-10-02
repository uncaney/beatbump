// L13-1: this device's own listening log. A track is "listened" once at least
// LISTEN_MIN_SECONDS of it, or half of its length, really played in this tab
// (forward steps while playing: Player.svelte `_historyListened`, I6 rule).
// "Rafraîchir mon pack" only drops a pack track with such a listen since the
// pack began: a track merely served by the service worker (the startup
// restore loads the source paused, a 2 s "suivant", a seek on a cached track)
// is not listened, and a me/stats/recent play (30 s rule, no position) is
// not enough on its own. Pure (storage injected), bounded: the oldest
// entries are dropped past LISTEN_LOG_MAX.
export const LISTEN_LOG_KEY = "ytm-listen-log";
/** U14-2: window CustomEvent dispatched by recordListen (detail: the ListenEntry). */
export const LISTEN_EVENT = "ytm:listened";
export const LISTEN_LOG_MAX = 300;
/** Seconds listened after which a track counts as listened whatever its length. */
export const LISTEN_MIN_SECONDS = 120;
/** Share of the track's length after which it counts as listened. */
export const LISTEN_MIN_RATIO = 0.5;

export type ListenEntry = {
	videoId: string;
	/** When the listen qualified (epoch ms). */
	at: number;
	/** Seconds really listened at that moment. */
	seconds: number;
	/** The track's length (seconds, 0 when unknown). */
	duration: number;
};
type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/**
 * The rule: >= LISTEN_MIN_RATIO of a known length, or >= LISTEN_MIN_SECONDS.
 * Unknown / zero seconds never qualify (a served track is not a listened one).
 */
export function isListened(seconds: unknown, duration: unknown): boolean {
	const s = Number(seconds);
	if (!Number.isFinite(s) || s <= 0) return false;
	if (s >= LISTEN_MIN_SECONDS) return true;
	const d = Number(duration);
	return Number.isFinite(d) && d > 0 && s >= d * LISTEN_MIN_RATIO;
}

/** Seconds after which `isListened` turns true for a track of `duration` (0 = unknown). */
export function listenThreshold(duration: number): number {
	const d = Number(duration);
	return Number.isFinite(d) && d > 0 ? Math.min(LISTEN_MIN_SECONDS, d * LISTEN_MIN_RATIO) : LISTEN_MIN_SECONDS;
}

function normalize(v: unknown): ListenEntry | null {
	if (!v || typeof v !== "object") return null;
	const e = v as Record<string, unknown>;
	const videoId = typeof e.videoId === "string" ? e.videoId : "";
	const at = Number(e.at);
	const seconds = Number(e.seconds);
	const duration = Number(e.duration);
	if (!videoId || !Number.isFinite(at) || at <= 0 || !Number.isFinite(seconds) || seconds <= 0) return null;
	return { videoId, at, seconds, duration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
}

/** The log, oldest first; [] when missing, malformed or unreadable. */
export function readListenLog(store: KV | null | undefined): ListenEntry[] {
	try {
		const raw = store?.getItem(LISTEN_LOG_KEY);
		if (!raw) return [];
		const v = JSON.parse(raw);
		if (!Array.isArray(v)) return [];
		const out: ListenEntry[] = [];
		for (const e of v) {
			const n = normalize(e);
			if (n) out.push(n);
		}
		return out;
	} catch {
		return [];
	}
}

/** Append a qualifying listen (one per playback: the caller gates with `isListened`). */
export function recordListen(
	store: KV | null | undefined,
	entry: { videoId: string; seconds: number; duration?: number; at?: number },
	max = LISTEN_LOG_MAX,
): void {
	const n = normalize({ ...entry, at: entry.at ?? Date.now() });
	if (!n) return;
	// U14-2: the tab's listeners (the automatic offline keep waits for a counted
	// listen, $lib/offline) hear it even when nothing can be stored.
	try {
		if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") window.dispatchEvent(new CustomEvent(LISTEN_EVENT, { detail: { ...n } }));
	} catch {
		/* listeners are optional */
	}
	try {
		if (!store) return;
		const list = readListenLog(store);
		list.push(n);
		store.setItem(LISTEN_LOG_KEY, JSON.stringify(list.length > max ? list.slice(list.length - max) : list));
	} catch {
		/* private mode / full storage: the pack refresh simply sees fewer listens */
	}
}
