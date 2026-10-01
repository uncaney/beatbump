/**
 * BI2: remembered sort + filter per collection route, and the A-Z index
 * helpers. Pure (storage is injected) so the persistence rules are unit
 * tested; `_Browse.svelte` wires them to localStorage.
 */

export interface SortPrefs {
	sort: string;
	q: string;
}

/** A minimal Storage: localStorage, or an in-memory stand-in in tests. */
export interface PrefStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

export const SORT_KEY_PREFIX = "ytm-sort:";

/** localStorage key of a route: `ytm-sort:<pathname>` (query/hash dropped). */
export function sortKey(pathname: string): string {
	const p = String(pathname || "/").split(/[?#]/)[0] || "/";
	return SORT_KEY_PREFIX + p;
}

function browserStorage(): PrefStorage | null {
	try {
		if (typeof localStorage === "undefined") return null;
		return localStorage;
	} catch {
		return null; // SecurityError in some private modes
	}
}

/**
 * Restore the remembered prefs of `pathname`. `allowedSorts` is the page's
 * option list: a remembered sort that is no longer offered falls back to
 * `fallback` (the first option), so a renamed option never sends an unknown
 * `?sort=` (the API answers 400 on those). Missing / corrupt storage gives
 * the defaults. Never throws.
 */
export function loadSortPrefs(
	pathname: string,
	allowedSorts: string[],
	fallback: string,
	storage: PrefStorage | null = browserStorage(),
): SortPrefs {
	const out: SortPrefs = { sort: fallback, q: "" };
	if (!storage) return out;
	try {
		const raw = storage.getItem(sortKey(pathname));
		if (!raw) return out;
		const parsed = JSON.parse(raw) as Partial<SortPrefs> | null;
		if (!parsed || typeof parsed !== "object") return out;
		if (typeof parsed.sort === "string" && allowedSorts.includes(parsed.sort)) out.sort = parsed.sort;
		if (typeof parsed.q === "string") out.q = parsed.q.slice(0, 200);
	} catch {
		/* corrupt JSON or blocked storage: defaults */
	}
	return out;
}

/** Persist the prefs of `pathname` (defaults are stored too: "I chose Recently added" is a choice). Never throws. */
export function saveSortPrefs(pathname: string, prefs: SortPrefs, storage: PrefStorage | null = browserStorage()): void {
	if (!storage) return;
	try {
		storage.setItem(sortKey(pathname), JSON.stringify({ sort: prefs.sort, q: prefs.q ?? "" }));
	} catch {
		/* quota / private mode: the choice just is not remembered */
	}
}

// ---- A-Z index ----

/** The letters of the index: A..Z then "#" (digits, symbols, non-Latin). */
export const AZ_LETTERS: readonly string[] = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];

/**
 * Index letter of a title: its first Latin letter, accents stripped and
 * upper-cased ("Édith" -> "E", "élan" -> "E"); "#" when the title starts
 * with a digit, a symbol or a non-Latin script, or is empty. A leading
 * "The " / "Les " is NOT skipped: the server sorts on the raw title, and the
 * index must follow the list order.
 */
export function initialOf(title: unknown): string {
	const s = String(title ?? "").trim();
	if (!s) return "#";
	const first = s[0].normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
	return /^[A-Z]$/.test(first) ? first : "#";
}

/**
 * Sort rank of an index letter in a title-ordered list: A..Z in order, "#"
 * before "A" (Meili sorts digits / symbols before letters). Used to stop a
 * seek once the list went past the wanted letter.
 */
export function letterRank(letter: string): number {
	if (letter === "#") return -1;
	const i = AZ_LETTERS.indexOf(letter);
	return i < 0 ? -1 : i;
}

/**
 * Whether the A-Z index applies: the list is sorted by its title field
 * (`album` for albums, `name` for artists), either direction.
 */
export function isTitleSort(kind: string, sort: string): boolean {
	const field = String(sort || "").split(":")[0];
	return (kind === "albums" && field === "album") || (kind === "artists" && field === "name");
}

/**
 * Index of the first row whose initial is `letter` in `rows` (by their
 * `title`), or -1. With `desc`, the list runs Z..A: the first row of the
 * letter is still the first match.
 */
export function findLetterIndex(rows: ReadonlyArray<{ title?: unknown }>, letter: string): number {
	return rows.findIndex((r) => initialOf(r?.title) === letter);
}

/**
 * Whether a seek for `letter` should keep loading pages: false once the
 * loaded list's last row already sorts past the letter (ascending: a later
 * letter; descending: an earlier one), since every row still to come sorts
 * further away. True on an empty list.
 */
export function seekShouldContinue(rows: ReadonlyArray<{ title?: unknown }>, letter: string, desc: boolean): boolean {
	if (rows.length === 0) return true;
	const last = letterRank(initialOf(rows[rows.length - 1]?.title));
	const want = letterRank(letter);
	return desc ? last > want : last < want;
}

/**
 * L8-8: an A-Z seek loads at most this many extra pages (of `seekLimit`
 * rows, 200) before giving up with "Lettre trop loin, utilise le filtre".
 * 5 x 200 = 1 000 rows on top of what is loaded: a phone can hold that in
 * the DOM; the 6 800-album index at "Z" cannot be reached by scrolling.
 */
export const SEEK_MAX_PAGES = 5;

export type SeekStep = "found" | "load" | "too_far" | "absent";

/**
 * Next step of an A-Z seek for `letter` given the rows loaded so far,
 * `pagesLoaded` pages fetched by this seek and whether the list is `done`:
 * "found" when a row of the letter is loaded, "absent" when the list is
 * exhausted or already went past the letter (nothing to scroll to),
 * "too_far" when the page budget is spent, else "load" (fetch one more
 * page). Pure, so the bound is unit tested.
 */
export function seekStep(
	rows: ReadonlyArray<{ title?: unknown }>,
	letter: string,
	desc: boolean,
	pagesLoaded: number,
	done: boolean,
	maxPages = SEEK_MAX_PAGES,
): SeekStep {
	if (findLetterIndex(rows, letter) >= 0) return "found";
	if (done || !seekShouldContinue(rows, letter, desc)) return "absent";
	if (pagesLoaded >= maxPages) return "too_far";
	return "load";
}
