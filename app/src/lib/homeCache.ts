// AP1 "instant home": a slim localStorage snapshot of the personal rows
// (Reprendre / Pour toi / Récemment acquis, and since c30a AP4 Redécouvrir /
// Nouveautés / Jamais écouté) painted immediately on mount, replaced in
// place once the live API answers. Kept free of Svelte/store
// imports so it is unit-testable; the component (_PersonalRows.svelte) only
// reads/writes through these pure helpers.

import type { RowItem } from "./homeRows";
import { albumOfDayFrom, utcDay, type AlbumOfDay } from "./albumOfDay";

/** localStorage key (versioned envelope: version + savedAt + profile scope + rows). */
export const HOME_CACHE_KEY = "ytm-home-cache";
// v2 (c30a AP4): six rows instead of three. A v1 envelope is ignored (not
// migrated): the live loads repaint everything within the second anyway.
// v3 (c39b B6-1): plus the "Album du jour" card (album, year, UTC date; not
// its tracks, fetched again on "Écouter"), painted only on its own UTC day.
export const HOME_CACHE_VERSION = 3;
// Ignored after 7 days: a week-old "Récemment acquis" is worse than nothing.
const HOME_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Bounded to ~120 slim cards total (6 rows x 20): enough to paint every row
// without the cache itself growing unbounded in localStorage.
export const HOME_CACHE_MAX_PER_ROW = 20;

export type HomeCacheRowKey = "reprendre" | "pourToi" | "recemmentAcquis" | "redecouvrir" | "nouveautes" | "jamaisEcoute";
export const HOME_CACHE_ROW_KEYS: readonly HomeCacheRowKey[] = ["reprendre", "pourToi", "recemmentAcquis", "redecouvrir", "nouveautes", "jamaisEcoute"];
export type HomeCacheRows = Record<HomeCacheRowKey, RowItem[]>;

interface HomeCacheEnvelope {
	v: number;
	savedAt: number;
	profileId: string;
	rows: HomeCacheRows;
	albumOfDay?: AlbumOfDay | null;
}

type StorageLike = {
	getItem(key: string): string | null;
	setItem?(key: string, value: string): void;
	removeItem?(key: string): void;
};

const emptyRows = (): HomeCacheRows => ({ reprendre: [], pourToi: [], recemmentAcquis: [], redecouvrir: [], nouveautes: [], jamaisEcoute: [] });

/**
 * Minimal copy of a card kept in the cache: just enough to render a
 * Carousel/CarouselItem tile and navigate or play from it. Drops YouTube's
 * tracking blobs (loggingContext, clickTrackingParams, params, itct, ...)
 * and every thumbnail but the first (same spirit as slimHistoryItem server
 * side, $lib/homeRows keeps the component boundary; this is the cache's own
 * copy so a slim schema is its own source of truth here).
 */
export function slimCard(item: RowItem): RowItem {
	if (!item || typeof item !== "object") return item;
	const out: RowItem = { title: item.title };
	if (Array.isArray(item.thumbnails) && item.thumbnails.length) out.thumbnails = [item.thumbnails[0]];
	if (item.subtitle !== undefined) out.subtitle = item.subtitle;
	if (item.videoId !== undefined) out.videoId = item.videoId;
	if (item.browseId !== undefined) out.browseId = item.browseId;
	if (item.endpoint !== undefined) out.endpoint = item.endpoint;
	if (item.playlistId !== undefined) out.playlistId = item.playlistId;
	if (item.type !== undefined) out.type = item.type;
	if (item.artistInfo !== undefined) out.artistInfo = item.artistInfo;
	if (item.album !== undefined) out.album = item.album;
	if (item.length !== undefined) out.length = item.length;
	return out;
}

/** Cap + slim a row's items to the cache budget. Not an array -> []. */
function boundRow(items: unknown): RowItem[] {
	if (!Array.isArray(items)) return [];
	return items.slice(0, HOME_CACHE_MAX_PER_ROW).map(slimCard);
}

export interface HomeCacheSnapshot {
	profileId: string;
	savedAt: number;
	rows: HomeCacheRows;
	/** c39b: today's (UTC) album of the day, null when absent or from another day. */
	albumOfDay: AlbumOfDay | null;
}

/** The cached album-of-day card, kept only while its UTC date is `today`. */
function cachedAlbumOfDay(raw: unknown, today: string): AlbumOfDay | null {
	const a = albumOfDayFrom(raw);
	return a && a.date === today ? { ...a, tracks: [] } : null;
}

/**
 * Read the cache ignoring the profile scope: any structurally valid,
 * non-expired envelope of the current version. Used for the optimistic first paint (before
 * `whoami()` resolves, so the profile id isn't known synchronously yet);
 * the caller compares `profileId` itself once it has one and drops the
 * paint on a mismatch. Any corruption/expiry answers null, never throws.
 */
export function peekHomeCache(storage: StorageLike | undefined, now: number = Date.now()): HomeCacheSnapshot | null {
	try {
		const raw = storage?.getItem(HOME_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<HomeCacheEnvelope> | null;
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.v !== HOME_CACHE_VERSION) return null;
		if (typeof parsed.profileId !== "string" || !parsed.profileId) return null;
		if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return null;
		if (now - parsed.savedAt > HOME_CACHE_MAX_AGE_MS) return null;
		const rows = parsed.rows as Partial<Record<HomeCacheRowKey, unknown>> | undefined;
		if (!rows || typeof rows !== "object") return null;
		const out = emptyRows();
		for (const k of HOME_CACHE_ROW_KEYS) {
			const v = rows[k];
			if (Array.isArray(v)) out[k] = v;
		}
		return {
			profileId: parsed.profileId,
			savedAt: parsed.savedAt,
			rows: out,
			albumOfDay: cachedAlbumOfDay(parsed.albumOfDay, utcDay(new Date(now))),
		};
	} catch {
		return null;
	}
}

/**
 * Read the cache, honoring the envelope version, the profile scope and the
 * 7-day TTL. Any mismatch, expiry or corruption answers null (never throws),
 * so a caller always falls back to an empty/live row.
 */
export function readHomeCache(storage: StorageLike | undefined, profileId: string): HomeCacheRows | null {
	const snap = peekHomeCache(storage);
	if (!snap || !profileId || snap.profileId !== profileId) return null;
	return snap.rows;
}

/**
 * Write the cache after a successful load of the personal rows. Best-effort:
 * a private-mode / quota failure never throws (the cache is an optimisation,
 * not a source of truth).
 */
export function writeHomeCache(
	storage: StorageLike | undefined,
	profileId: string,
	rows: Partial<HomeCacheRows>,
	albumOfDay?: AlbumOfDay | null,
): void {
	try {
		if (!storage?.setItem || !profileId) return;
		const bounded = emptyRows();
		for (const k of HOME_CACHE_ROW_KEYS) bounded[k] = boundRow(rows[k]);
		const envelope: HomeCacheEnvelope = {
			v: HOME_CACHE_VERSION,
			savedAt: Date.now(),
			profileId,
			rows: bounded,
			// The card only: its tracks (up to 300 rows) are not worth the bytes.
			albumOfDay: albumOfDay ? { album: slimCard(albumOfDay.album), year: albumOfDay.year, date: albumOfDay.date, tracks: [] } : null,
		};
		storage.setItem(HOME_CACHE_KEY, JSON.stringify(envelope));
	} catch {
		/* best-effort: private mode / quota */
	}
}

/** Drop the cache: logout (and any profile switch), so a stale profile's rows never flash for the next one. */
export function clearHomeCache(storage: StorageLike | undefined): void {
	try {
		storage?.removeItem?.(HOME_CACHE_KEY);
	} catch {
		/* no-op */
	}
}

/** Convenience: an empty row set, e.g. to reset local state on a profile mismatch. */
export function emptyHomeCacheRows(): HomeCacheRows {
	return emptyRows();
}

/**
 * L9-8: the six row loads of /home each finished with a full snapshot write
 * (50-100 KB of JSON.stringify + setItem on the main thread, five of them
 * overwritten at once). The component now `schedule()`s the write; it runs
 * once, `delayMs` after the last request, or right away on `flush()` (page
 * hidden, component destroyed). Pure (timers injectable) for the tests.
 */
export const HOME_CACHE_PERSIST_DELAY_MS = 600;

export interface PersistScheduler {
	/** (Re)arm the trailing write. */
	schedule(): void;
	/** Run a pending write now; no-op when none is pending. */
	flush(): void;
	/** Drop a pending write. */
	cancel(): void;
}

export function createPersistScheduler(
	write: () => void,
	delayMs: number = HOME_CACHE_PERSIST_DELAY_MS,
	// Wrapped, not referenced: calling `timers.set(...)` would invoke window.setTimeout with
	// `this === timers`, which browsers reject with "Illegal invocation" (chain 35: 42 page
	// errors on /home). Node (vitest) does not care, which is why the test passed.
	timers: { set: typeof setTimeout; clear: typeof clearTimeout } = {
		set: ((fn: TimerHandler, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout,
		clear: ((t?: ReturnType<typeof setTimeout>) => clearTimeout(t)) as typeof clearTimeout,
	},
): PersistScheduler {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = () => {
		timer = undefined;
		write();
	};
	return {
		schedule() {
			if (timer !== undefined) timers.clear(timer);
			timer = timers.set(run, delayMs);
		},
		flush() {
			if (timer === undefined) return;
			timers.clear(timer);
			run();
		},
		cancel() {
			if (timer !== undefined) timers.clear(timer);
			timer = undefined;
		},
	};
}
