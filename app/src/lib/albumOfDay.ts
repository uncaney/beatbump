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

/**
 * L15-8: the backend changes its pick (album and artist of the day) at
 * 00:00 UTC (local_album_day.go, local_artist_day.go): the local wall-clock
 * time of the NEXT 00:00 UTC, "02:00" in Paris in summer, "01:00" in winter,
 * "00:00" in London in winter. `timeZone` is for tests; the viewer's zone
 * otherwise. Empty when Intl cannot format (then the caller says "minuit UTC").
 */
export function nextPickLocalTime(now: Date = new Date(), timeZone?: string): string {
	const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
	try {
		return next.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
	} catch {
		return "";
	}
}

/**
 * B9-27 / L15-8: the steady subtitle of the "Aujourd'hui" row: "Le même pour
 * tout le monde, un autre à 02:00 (minuit UTC)". It used to promise "minuit
 * (UTC+2)": neither the hour (the switch is at 00:00 UTC) nor the fixed
 * offset (wrong from the last Sunday of October) held.
 */
export function todaySubtitle(now: Date = new Date(), timeZone?: string): string {
	const t = nextPickLocalTime(now, timeZone);
	if (!t || t === "00:00") return "Le même pour tout le monde, un autre à minuit UTC";
	return `Le même pour tout le monde, un autre à ${t} (minuit UTC)`;
}
