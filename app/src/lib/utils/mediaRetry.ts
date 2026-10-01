/** A track gets one automatic media-error retry per this window (G21). */
export const MEDIA_RETRY_TTL_MS = 10 * 60 * 1000;

/**
 * Claim the automatic source-reload retry for `videoId`: true (and the
 * attempt is recorded) when the track had no retry in the last `ttl` ms,
 * false otherwise. Expired entries are pruned on every call so the map
 * never grows with the session. Pure: the caller owns the map.
 */
export function claimMediaRetry(
	retriedAt: Map<string, number>,
	videoId: string,
	now = Date.now(),
	ttl = MEDIA_RETRY_TTL_MS,
): boolean {
	if (!videoId) return false;
	for (const [id, at] of retriedAt) {
		if (now - at >= ttl) retriedAt.delete(id);
	}
	const at = retriedAt.get(videoId);
	if (at !== undefined && now - at < ttl) return false;
	retriedAt.set(videoId, now);
	return true;
}

/** Per-track attempt record: time of the first attempt of the window + count. */
export type MediaRetryRecord = { at: number; count: number };

/** Automatic attempts per track per window: 1 = plain reload, 2 = re-resolve (H1). */
export const MEDIA_RETRY_MAX_ATTEMPTS = 2;

/**
 * Attempt-counting variant of `claimMediaRetry` (H1): returns the attempt
 * number granted for `videoId` (1 on the first media error of the window,
 * 2 on a second failure within `ttl` of the first), or 0 once `max` attempts
 * were used in the window (caller gives up: toast + guarded auto-skip). The
 * window starts at the first attempt, so a track never retries for ever (G21).
 * Expired records are pruned on every call. Pure: the caller owns the map.
 */
export function claimMediaRetryAttempt(
	attempts: Map<string, MediaRetryRecord>,
	videoId: string,
	now = Date.now(),
	ttl = MEDIA_RETRY_TTL_MS,
	max = MEDIA_RETRY_MAX_ATTEMPTS,
): number {
	if (!videoId) return 0;
	for (const [id, r] of attempts) {
		if (now - r.at >= ttl) attempts.delete(id);
	}
	const r = attempts.get(videoId);
	if (!r) {
		attempts.set(videoId, { at: now, count: 1 });
		return 1;
	}
	if (r.count >= max) return 0;
	r.count += 1;
	return r.count;
}

/** Append a cache-busting `_r` query parameter (keeps any existing query and hash). */
export function cacheBustUrl(url: string, now = Date.now()): string {
	if (!url) return url;
	const hashAt = url.indexOf("#");
	const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
	const hash = hashAt >= 0 ? url.slice(hashAt) : "";
	const q = base.indexOf("?");
	const path = q >= 0 ? base.slice(0, q) : base;
	const params = (q >= 0 ? base.slice(q + 1) : "").split("&").filter((kv) => kv && !kv.startsWith("_r="));
	params.push("_r=" + String(now));
	return path + "?" + params.join("&") + hash;
}

export type MediaRetryInput = {
	/** Attempt number granted by `claimMediaRetryAttempt` (0 = none left). */
	attempt: number;
	/** Source the media element failed on (`currentSrc`), "" when unknown. */
	failedSrc: string;
	/** `isStableAudioUrl(failedSrc)`: /localf or /aud, re-fetchable as is. */
	failedSrcStable: boolean;
	/** SW-cached URL of the track per the offline list (`getCachedUrl`), "". */
	cachedUrl: string;
	/** The offline copy is a local library file (`isLocalUrl` on either URL). */
	localCopy: boolean;
	/** Pinned per the offline list `_pinned` or the SW meta; null = unknown. */
	pinned: boolean | null;
	/** `navigator.onLine`. */
	online: boolean;
	now?: number;
};

export type MediaRetryStep =
	/** Attempt 1: reload the same source (cache-busted only when not stable). */
	| { kind: "reload"; url: string }
	/** Attempt 2: re-resolve the source; `purge` drops the SW entry first. */
	| { kind: "refetch"; purge: boolean; bypassCache: boolean }
	/** No automatic attempt left / nothing useful to try: surface the error. */
	| { kind: "give_up" };

/**
 * Decision rules of the media-error retry (H1). Never purges on the first
 * attempt; a purge needs a second failure within the window AND a cached
 * entry AND a known not-pinned state AND not a /localf copy AND being online.
 * Offline the second attempt gives up instead of re-resolving (player.json
 * cannot answer), so the offline copy always survives a transient error.
 */
export function planMediaRetry(i: MediaRetryInput): MediaRetryStep {
	if (i.attempt === 1) {
		if (!i.failedSrc) return { kind: "refetch", purge: false, bypassCache: false };
		return { kind: "reload", url: i.failedSrcStable ? i.failedSrc : cacheBustUrl(i.failedSrc, i.now ?? Date.now()) };
	}
	if (i.attempt === 2) {
		if (!i.online) return { kind: "give_up" };
		const purge = !!i.cachedUrl && i.pinned === false && !i.localCopy;
		return { kind: "refetch", purge, bypassCache: true };
	}
	return { kind: "give_up" };
}
