// UX9 (cycle 35): the tracks whose "Garder hors-ligne" / pack download
// failed (`failed` of $lib/offlineBatch keepOffline: download or pin
// impossible, not quota refusals, not cancellations). Every keep job records
// its failures here (startKeepJob), a later success of the same track clears
// it, and the Hors-ligne page shows "N téléchargements ont échoué" with a
// "Réessayer" that re-queues them through keepOffline. In memory for the
// session (a reload starts clean, the tracks are not in the cache anyway).
// Pure list helpers + the store, covered by offlineFailed.test.ts.
import { get, writable, type Readable } from "svelte/store";

/** Most failures kept (oldest dropped first). */
export const FAILED_MAX = 200;

function idOf(t: any): string {
	return t && typeof t.videoId === "string" ? t.videoId : "";
}

/** `list` plus `tracks` (one entry per videoId, the latest copy wins, at most FAILED_MAX). */
export function addFailed(list: any[], tracks: any[]): any[] {
	const add = (Array.isArray(tracks) ? tracks : []).filter((t) => idOf(t));
	if (!add.length) return list;
	const ids = new Set(add.map(idOf));
	const out = list.filter((t) => !ids.has(idOf(t)));
	for (const t of add) {
		const i = out.findIndex((x) => idOf(x) === idOf(t));
		if (i !== -1) out.splice(i, 1);
		out.push(t);
	}
	return out.length > FAILED_MAX ? out.slice(out.length - FAILED_MAX) : out;
}

/** `list` without the tracks of `ids`. */
export function removeFailed(list: any[], ids: string[]): any[] {
	const drop = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
	if (!drop.size) return list;
	const out = list.filter((t) => !drop.has(idOf(t)));
	return out.length === list.length ? list : out;
}

/** The page line: "1 téléchargement a échoué", "3 téléchargements ont échoué". */
export function failedLine(n: number): string {
	return n > 1 ? `${n} téléchargements ont échoué` : `${n} téléchargement a échoué`;
}

const _failed = writable<any[]>([]);
/** Failed keep / pack downloads, oldest first. */
export const failedDownloads: Readable<any[]> = { subscribe: _failed.subscribe };

/** A keep / pack download failed for `t`. */
export function recordFailed(t: any): void {
	if (!idOf(t)) return;
	_failed.update((l) => addFailed(l, [t]));
}

/** `videoId` is ready offline now (any keep job): no longer failed. */
export function clearFailed(videoId: string | null | undefined): void {
	if (!videoId) return;
	_failed.update((l) => removeFailed(l, [videoId]));
}

/** The failed tracks right now (a retry snapshot). */
export function failedSnapshot(): any[] {
	return [...get(_failed)];
}

/** Tests only. */
export function resetFailed(): void {
	_failed.set([]);
}
