// c44a B7-1 "Un artiste jamais écouté par jour": pure helpers for the home
// card fed by GET /api/v1/local/artist-of-the-day (one local artist with
// >= 2 albums per UTC day; for a named profile one it never played, for an
// anonymous profile the same pick for everyone). No Svelte or store import
// so it is unit-testable.

import { formatCountFr } from "./utils/formatFr";
import type { RowItem } from "./homeRows";

export const ARTIST_OF_DAY_URL = "/api/v1/local/artist-of-the-day";
/** data-row key of the card in arrangeHomeRows (a bonus slot, like the album of the day). */
export const ARTIST_OF_DAY_ROW = "artiste-du-jour";
/** How many of the artist's titles "Écouter" draws its mix from. */
export const ARTIST_OF_DAY_MIX_FETCH = 200;

export interface ArtistOfDay {
	/** The artist card (localArtistItem: title, thumbnails, browseId "la-…"). */
	artist: RowItem;
	name: string;
	albumCount: number;
	trackCount: number;
	/** "profile": never played by the named profile; "library": the pick of the whole library. */
	scope: "profile" | "library";
	/** "du jour", or "all_played" when every artist was played (the library pick is shown). */
	reason: string;
	/** UTC day the pick belongs to ("2026-10-02"). */
	date: string;
}

/** Parse the endpoint answer; null when there is no usable local artist. */
export function artistOfDayFrom(resp: unknown): ArtistOfDay | null {
	if (!resp || typeof resp !== "object") return null;
	const r = resp as Record<string, unknown>;
	const artist = r.artist as RowItem | null | undefined;
	if (!artist || typeof artist !== "object") return null;
	const id = String(artist.browseId || artist.endpoint?.browseId || "");
	if (!id.startsWith("la-")) return null;
	const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : typeof artist.title === "string" ? artist.title.trim() : "";
	if (!name) return null;
	const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "";
	if (!date) return null;
	const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
	return {
		artist,
		name,
		albumCount: count(r.albumCount),
		trackCount: count(r.trackCount),
		scope: r.scope === "profile" ? "profile" : "library",
		reason: typeof r.reason === "string" ? r.reason : "",
		date,
	};
}

/** Browse id of the card's artist ("la-…"). */
export function artistOfDayId(a: Pick<ArtistOfDay, "artist">): string {
	return String(a.artist.browseId || a.artist.endpoint?.browseId || "");
}

/** "/artist/la-…": the artist page ("Voir") and the playback context link. */
export function artistOfDayHref(a: Pick<ArtistOfDay, "artist">): string {
	return `/artist/${encodeURIComponent(artistOfDayId(a))}`;
}

/** Secondary line of the card: "3 albums · 31 titres" (a zero count is left out). */
export function artistOfDayLine(albumCount: number, trackCount: number): string {
	return [albumCount > 0 ? formatCountFr(albumCount, "album") : "", trackCount > 0 ? formatCountFr(trackCount, "titre") : ""]
		.filter(Boolean)
		.join(" · ");
}

/** Subheading of the card, by scope and reason. */
export function artistOfDaySubheading(a: Pick<ArtistOfDay, "scope" | "reason">): string {
	if (a.scope === "profile" && a.reason === "all_played") return "Tu as déjà tout écouté : un artiste de ta bibliothèque à retrouver";
	if (a.scope === "profile") return "Un artiste de ta bibliothèque que tu n'as jamais écouté";
	return "Un artiste de ta bibliothèque à découvrir, le même pour tout le monde aujourd'hui";
}

/** The titles "Écouter" shuffles: the artist's local songs (albumArtist filter of GET local/songs). */
export function artistOfDaySongsUrl(a: Pick<ArtistOfDay, "name">, limit = ARTIST_OF_DAY_MIX_FETCH): string {
	return `/api/v1/local/songs?artist=${encodeURIComponent(a.name)}&limit=${limit}`;
}
