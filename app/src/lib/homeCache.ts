// AP1 "instant home": a slim localStorage snapshot of the personal rows
// (Reprendre / Pour toi / Récemment acquis) painted immediately on mount,
// replaced in place once the live API answers. Kept free of Svelte/store
// imports so it is unit-testable; the component (_PersonalRows.svelte) only
// reads/writes through these pure helpers.

import type { RowItem } from "./homeRows";

/** localStorage key (v1 envelope: version + savedAt + profile scope + rows). */
export const HOME_CACHE_KEY = "ytm-home-cache";
const HOME_CACHE_VERSION = 1;
// Ignored after 7 days: a week-old "Récemment acquis" is worse than nothing.
const HOME_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Bounded to ~60 slim cards total (3 rows x 20): enough to paint every row
// without the cache itself growing unbounded in localStorage.
export const HOME_CACHE_MAX_PER_ROW = 20;

export type HomeCacheRowKey = "reprendre" | "pourToi" | "recemmentAcquis";
export type HomeCacheRows = Record<HomeCacheRowKey, RowItem[]>;

interface HomeCacheEnvelope {
	v: number;
	savedAt: number;
	profileId: string;
	rows: HomeCacheRows;
}

type StorageLike = {
	getItem(key: string): string | null;
	setItem?(key: string, value: string): void;
	removeItem?(key: string): void;
};

const emptyRows = (): HomeCacheRows => ({ reprendre: [], pourToi: [], recemmentAcquis: [] });

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
}

/**
 * Read the cache ignoring the profile scope: any structurally valid,
 * non-expired v1 envelope. Used for the optimistic first paint (before
 * `whoami()` resolves, so the profile id isn't known synchronously yet);
 * the caller compares `profileId` itself once it has one and drops the
 * paint on a mismatch. Any corruption/expiry answers null, never throws.
 */
export function peekHomeCache(storage: StorageLike | undefined): HomeCacheSnapshot | null {
	try {
		const raw = storage?.getItem(HOME_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<HomeCacheEnvelope> | null;
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.v !== HOME_CACHE_VERSION) return null;
		if (typeof parsed.profileId !== "string" || !parsed.profileId) return null;
		if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return null;
		if (Date.now() - parsed.savedAt > HOME_CACHE_MAX_AGE_MS) return null;
		const rows = parsed.rows;
		if (!rows || typeof rows !== "object") return null;
		return {
			profileId: parsed.profileId,
			savedAt: parsed.savedAt,
			rows: {
				reprendre: Array.isArray(rows.reprendre) ? rows.reprendre : [],
				pourToi: Array.isArray(rows.pourToi) ? rows.pourToi : [],
				recemmentAcquis: Array.isArray(rows.recemmentAcquis) ? rows.recemmentAcquis : [],
			},
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
export function writeHomeCache(storage: StorageLike | undefined, profileId: string, rows: Partial<HomeCacheRows>): void {
	try {
		if (!storage?.setItem || !profileId) return;
		const envelope: HomeCacheEnvelope = {
			v: HOME_CACHE_VERSION,
			savedAt: Date.now(),
			profileId,
			rows: {
				reprendre: boundRow(rows.reprendre),
				pourToi: boundRow(rows.pourToi),
				recemmentAcquis: boundRow(rows.recemmentAcquis),
			},
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
