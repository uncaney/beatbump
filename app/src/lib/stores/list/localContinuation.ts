/**
 * C4: when a local queue reaches its end, carry on with owned-library tracks
 * related to the last one (`/api/v1/local/related`), instead of stopping.
 * Setting "Continuer après la fin de la file": ON by default, OFF = stop.
 * Pure helpers + the setting store (own localStorage key, no settings.ts change).
 */
import { writable } from "svelte/store";

export const CONTINUE_KEY = "continueAfterQueue";
export const CONTINUATION_COUNT = 10;
export const CONTINUATION_PER_ALBUM = 2;

type Row = Record<string, any>;

const LID_RE = /^[0-9a-f]{11}$/;

/** Album identity of a row: album id / title, else the album cover URL (local items carry one per album). */
export function albumKey(item: Row | null | undefined): string {
	if (!item || typeof item !== "object") return "";
	const album = item.album;
	if (album && typeof album === "object") {
		const k = album.browseId || album.id || album.title || album.text;
		if (k) return "a:" + String(k);
	}
	if (Array.isArray(item.subtitle)) {
		const al = item.subtitle.find((s: any) => s && /ALBUM/.test(s.pageType || "") && (s.browseId || s.text));
		if (al) return "a:" + String(al.browseId || al.text);
	}
	const thumb = Array.isArray(item.thumbnails) ? item.thumbnails[0]?.url : "";
	return thumb ? "t:" + String(thumb) : "";
}

/**
 * Up to `count` candidates not already in the queue (by videoId, no repeats),
 * at most `perAlbum` from one album. Input order is kept.
 */
export function pickLocalContinuation(
	queue: ReadonlyArray<Row | undefined>,
	candidates: unknown,
	count = CONTINUATION_COUNT,
	perAlbum = CONTINUATION_PER_ALBUM,
): Row[] {
	if (!Array.isArray(candidates)) return [];
	const seen = new Set<string>();
	for (const t of queue) if (t && typeof t.videoId === "string") seen.add(t.videoId);
	const perAlbumCount = new Map<string, number>();
	const out: Row[] = [];
	for (const c of candidates) {
		if (out.length >= count) break;
		if (!c || typeof c !== "object") continue;
		const id = (c as Row).videoId;
		if (typeof id !== "string" || !id || seen.has(id)) continue;
		const key = albumKey(c as Row);
		if (key) {
			const n = perAlbumCount.get(key) ?? 0;
			if (n >= perAlbum) continue;
			perAlbumCount.set(key, n + 1);
		}
		seen.add(id);
		out.push(c as Row);
	}
	return out;
}

/** Query string for `local/related` seeded by `track` ("" = cannot seed). */
export function relatedQuery(track: Row | null | undefined): string {
	if (!track) return "";
	const id = typeof track.videoId === "string" ? track.videoId : "";
	if (LID_RE.test(id)) return "lid=" + encodeURIComponent(id);
	const title = typeof track.title === "string" ? track.title.trim() : "";
	if (!title) return "";
	const artist =
		track.artistInfo?.artist?.[0]?.text || (typeof track.artist === "string" ? track.artist : "") || "";
	return "title=" + encodeURIComponent(title) + "&artist=" + encodeURIComponent(artist);
}

/** Stored value -> setting (default ON; only an explicit "false" turns it off). */
export function parseContinueSetting(raw: string | null | undefined): boolean {
	return raw !== "false";
}

function readSetting(): boolean {
	try {
		return typeof localStorage === "undefined" ? true : parseContinueSetting(localStorage.getItem(CONTINUE_KEY));
	} catch {
		return true;
	}
}

/** "Continuer après la fin de la file" (Settings > Playback). */
export const continueAfterQueue = writable<boolean>(readSetting());
continueAfterQueue.subscribe((value) => {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(CONTINUE_KEY, value ? "true" : "false");
	} catch {
		/* private mode: the in-memory value still applies */
	}
});
