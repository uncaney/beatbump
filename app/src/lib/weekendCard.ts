// B6-17 "Prépare ton week-end" (cycle 40, pack trajet): a compact home card,
// Friday to Sunday (viewer's local time), that opens the Hors-ligne page with
// a 2 h pack preselected. Dismissed for the ISO week (Friday, Saturday and
// Sunday share one Monday-based week). Pure helpers, unit-tested.
import { isoWeekKey } from "$lib/homeRows";

export const WEEKEND_CARD_DISMISS_KEY = "ytm-weekend-card";
export const WEEKEND_PACK_CHOICE = "dur:7200";
export const WEEKEND_PACK_HREF = `/library/downloads-offline?pack=${WEEKEND_PACK_CHOICE}`;

function weekOfStored(v: string | number | null | undefined): string | null {
	if (v === null || v === undefined || v === "") return null;
	const n = typeof v === "number" ? v : /^\d+$/.test(String(v).trim()) ? Number(v) : NaN;
	if (!Number.isFinite(n) || n <= 0) return null;
	return isoWeekKey(new Date(n));
}

/**
 * True on Friday, Saturday and Sunday (local `getDay()`: 5, 6, 0), unless
 * `dismissedAt` (the epoch ms stored by the "✕", as a number or string) falls
 * in the same ISO week as `now`. A dismissal from last weekend never hides it.
 */
export function shouldShowWeekendCard(now: Date, dismissedAt: string | number | null | undefined): boolean {
	const day = now.getDay();
	if (day !== 5 && day !== 6 && day !== 0) return false;
	return weekOfStored(dismissedAt) !== isoWeekKey(now);
}

/** The pack has something to take: at least one favourite or recent track. */
export function hasPackMaterial(favorites: ReadonlyArray<any> | null | undefined, recent: ReadonlyArray<any> | null | undefined): boolean {
	const isTrack = (x: any) => !!x && typeof x.videoId === "string" && x.videoId !== "";
	return (Array.isArray(favorites) && favorites.some(isTrack)) || (Array.isArray(recent) && recent.some(isTrack));
}
