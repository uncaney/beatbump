// 41A (B6-13) "Partager ma semaine": the profile shares ITS OWN last 7 days
// (decision 6: nothing is exposed server side, the person sends the text
// themselves). Text: "Cette semaine : 212 min, 34 titres, artiste n°1 Daft
// Punk", plus the top album's /release?id= link when it has one. Pure: the
// numbers come from me/stats (meStats.loadWeekShare).
import { formatCountFr, formatIntFr, NNBSP } from "$lib/utils/formatFr";
import { canonicalShareURL } from "$lib/utils/shareLink";

export interface WeekShare {
	minutes: number;
	tracks: number;
	topArtist: string;
	topAlbum?: string;
	topAlbumId?: string;
}

/** "Cette semaine : 212 min, 34 titres, artiste n°1 Daft Punk". */
export function weekShareText(w: WeekShare): string {
	const parts = [`${formatIntFr(Math.round(w.minutes || 0))}${NNBSP}min`, formatCountFr(w.tracks || 0, "titre")];
	if (w.topArtist?.trim()) parts.push(`artiste n°1 ${w.topArtist.trim()}`);
	return `Cette semaine : ${parts.join(", ")}`;
}

/** Web Share payload: the text, and the top album link (else the site). */
export function weekShareData(w: WeekShare, origin: string): { title: string; text: string; url: string } {
	const url = w.topAlbumId ? canonicalShareURL("album", w.topAlbumId, origin) : `${origin.replace(/\/+$/, "")}/`;
	return { title: "Ma semaine en musique", text: weekShareText(w), url };
}

/** What the clipboard fallback copies: text, then the link on its own line. */
export function weekShareCopy(d: { text: string; url: string }): string {
	return `${d.text}\n${d.url}`;
}

// ---- c45b (B7-11) "Partager mon année": the same, over the calendar year ----
// Numbers come from me/stats/year (the profile's OWN year, decision 6:
// nothing new is exposed server side). Text: "Mon année 2026 : 1 234 min,
// artistes n°1 Daft Punk, Air et Justice, album n°1 Discovery, 12 albums
// différents, 5 nouveaux artistes", link = the album n°1 (/release?id=lb-...).

export interface YearShare {
	year: number;
	minutes: number;
	topArtists: string[]; // up to 3, most played first
	topAlbum?: string;
	topAlbumId?: string;
	albums: number; // distinct albums
	newArtists: number;
}

/** "Daft Punk", "Daft Punk et Air", "Daft Punk, Air et Justice". */
function listFr(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;
}

/** The share text of a year; artists / album / discoveries are dropped when absent. */
export function yearShareText(y: YearShare): string {
	const parts = [`${formatIntFr(Math.round(y.minutes || 0))}${NNBSP}min`];
	const artists = (y.topArtists || []).map((a) => (a || "").trim()).filter(Boolean).slice(0, 3);
	if (artists.length === 1) parts.push(`artiste n°1 ${artists[0]}`);
	else if (artists.length > 1) parts.push(`artistes n°1 ${listFr(artists)}`);
	if (y.topAlbum?.trim()) parts.push(`album n°1 ${y.topAlbum.trim()}`);
	if (y.albums > 0) parts.push(formatCountFr(y.albums, "album différent", "albums différents"));
	if (y.newArtists > 0) parts.push(formatCountFr(y.newArtists, "nouvel artiste", "nouveaux artistes"));
	return `Mon année ${y.year} : ${parts.join(", ")}`;
}

/** Web Share payload of a year: the text, and the album n°1 link (else the site). */
export function yearShareData(y: YearShare, origin: string): { title: string; text: string; url: string } {
	const url = y.topAlbumId ? canonicalShareURL("album", y.topAlbumId, origin) : `${origin.replace(/\/+$/, "")}/`;
	return { title: `Mon année ${y.year} en musique`, text: yearShareText(y), url };
}

/** The shape of me/stats/year this builder reads (meStats.YearView is a superset). */
export interface YearShareSource {
	year: number;
	plays: number;
	minutes: number;
	topArtist?: { title: string } | null;
	topArtists?: { title: string }[] | null;
	topAlbum?: { title: string; albumId?: string } | null;
	distinctAlbums?: number;
	newArtists?: number;
}

/** What to share from a me/stats/year answer; null without a play that year. */
export function yearShareFrom(v: YearShareSource | null | undefined): YearShare | null {
	if (!v || !(v.plays > 0)) return null;
	let artists = (Array.isArray(v.topArtists) ? v.topArtists : []).map((a) => a?.title ?? "").filter(Boolean);
	if (!artists.length && v.topArtist?.title) artists = [v.topArtist.title]; // older server: one artist
	return {
		year: v.year,
		minutes: v.minutes || 0,
		topArtists: artists.slice(0, 3),
		topAlbum: v.topAlbum?.title || undefined,
		topAlbumId: v.topAlbum?.albumId || undefined,
		albums: v.distinctAlbums || 0,
		newArtists: v.newArtists || 0,
	};
}
