// Play counting rules for the stats (server history -> recently/most-played,
// taste, /library/stats). Pure helpers so the decision is unit-tested; the
// wiring lives in components/Player/Player.svelte.

/** Seconds of playback after which a play counts. */
export const HISTORY_MIN_SECONDS = 30;

/** Seconds of playback after which a play counts (30 s, or 50 % of a short track). */
export function historyThreshold(duration: number): number {
	return duration > 0 && duration < 2 * HISTORY_MIN_SECONDS ? duration / 2 : HISTORY_MIN_SECONDS;
}

/** How close to the end / to the start a time must be for a jump to look like a loop. */
export const LOOP_EDGE_SECONDS = 3;

/**
 * G10 (audit v4): in "repeat one" mode the <audio> element loops by itself
 * (`loop = true`): no `ended`, no track change, the videoId never changes, so a
 * play used to be counted once however many times the track looped. A loop is
 * seen as the playback time jumping from the last seconds of the track back to
 * its first seconds; each loop then starts a new play, which again only counts
 * after historyThreshold() seconds (the 30 s rule applies per loop).
 *
 * A manual seek from the very end back to the very start is indistinguishable
 * and is treated as a replay too; any other seek (or an unknown duration) is not.
 */
export function isLoopRestart(prevTime: number, time: number, duration: number): boolean {
	if (!(duration > 2 * LOOP_EDGE_SECONDS) || !isFinite(duration)) return false;
	if (!isFinite(prevTime) || !isFinite(time)) return false;
	return prevTime >= duration - LOOP_EDGE_SECONDS && time <= LOOP_EDGE_SECONDS && time < prevTime;
}
