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
