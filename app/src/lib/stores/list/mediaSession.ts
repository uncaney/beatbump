/**
 * C3 lock screen / headset: pure helpers for the Media Session API used by
 * $lib/player (position state, ±10 s seeks, artwork with the local cover).
 */

export const MEDIA_SEEK_OFFSET_S = 10;
const LID_RE = /^[0-9a-f]{11}$/;
const COVER_RE = /\/cover\?lid=/;

type Thumb = { url?: unknown; width?: unknown; height?: unknown };
export interface ArtworkImage {
	src: string;
	sizes?: string;
	type?: string;
}

/** setPositionState() payload, or null when the duration is unknown (the API throws on it). */
export function positionState(
	currentTime: number,
	duration: number,
	playbackRate = 1,
): { duration: number; position: number; playbackRate: number } | null {
	if (typeof duration !== "number" || !isFinite(duration) || duration <= 0) return null;
	const t = typeof currentTime === "number" && isFinite(currentTime) ? currentTime : 0;
	const rate = typeof playbackRate === "number" && isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
	return { duration, position: Math.min(Math.max(0, t), duration), playbackRate: rate };
}

/** Target of a relative seek, kept inside [0, duration] (duration unknown: no upper bound). */
export function seekTarget(currentTime: number, delta: number, duration: number): number {
	const t = (isFinite(currentTime) ? currentTime : 0) + (isFinite(delta) ? delta : 0);
	const max = isFinite(duration) && duration > 0 ? duration : Infinity;
	return Math.min(Math.max(0, t), max);
}

export interface MediaSeekDetails {
	action?: string;
	seekTime?: unknown;
	seekOffset?: unknown;
}

/**
 * c39c B6-8: absolute target of a Media Session seek action, or null when the
 * action carries nothing usable. `seekto` accepts 0 (the old `seekTime &&`
 * guard dropped "back to the start"); `seekbackward` / `seekforward` default
 * to MEDIA_SEEK_OFFSET_S when the browser sends no (or a bad) offset.
 */
export function mediaSessionSeekTarget(
	details: MediaSeekDetails | null | undefined,
	current: number,
	duration: number,
): number | null {
	if (!details) return null;
	const max = isFinite(duration) && duration > 0 ? duration : Infinity;
	if (details.action === "seekto") {
		const t = details.seekTime;
		if (typeof t !== "number" || !isFinite(t)) return null;
		return Math.min(Math.max(0, t), max);
	}
	if (details.action === "seekbackward" || details.action === "seekforward") {
		const o = details.seekOffset;
		const offset = typeof o === "number" && isFinite(o) && o > 0 ? o : MEDIA_SEEK_OFFSET_S;
		return seekTarget(current, details.action === "seekbackward" ? -offset : offset, duration);
	}
	return null;
}

const absolute = (url: string, origin: string) => {
	try {
		return new URL(url, origin || "http://localhost").toString();
	} catch {
		return url;
	}
};

/**
 * MediaMetadata artwork: the local library cover (`/cover?lid=`, declared
 * 512x512) first for owned tracks, then the row thumbnails, largest first.
 * Never mutates the row's thumbnails (F14/G14).
 */
export function mediaArtwork(
	track: { videoId?: unknown; thumbnails?: unknown } | null | undefined,
	origin: string,
): ArtworkImage[] {
	if (!track) return [];
	const thumbs = (Array.isArray(track.thumbnails) ? (track.thumbnails as Thumb[]) : []).filter(
		(t): t is Thumb & { url: string } => !!t && typeof t.url === "string" && t.url !== "",
	);
	const coverThumb = thumbs.find((t) => COVER_RE.test(t.url));
	const vid = typeof track.videoId === "string" ? track.videoId : "";
	const cover = coverThumb ? coverThumb.url : LID_RE.test(vid) ? `/cover?lid=${vid}` : "";
	const out: ArtworkImage[] = [];
	if (cover) out.push({ src: absolute(cover, origin), sizes: "512x512", type: "image/jpeg" });
	for (const t of [...thumbs].reverse()) {
		if (t.url === cover) continue;
		const w = Number(t.width);
		const h = Number(t.height);
		const img: ArtworkImage = { src: absolute(t.url, origin), type: "image/jpeg" };
		if (w > 0 && h > 0) img.sizes = `${w}x${h}`;
		out.push(img);
	}
	return out;
}
