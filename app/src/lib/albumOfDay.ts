// c39b B6-1 "Album du jour": pure helpers for the home card fed by
// GET /api/v1/local/album-of-day (one local album per UTC day, the same for
// every profile). No Svelte or store import so it is unit-testable.

import type { RowItem } from "./homeRows";

export const ALBUM_OF_DAY_URL = "/api/v1/local/album-of-day";
/** data-row key of the card in arrangeHomeRows (a bonus slot, see HomeRowInput.bonusSlot). */
export const ALBUM_OF_DAY_ROW = "album-du-jour";

export interface AlbumOfDay {
	/** The album card (localAlbumItem: title, subtitle artist, thumbnails, browseId "lb-…"). */
	album: RowItem;
	/** Release year ("1997"), "" when unknown. */
	year: string;
	/** UTC day the pick belongs to ("2026-10-01"). */
	date: string;
	/** The album's tracks, in order ([] on a cached paint: fetched again on "Écouter"). */
	tracks: RowItem[];
}

/** UTC calendar date of `now` ("YYYY-MM-DD"), the backend's day boundary. */
export function utcDay(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/** Parse the endpoint answer; null when there is no usable local album. */
export function albumOfDayFrom(resp: unknown): AlbumOfDay | null {
	if (!resp || typeof resp !== "object") return null;
	const r = resp as { album?: unknown; year?: unknown; date?: unknown; tracks?: unknown };
	const album = r.album as RowItem | null | undefined;
	if (!album || typeof album !== "object") return null;
	const id = String(album.browseId || album.endpoint?.browseId || "");
	if (!id.startsWith("lb-") || typeof album.title !== "string" || album.title.trim() === "") return null;
	const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "";
	if (!date) return null;
	const year = typeof r.year === "string" && /^\d{4}/.test(r.year) ? r.year.slice(0, 4) : "";
	const tracks = Array.isArray(r.tracks) ? (r.tracks.filter((t) => t && typeof t === "object" && typeof (t as RowItem).videoId === "string") as RowItem[]) : [];
	return { album, year, date, tracks };
}

/** Browse id of the card's album ("lb-…"). */
export function albumOfDayId(a: Pick<AlbumOfDay, "album">): string {
	return String(a.album.browseId || a.album.endpoint?.browseId || "");
}

/** "/release?id=lb-…": the album page and the playback context link. */
export function albumOfDayHref(a: Pick<AlbumOfDay, "album">): string {
	return `/release?id=${encodeURIComponent(albumOfDayId(a))}`;
}

/** Secondary line of the card: "Daft Punk · 2001" (either part may be missing). */
export function albumOfDayLine(artist: string, year: string): string {
	return [artist.trim(), year.trim()].filter(Boolean).join(" · ");
}
