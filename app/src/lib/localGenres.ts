// c29b EQ2: the "Dans ta bibliothèque" genre chips on Explore (/trending),
// built from GET /api/v1/local/genres (the same answer /library/genres
// renders: {genres: [{name, count}]}, most tracks first). Pure, testable.

export interface LocalGenreLink {
	name: string;
	count: number;
	/** The all-songs genre view the genres page already links to. */
	href: string;
}

export const EXPLORE_GENRES_MAX = 12;

/**
 * U12-5: junk tag values the backend (local/genres, normalizeGenres in
 * backend/api/local_genres.go) already drops; kept here so an older server
 * answer never lists them: empty, shorter than 2 characters, starting with
 * "_" ("_Soundtrack"), dotted abbreviations ("B.O.", "O.S.T").
 */
export function isJunkGenre(name: string): boolean {
	const n = name.trim();
	return [...n].length < 2 || n.startsWith("_") || /^(\p{L}\.)+\p{L}?\.?$/u.test(n);
}

/** L11-6: the one display name of every soundtrack spelling (same as the backend). */
export const SOUNDTRACK_GENRE = "Bande originale";
const SOUNDTRACK_KEY =
	/^(?:(?:original|originele|film|movie|motion picture|game|video game|tv) )?(?:sound ?tracks?(?: score)?|score|ost|bso|bof?|bande originale(?: de film)?|banda sonora(?: original)?|colonna sonora)(?: \(.*\))?$/;
/** "B.O.", "BSO", "OST", "Score", "_Soundtrack", "Bande originale"… */
export function isSoundtrackGenre(name: string): boolean {
	const k = name.trim().replace(/^_+/, "").toLowerCase().replace(/\./g, "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
	return k !== "" && SOUNDTRACK_KEY.test(k);
}
/** Slash names that are ONE genre (lowercase). */
const SLASH_WHOLE = new Set(["singer/songwriter", "ac/dc", "r&b/soul", "hip-hop/rap", "hip hop/rap"]);
const SLASH_MIN_SIDE = 4;
const clean = (p: string) => p.trim().replace(/\s+/g, " ");

/**
 * Split one raw tag value ("Rock;Blues Rock", "Rock, Britpop", "samba/bossa
 * nova") into clean names, with the backend rules (local_genres.go): ";", ","
 * and "|" always split; "/" only when every side has 4+ characters and the
 * value is not a known slash name ("Singer/Songwriter", "AC/DC"); soundtrack
 * spellings become "Bande originale".
 */
export function splitGenreValue(raw: string): string[] {
	const out: string[] = [];
	for (const s of raw.split(/[;,|]/)) {
		const seg = clean(s);
		if (!seg) continue;
		let parts = [seg];
		if (seg.includes("/") && !SLASH_WHOLE.has(seg.toLowerCase())) {
			const sides = seg.split("/").map(clean);
			if (sides.every((x) => [...x].length >= SLASH_MIN_SIDE)) parts = sides;
		}
		for (const p of parts) {
			if (isSoundtrackGenre(p)) out.push(SOUNDTRACK_GENRE);
			else if (!isJunkGenre(p)) out.push(p);
		}
	}
	return out;
}

/**
 * U12-5: the /library/genres list, tolerant of a raw answer: names split as
 * splitGenreValue does, junk dropped, case variants merged (first spelling kept,
 * counts summed), most tracks first then name.
 */
export function normalizeGenreList(resp: unknown): { name: string; count: number }[] {
	if (!resp || typeof resp !== "object") return [];
	const list = (resp as { genres?: unknown }).genres;
	if (!Array.isArray(list)) return [];
	const byKey = new Map<string, { name: string; count: number }>();
	for (const g of list) {
		const raw = typeof (g as { name?: unknown })?.name === "string" ? (g as { name: string }).name : "";
		const c = Number((g as { count?: unknown })?.count);
		const count = Number.isFinite(c) && c > 0 ? c : 0;
		const seen = new Set<string>();
		for (const name of splitGenreValue(raw)) {
			const key = name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			const cur = byKey.get(key);
			if (cur) cur.count += count;
			else byKey.set(key, { name, count });
		}
	}
	return [...byKey.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function genreHref(name: string): string {
	return `/library/all-songs?genre=${encodeURIComponent(name)}`;
}

/**
 * Up to `max` genres as links, in the order the backend gives (track count
 * desc), blank / malformed rows and duplicate names dropped. An empty or
 * malformed answer gives no link (the section stays hidden).
 */
export function localGenreLinks(resp: unknown, max = EXPLORE_GENRES_MAX): LocalGenreLink[] {
	if (!resp || typeof resp !== "object") return [];
	const list = (resp as { genres?: unknown }).genres;
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const out: LocalGenreLink[] = [];
	for (const g of list) {
		const name = typeof (g as { name?: unknown })?.name === "string" ? ((g as { name: string }).name).trim() : "";
		if (!name || isJunkGenre(name)) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const count = Number((g as { count?: unknown })?.count);
		out.push({ name, count: Number.isFinite(count) && count > 0 ? count : 0, href: genreHref(name) });
		if (out.length >= max) break;
	}
	return out;
}
