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
