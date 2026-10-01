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

/** Past this many seconds, "previous" restarts the current track. */
export const PREVIOUS_RESTART_AFTER_S = 3;

/**
 * c39c B6-8: the standard "previous" button. After 3 s into the track it
 * restarts it; earlier it goes to the previous track, or restarts the first
 * track of the queue (nothing before it).
 */
export function previousAction(currentTime: number, position: number): "restart" | "previous" {
	const t = typeof currentTime === "number" && isFinite(currentTime) ? currentTime : 0;
	if (t > PREVIOUS_RESTART_AFTER_S) return "restart";
	return typeof position === "number" && position >= 1 ? "previous" : "restart";
}

const absolute = (url: string, origin: string) => {
	try {
		return new URL(url, origin || "http://localhost").toString();
	} catch {
		return url;
	}
};

/** c39c B6-26: sizes declared to the lock screen, largest first. */
export const ARTWORK_SIZES: ReadonlyArray<number> = [512, 384, 256, 192, 96];
/** Thumbnails below this edge are never listed while a larger image exists. */
const MIN_ARTWORK_EDGE = 96;
// YouTube Music (googleusercontent) thumbnails carry their size in the URL.
const GOOGLE_DIM_RE = /=w\d+-h\d+(?=-|$)/;

/**
 * MediaMetadata artwork, largest first (a lock screen that takes the first
 * entry never gets a blurry 60 px thumbnail; Chrome picks by `sizes`):
 * - local tracks: the library cover (`/cover?lid=`) declared at 512 / 384 /
 *   256 / 192 / 96 (the cover proxy has no size parameter, same URL);
 * - YouTube rows with a resizable googleusercontent thumbnail: one URL per
 *   declared size (`=wN-hN`);
 * - other thumbnails: largest first, the ones under 96 px dropped when a
 *   larger one exists.
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
	const seen = new Set<string>();
	const push = (img: ArtworkImage) => {
		const key = `${img.src}|${img.sizes ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(img);
	};
	if (cover) {
		const src = absolute(cover, origin);
		for (const s of ARTWORK_SIZES) push({ src, sizes: `${s}x${s}`, type: "image/jpeg" });
	}
	const rest = thumbs.filter((t) => t.url !== cover);
	const edge = (t: Thumb) => Math.min(Number(t.width) || 0, Number(t.height) || 0);
	// Largest first (row order is smallest first; unknown sizes keep their place).
	const ordered = [...rest].reverse().sort((a, b) => edge(b) - edge(a));
	const resizable = ordered.find((t) => GOOGLE_DIM_RE.test(t.url));
	if (resizable) {
		for (const s of ARTWORK_SIZES) {
			push({
				src: absolute(resizable.url.replace(GOOGLE_DIM_RE, `=w${s}-h${s}`), origin),
				sizes: `${s}x${s}`,
				type: "image/jpeg",
			});
		}
	}
	const hasLarge = out.length > 0 || ordered.some((t) => edge(t) >= MIN_ARTWORK_EDGE);
	for (const t of ordered) {
		if (resizable && GOOGLE_DIM_RE.test(t.url)) continue;
		const w = Number(t.width);
		const h = Number(t.height);
		const known = w > 0 && h > 0;
		if (known && hasLarge && Math.min(w, h) < MIN_ARTWORK_EDGE) continue;
		const img: ArtworkImage = { src: absolute(t.url, origin), type: "image/jpeg" };
		if (known) img.sizes = `${w}x${h}`;
		push(img);
	}
	return out;
}

type Run = { text?: unknown; pageType?: unknown };
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * c39c B6-26: lock-screen title / artist / album. Artist: every artist run
 * (joined), else the subtitle ARTIST run, else a plain `artist` string.
 * Album: the row's album (`title`, or `text` on slimmed offline rows), else
 * the album the queue was started from when the track belongs to it.
 */
export function mediaMetadataFields(
	track: {
		title?: unknown;
		videoId?: unknown;
		artistInfo?: { artist?: unknown } | null;
		subtitle?: unknown;
		artist?: unknown;
		album?: unknown;
	} | null | undefined,
	context?: { kind?: unknown; title?: unknown; ids?: unknown } | null,
): { title: string; artist: string; album: string } {
	if (!track) return { title: "", artist: "", album: "" };
	const runs = Array.isArray(track.artistInfo?.artist) ? (track.artistInfo?.artist as Run[]) : [];
	const names = runs.map((r) => text(r?.text)).filter((n) => n && n !== "&" && n !== ",");
	let artist = [...new Set(names)].join(", ");
	if (!artist && Array.isArray(track.subtitle)) {
		const a = (track.subtitle as Run[]).find((s) => s && /ARTIST/.test(text(s.pageType)) && text(s.text));
		if (a) artist = text(a.text);
	}
	if (!artist) artist = text(track.artist);
	const al = track.album && typeof track.album === "object" ? (track.album as { title?: unknown; text?: unknown }) : null;
	let album = al ? text(al.title) || text(al.text) : "";
	if (!album && context && context.kind === "album" && Array.isArray(context.ids)) {
		const vid = text(track.videoId);
		if (vid && (context.ids as unknown[]).includes(vid)) album = text(context.title);
	}
	return { title: text(track.title), artist, album };
}
