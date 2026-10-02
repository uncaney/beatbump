// c55a (probe-gap v2, GAP-MEASURE v2): when the player moves to the next
// track. Until cycle 54 the auto-advance ran on the first `timeupdate` that
// reached `duration - 1.0 s`: timeupdate fires every ~250 ms, so the last
// 0.75 to 1 s of EVERY track was cut (the next source is prefetched by
// sessionList.ts whatever the rule says, nothing was gained by switching
// early). The rule is now: advance when the media element fires `ended`, or
// when a timeupdate reaches `duration - 0.15 s` (a declared duration longer
// than the media, or an element that never fires `ended`). Pure, no imports:
// safe for the player.ts / sessionList.ts import cycle.

/** Seconds before the end from which a `timeupdate` may advance (not before). */
export const TRACK_END_MARGIN_S = 0.15;

export type TrackEndInput = {
	/** The media element's currentTime (seconds). */
	currentTime: number;
	/** The duration to measure against (seconds; 0 / NaN / Infinity = unknown). */
	duration: number;
	/** HTMLMediaElement.ended, or true from the `ended` listener. */
	ended?: boolean;
};

const finitePositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * The duration the end rule measures against: the media element's own
 * duration once it is known (exact), else the one declared by the API
 * (player.json, carried by the store), else 0 (unknown: no advance from
 * timeupdate, only from `ended`).
 */
export function knownTrackDuration(declared: unknown, media: unknown): number {
	if (finitePositive(media)) return media;
	if (finitePositive(declared)) return declared;
	return 0;
}

/**
 * True when the player must move to the next track: the element reached its
 * end (`ended`), or the position is within TRACK_END_MARGIN_S of a known
 * duration. Never true for an unknown duration unless `ended`.
 */
export function shouldAdvanceAtTrackEnd(i: TrackEndInput | null | undefined): boolean {
	if (!i) return false;
	if (i.ended === true) return true;
	if (!finitePositive(i.duration)) return false;
	const t = typeof i.currentTime === "number" && Number.isFinite(i.currentTime) ? i.currentTime : 0;
	return t >= i.duration - TRACK_END_MARGIN_S;
}

/**
 * L15-2: what the end of a track does under the repeat mode, once the rule
 * above said "advance":
 * - "hold": repeat "track", the media element loops by itself (`loop`), the
 *   queue does not move;
 * - "restart": repeat "playlist" on the LAST row, the queue goes back to its
 *   first row (index 0) and nothing else (no next() after it: the loop used
 *   to restart on the second track);
 * - "advance": the regular next().
 * Pure: an unknown mode or an empty queue advances.
 */
export type RepeatAction = "advance" | "restart" | "hold";
export function repeatActionAtTrackEnd(repeat: unknown, position: number, length: number): RepeatAction {
	if (repeat === "track") return "hold";
	if (repeat === "playlist") {
		const n = typeof length === "number" && Number.isFinite(length) ? length : 0;
		const p = typeof position === "number" && Number.isFinite(position) ? position : 0;
		if (n > 0 && p >= n - 1) return "restart";
	}
	return "advance";
}
