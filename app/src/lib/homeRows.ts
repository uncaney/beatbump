// Pure helpers for the personal rows at the top of /home (Reprendre, Pour toi,
// Récemment acquis). Kept free of Svelte/store imports so they are unit-testable;
// the component (_PersonalRows.svelte) only fetches and hands the arrays over.

export type RowItem = Record<string, any>;

/** Stable identity of a card: a playable id first, else its browse id. */
export function rowItemRef(item: any): string {
	if (!item || typeof item !== "object") return "";
	return String(item.videoId || item.endpoint?.browseId || item.browseId || "");
}

/** A card needs a title and something to play or open. */
export function isRenderable(item: any): item is RowItem {
	return !!item && typeof item === "object" && typeof item.title === "string" && item.title !== "" && rowItemRef(item) !== "";
}

/** Keep renderable items, drop duplicates (by ref), cap to `max`. */
export function capItems(items: unknown, max: number): RowItem[] {
	if (!Array.isArray(items)) return [];
	const seen = new Set<string>();
	const out: RowItem[] = [];
	for (const it of items) {
		if (!isRenderable(it)) continue;
		const ref = rowItemRef(it);
		if (seen.has(ref)) continue;
		seen.add(ref);
		out.push(it);
		if (out.length >= max) break;
	}
	return out;
}

/** Parse the `lastTrack` entry persisted by +layout (Remember Last Track). */
export function readLastTrack(storage: { getItem(key: string): string | null } | undefined): RowItem | null {
	try {
		const raw = storage?.getItem("lastTrack");
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return isRenderable(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * "Reprendre": the last played track first, then the last `max` distinct plays.
 * `recent` is the profile history (me/stats/recent, most recent first). When it
 * is empty (call failed, offline, fresh profile) only the last track is shown:
 * the current session queue is NOT a resume (audit v3 G17), so the row stays
 * hidden on a fresh profile. The last track is never repeated inside the list.
 */
export function buildResumeRow(last: RowItem | null, recent: unknown, max = 10): RowItem[] {
	const head = last && isRenderable(last) ? [last] : [];
	const source = Array.isArray(recent) ? recent : [];
	const rest = capItems(source, max + head.length);
	const lastRef = head.length ? rowItemRef(head[0]) : "";
	return [...head, ...rest.filter((it) => rowItemRef(it) !== lastRef).slice(0, max)];
}

/** Label shown when a card has no usable artist name (never the string "undefined"). */
export const UNKNOWN_ARTIST = "Artiste inconnu";

/** First thumbnail URL of a card, "" when it has none. */
export function thumbnailUrl(item: any): string {
	const u = item?.thumbnails?.[0]?.url;
	return typeof u === "string" ? u.trim() : "";
}

const textOf = (v: any): string => {
	if (typeof v === "string") return v.trim();
	if (v && typeof v === "object") {
		const t = v.text ?? v.name;
		return typeof t === "string" ? t.trim() : "";
	}
	return "";
};

/** Artist name of a card: `artistInfo.artist[0].text`, then `artist`, then the first artist subtitle; "" when unknown. */
export function artistName(item: any): string {
	if (!item || typeof item !== "object") return "";
	const fromInfo = textOf(item.artistInfo?.artist?.[0]);
	if (fromInfo) return fromInfo;
	const fromArtist = textOf(item.artist);
	if (fromArtist) return fromArtist;
	if (Array.isArray(item.subtitle)) {
		const sub = item.subtitle.find((s: any) => /ARTIST/.test(s?.pageType || "") && textOf(s));
		if (sub) return textOf(sub);
	}
	return "";
}

/** A card the "Pour toi" row may show: renderable, with a cover and an artist (audit v3 1.1: "?" + "undefined" cards). */
export function hasCoverAndArtist(item: any): boolean {
	return isRenderable(item) && thumbnailUrl(item) !== "" && artistName(item) !== "";
}

/**
 * Copy of a card whose subtitle never renders "undefined": entries without a
 * string text are dropped; when a non-empty subtitle loses every entry, the
 * artist name (or UNKNOWN_ARTIST) is shown as a plain entry instead. Cards
 * without a subtitle are returned unchanged. Items are not mutated.
 */
export function sanitizeCard(item: RowItem): RowItem {
	if (!Array.isArray(item?.subtitle) || item.subtitle.length === 0) return item;
	const subtitle = item.subtitle
		.filter((s: any) => s && typeof s === "object" && typeof s.text === "string" && s.text.trim() !== "")
		.map((s: any) => ({ ...s }));
	if (subtitle.length === 0) subtitle.push({ text: artistName(item) || UNKNOWN_ARTIST });
	return { ...item, subtitle };
}

/** "Pour toi": cards with a cover and an artist, varied, capped to `max`, subtitles sanitized. */
export function buildForYouRow(items: unknown, max: number): RowItem[] {
	if (!Array.isArray(items)) return [];
	return diversify(capItems(items.filter(hasCoverAndArtist), max * 4), max, 1, 2).map(sanitizeCard);
}

/**
 * Keep a row varied: at most `perAlbum` items of the same album, `perArtist` of the same
 * artist, and never the same cover twice (audit UX v4 TOP 5: tracks of one album share a
 * cover even when the album key is missing). Items beyond the caps are kept in a second pass
 * only when the row would otherwise stay short, so a small pool still fills the row.
 */
export function diversify(items: RowItem[], max: number, perAlbum = 2, perArtist = 3): RowItem[] {
	const albums = new Map<string, number>();
	const artists = new Map<string, number>();
	const covers = new Set<string>();
	const out: RowItem[] = [];
	const skipped: RowItem[] = [];
	const key = (v: any) => (typeof v === "string" ? v : v?.browseId || v?.text || v?.name || "").toString().toLowerCase();
	const coverKey = (it: RowItem) => thumbnailUrl(it).replace(/=w\d+-h\d+.*$/, "").toLowerCase();
	for (const it of items) {
		if (out.length >= max) break;
		const al = key(it.album) || key(it.albumName);
		const ar = key(it.artistInfo?.artist?.[0]) || key(it.artist) || key(it.subtitle?.find?.((s: any) => /ARTIST/.test(s?.pageType || ""))?.text);
		const cv = coverKey(it);
		if (cv && covers.has(cv)) continue;
		if ((al && (albums.get(al) || 0) >= perAlbum) || (ar && (artists.get(ar) || 0) >= perArtist)) {
			skipped.push(it);
			continue;
		}
		if (al) albums.set(al, (albums.get(al) || 0) + 1);
		if (ar) artists.set(ar, (artists.get(ar) || 0) + 1);
		if (cv) covers.add(cv);
		out.push(it);
	}
	// Second pass: a small pool fills the row with the items the caps skipped (distinct covers only).
	for (const it of skipped) {
		if (out.length >= max) break;
		const cv = coverKey(it);
		if (cv && covers.has(cv)) continue;
		if (cv) covers.add(cv);
		out.push(it);
	}
	return out;
}
