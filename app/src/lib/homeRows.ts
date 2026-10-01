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

/** localStorage key of the offline track list (same as `KEY` in $lib/offline). */
export const OFFLINE_TRACKS_KEY = "ytm-offline-tracks";

/**
 * Tracks really held by the offline cache (`_cached === true`, kept in sync
 * with the service worker by reconcileOfflineList), most recently cached first.
 */
export function readCachedTracks(storage: { getItem(key: string): string | null } | undefined): RowItem[] {
	try {
		const list = JSON.parse(storage?.getItem(OFFLINE_TRACKS_KEY) || "[]");
		if (!Array.isArray(list)) return [];
		return list
			.filter((t: any) => t && t._cached === true && t._evicted !== true)
			.sort((a: any, b: any) => (Number(b?._at) || 0) - (Number(a?._at) || 0));
	} catch {
		return [];
	}
}

/**
 * Default "Reprendre" fallback (audit v4 H8): only while the device is offline,
 * the cached tracks. Online, an empty history stays empty (G17: fresh profile).
 */
export function offlineResumeFallback(): RowItem[] {
	try {
		if (typeof navigator === "undefined" || navigator.onLine !== false) return [];
		return readCachedTracks(typeof localStorage === "undefined" ? undefined : localStorage);
	} catch {
		return [];
	}
}

/**
 * "Reprendre": the last played track first, then the last `max` distinct plays.
 * `recent` is the profile history (me/stats/recent, most recent first). When it
 * is empty: offline (H8, me/* answers {"offline":true}) the cached tracks from
 * `fallback`, most recent first; online (failed call, fresh profile) only the
 * last track is shown: the current session queue is NOT a resume (audit v3
 * G17), so the row stays hidden on a fresh profile. The last track is never
 * repeated inside the list.
 */
export function buildResumeRow(
	last: RowItem | null,
	recent: unknown,
	max = 10,
	fallback: () => unknown = offlineResumeFallback,
): RowItem[] {
	const head = last && isRenderable(last) ? [last] : [];
	let source: unknown[] = Array.isArray(recent) ? recent : [];
	if (capItems(source, 1).length === 0) {
		const fb = fallback();
		source = Array.isArray(fb) ? fb : [];
	}
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

// ---- D3 "Redécouvrir" (c29b) ----
/** Fewer rows than this and the "Redécouvrir" row is not shown at all. */
export const REDISCOVER_MIN = 6;

/**
 * "Redécouvrir": the me/stats/rediscover items (tracks played >= 3 times
 * more than 60 days ago and not once in the last 30 days), renderable,
 * deduped, subtitles sanitized, capped to `max`. Under REDISCOVER_MIN
 * usable rows the row is empty (hidden), so a fresh or light profile never
 * sees a two-card row.
 */
export function buildRediscoverRow(items: unknown, max = 12, min = REDISCOVER_MIN): RowItem[] {
	const rows = capItems(items, max).map(sanitizeCard);
	return rows.length >= min ? rows : [];
}

// ---- F1 / F2 (c30a): one card once, at most 4 personal rows above YouTube ----

/** A personal row as the component holds it: its `data-row` key and its cards. */
export interface HomeRowInput {
	key: string;
	items: RowItem[] | null | undefined;
	/** Keep the row even with no card (Reprendre carries pills / the week card). */
	keepEmpty?: boolean;
	/**
	 * Cap applied AFTER the dedupe, so a low-priority row can be fetched
	 * longer than it shows (Récemment acquis: 40 fetched, 20 shown) and still
	 * fill up once the higher-priority rows took their cards.
	 */
	max?: number;
	/**
	 * F1: an album row that LOST cards to the dedupe and ends under this many
	 * is hidden (a 2-card leftover row reads as broken). A row the dedupe did
	 * not touch keeps its cards whatever their count (small libraries).
	 */
	minAfterDedupe?: number;
}

export interface HomeRow {
	key: string;
	items: RowItem[];
}

export interface ArrangedHomeRows {
	/** Rows painted above the first YouTube row, in HOME_ROW_ORDER. */
	visible: HomeRow[];
	/** Rows folded behind the "Plus pour toi" toggle, in HOME_ROW_ORDER. */
	more: HomeRow[];
}

/** Which row keeps a card present in several rows: the first key here wins. */
export const HOME_ROW_PRIORITY = ["reprendre", "pour-toi", "redecouvrir", "nouveautes-artistes", "jamais-ecoute", "recemment-acquis"];
/** Paint order of the personal rows on /home. */
export const HOME_ROW_ORDER = ["reprendre", "pour-toi", "recemment-acquis", "nouveautes-artistes", "redecouvrir", "jamais-ecoute"];
/** Rows that always take a visible slot when they have something to show. */
export const HOME_PINNED_ROWS = ["reprendre", "pour-toi"];
/** F2: personal rows painted above the first YouTube row. */
export const HOME_MAX_VISIBLE_ROWS = 4;
/** F1: an album row that lost cards to the dedupe needs this many to stay. */
export const ALBUM_ROW_MIN = 4;
/** localStorage key of the "Plus pour toi" toggle ("1" = unfolded). */
export const HOME_MORE_ROWS_KEY = "ytm-home-more-rows";

/**
 * F1 + F2: dedupe the cards across the personal rows (a ref - videoId or
 * browseId - appears in one row only, the row earliest in HOME_ROW_PRIORITY
 * keeps it) and cap the rows painted above the first YouTube row to
 * `maxVisible`: the pinned rows (Reprendre, Pour toi) first, then the best
 * filled of the remaining rows; the rest go to `more`. Both lists follow
 * HOME_ROW_ORDER so a row never changes place as the others load. Empty rows
 * are dropped unless `keepEmpty`; see HomeRowInput.minAfterDedupe for the
 * album rows, and `max` for a cap applied after the dedupe. A row whose
 * cards all survive (and fit `max`) keeps its very array (reference
 * equality), so an untouched Carousel does not re-render. Pure: inputs are
 * never mutated.
 */
export function arrangeHomeRows(
	rows: HomeRowInput[],
	opts: { maxVisible?: number; pinned?: string[] } = {},
): ArrangedHomeRows {
	const maxVisible = Math.max(0, opts.maxVisible ?? HOME_MAX_VISIBLE_ROWS);
	const pinnedKeys = opts.pinned ?? HOME_PINNED_ROWS;
	const priorityOf = (key: string, i: number) => {
		const p = HOME_ROW_PRIORITY.indexOf(key);
		return p >= 0 ? p : HOME_ROW_PRIORITY.length + i;
	};
	const orderOf = (key: string, i: number) => {
		const p = HOME_ROW_ORDER.indexOf(key);
		return p >= 0 ? p : HOME_ROW_ORDER.length + i;
	};

	// 1. dedupe, highest-priority row first
	const indexed = rows.map((row, i) => ({ row, i }));
	indexed.sort((a, b) => priorityOf(a.row.key, a.i) - priorityOf(b.row.key, b.i));
	const seen = new Set<string>();
	const kept: { key: string; items: RowItem[]; order: number }[] = [];
	for (const { row, i } of indexed) {
		const source = Array.isArray(row.items) ? row.items : [];
		const deduped: RowItem[] = [];
		for (const it of source) {
			const ref = rowItemRef(it);
			if (ref && seen.has(ref)) continue;
			if (ref) seen.add(ref);
			deduped.push(it);
		}
		let items = deduped.length === source.length ? source : deduped;
		if (typeof row.max === "number" && row.max >= 0 && items.length > row.max) items = items.slice(0, row.max);
		const lost = source.length - deduped.length;
		if (items.length === 0 && !row.keepEmpty) continue;
		if (lost > 0 && typeof row.minAfterDedupe === "number" && items.length < row.minAfterDedupe) continue;
		kept.push({ key: row.key, items, order: orderOf(row.key, i) });
	}
	kept.sort((a, b) => a.order - b.order);

	// 2. visible slots: pinned rows, then the best filled of the others
	const pinned = kept.filter((r) => pinnedKeys.includes(r.key)).slice(0, maxVisible);
	const rest = kept.filter((r) => !pinnedKeys.includes(r.key));
	const slots = Math.max(0, maxVisible - pinned.length);
	const picked = new Set(
		rest
			.slice()
			.sort((a, b) => b.items.length - a.items.length || a.order - b.order)
			.slice(0, slots)
			.map((r) => r.key),
	);
	const visible = kept.filter((r) => pinned.includes(r) || picked.has(r.key));
	const more = rest.filter((r) => !picked.has(r.key));
	const strip = (r: { key: string; items: RowItem[] }): HomeRow => ({ key: r.key, items: r.items });
	return { visible: visible.map(strip), more: more.map(strip) };
}

/** "1" in localStorage = the folded rows are open. Never throws. */
export function readMoreRowsOpen(storage: { getItem(key: string): string | null } | undefined): boolean {
	try {
		return storage?.getItem(HOME_MORE_ROWS_KEY) === "1";
	} catch {
		return false;
	}
}

// ---- ST1 "Ta semaine" card ----
// localStorage key: the dismissed ISO week ("YYYY-Www"); the card shows again
// once a new week starts even if the previous one was dismissed.
export const WEEK_CARD_DISMISS_KEY = "ytm-week-card";

/** ISO-8601 week key ("YYYY-Www", Monday-based weeks, year of the week's Thursday). */
export function isoWeekKey(d: Date): string {
	// Work in UTC on the LOCAL calendar date (not a UTC conversion of the
	// instant) so the week boundary matches the viewer's own Monday.
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const dayMon0 = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
	date.setUTCDate(date.getUTCDate() - dayMon0 + 3); // that week's Thursday
	const year = date.getUTCFullYear();
	const firstThursday = new Date(Date.UTC(year, 0, 4));
	const firstDayMon0 = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayMon0 + 3);
	const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
	return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * ST1: the week card shows only on Monday, viewer's local time (`now.getDay()`,
 * not UTC), and only until it is dismissed for THAT ISO week - a dismissal
 * from a previous week never hides it again.
 */
export function shouldShowWeekCard(now: Date, dismissedWeekKey: string | null | undefined): boolean {
	if (now.getDay() !== 1) return false;
	return dismissedWeekKey !== isoWeekKey(now);
}
