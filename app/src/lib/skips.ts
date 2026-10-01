// c40b B6-10 "la file qui apprend": a user "next" press (player button,
// keyboard, fullscreen, MediaSession nexttrack) before 20 s or before 30 %
// of the track is a skip, sent to POST /api/v1/me/skips through the history
// outbox (historyOutbox.ts) so an offline skip is replayed later. The track
// end auto-advance, the error auto-skip, a group-session advance and a tap
// on another queue row never count. Pure helpers (skips.test.ts).

export const SKIP_MAX_SECONDS = 20;
export const SKIP_MAX_FRACTION = 0.3;
/** Outbox item marker: this entry is a skip, not a play (me.ts postPlay routes it). */
export const SKIP_MARK = "__skip";

export type SkipSource = "player" | "mediasession" | "fullscreen" | "keyboard";

/** Early enough to be a skip: < 20 s, or < 30 % of a known duration. */
export function isSkip(position: number, duration: number): boolean {
	if (!Number.isFinite(position) || position < 0) return false;
	if (position < SKIP_MAX_SECONDS) return true;
	return Number.isFinite(duration) && duration > 0 && position < duration * SKIP_MAX_FRACTION;
}

export interface SkipItem {
	[SKIP_MARK]: true;
	videoId: string;
	title?: string;
	position: number;
	duration: number;
	source: SkipSource;
}

/**
 * The outbox item of a "next" press on `track` at `position` / `duration`
 * (seconds), or null when it is not a skip: no track id, the track never
 * loaded (unknown duration), or the press came late.
 */
export function skipItem(track: unknown, position: number, duration: number, source: SkipSource): SkipItem | null {
	if (!track || typeof track !== "object") return null;
	const id = (track as { videoId?: unknown }).videoId;
	if (typeof id !== "string" || !id) return null;
	if (!(Number.isFinite(duration) && duration > 0)) return null;
	if (!isSkip(position, duration)) return null;
	const title = (track as { title?: unknown }).title;
	return {
		[SKIP_MARK]: true,
		videoId: id,
		...(typeof title === "string" && title ? { title: title.slice(0, 200) } : {}),
		position: Math.round(position * 10) / 10,
		duration: Math.round(duration * 10) / 10,
		source,
	};
}

export function isSkipItem(item: unknown): item is SkipItem {
	return !!item && typeof item === "object" && (item as Record<string, unknown>)[SKIP_MARK] === true;
}

/**
 * Body of POST me/skips for an outbox skip item. `at` = the press time (ms);
 * an outbox replay also carries clientSentAt (historyOutbox.replayItem).
 */
export function skipBody(item: Record<string, unknown>, at: number | undefined): Record<string, unknown> {
	const id = String(item.videoId ?? "");
	const body: Record<string, unknown> = {
		[/^[0-9a-f]{11}$/.test(id) ? "lid" : "videoId"]: id,
		position: item.position,
		duration: item.duration,
		source: item.source,
	};
	if (typeof at === "number" && Number.isFinite(at)) body.at = at;
	if (typeof item.clientSentAt === "number") body.clientSentAt = item.clientSentAt;
	return body;
}
