// HL3 "Préparer un pack": pick the tracks of a sized offline pack (100 / 250 /
// 500 Mo) out of what the profile listens to: not-yet-cached favourites first,
// then recent plays, then the me/mix items, deduped by videoId, each counted
// at its known size (`_bytes`, or `sizes`) else PACK_EST_BYTES. Pure (no SW /
// network): the settings page fetches the three sources, plans, then hands
// the items to keepOffline (downloaded + pinned, 2 at a time, cancellable).
import { isListened } from "$lib/listenLog";
import { keepableTracks } from "$lib/offlineBatch";
import { durationOf } from "$lib/offlineQueue";
import { formatBytesFr, formatMoFr } from "$lib/utils/formatFr";
import { formatDuration } from "$lib/utils/releaseMeta";

/** Size guess for a track never downloaded (a ~3-4 min Opus / AAC stream). */
export const PACK_EST_BYTES = 4 * 1024 * 1024;
export const PACK_SIZES_MB = [100, 250, 500] as const;
/** B6-16 "pack trajet": durations offered next to the sizes (seconds). */
export const PACK_DURATIONS_SEC = [1800, 3600, 7200, 14400] as const;
/** Duration guess for a track whose length is unknown. */
export const PACK_EST_SECONDS = 4 * 60;

/** A selector value: "100" (Mo) or "dur:3600" (seconds). */
export type PackChoice = { kind: "bytes"; mb: number } | { kind: "seconds"; seconds: number };
export function parsePackChoice(v: unknown): PackChoice | null {
	const s = String(v ?? "").trim();
	const d = s.match(/^dur:(\d+)$/);
	if (d) {
		const n = Number(d[1]);
		return (PACK_DURATIONS_SEC as readonly number[]).includes(n) ? { kind: "seconds", seconds: n } : null;
	}
	if (/^\d+$/.test(s)) {
		const n = Number(s);
		return (PACK_SIZES_MB as readonly number[]).includes(n) ? { kind: "bytes", mb: n } : null;
	}
	return null;
}
/** "30 min" / "1 h" / "2 h" / "4 h". */
export function packDurationLabel(seconds: number): string {
	return formatDuration(seconds);
}

export type PackCandidates = {
	favorites?: ReadonlyArray<any> | null;
	recent?: ReadonlyArray<any> | null;
	mix?: ReadonlyArray<any> | null;
	/** videoIds already in the SW cache (cachedIds store / list-audio): skipped. */
	cached?: Iterable<string> | null;
	/** Known sizes by videoId (list-audio entries, the local list `_bytes`). */
	sizes?: ReadonlyMap<string, number> | null;
};

export type PackItem = {
	item: any;
	videoId: string;
	bytes: number;
	estimated: boolean;
	/** Track length (seconds), PACK_EST_SECONDS when unknown. */
	seconds: number;
	source: "favorites" | "recent" | "mix";
};
export type PackPlan = {
	items: PackItem[];
	/** Planned bytes (known sizes + estimates). */
	bytes: number;
	/** Planned seconds (known durations + estimates). */
	seconds: number;
	count: number;
	/** The budget, in bytes ("bytes" mode) or seconds ("seconds" mode). */
	target: number;
	mode: "bytes" | "seconds";
	/** Candidate tracks (deduped, uncached) that did not fit. */
	left: number;
	/** Uncached candidates seen in total (count + left). */
	candidates: number;
};

export function packSizeOf(item: any, sizes?: ReadonlyMap<string, number> | null): { bytes: number; estimated: boolean } {
	const own = Number(item?._bytes);
	if (Number.isFinite(own) && own > 0) return { bytes: Math.floor(own), estimated: false };
	const known = sizes && item?.videoId ? Number(sizes.get(String(item.videoId))) : NaN;
	if (Number.isFinite(known) && known > 0) return { bytes: Math.floor(known), estimated: false };
	return { bytes: PACK_EST_BYTES, estimated: true };
}

export function packSecondsOf(item: any): number {
	const d = durationOf(item);
	return d && d > 0 ? Math.round(d) : PACK_EST_SECONDS;
}

/**
 * Fill up to `targetBytes` (or, with mode "seconds", up to `target` seconds of
 * listening, each track at its `duration` else PACK_EST_SECONDS): favourites, then recent plays, then mix, in their
 * own order, one entry per videoId, cached ones skipped. A track that does
 * not fit the remaining budget is left out and the next ones are still
 * tried (first fit), so a long favourite never blocks three short ones.
 */
export function planPack(candidates: PackCandidates | null | undefined, targetBytes: number, mode: "bytes" | "seconds" = "bytes"): PackPlan {
	const target = Number.isFinite(targetBytes) && targetBytes > 0 ? Math.floor(targetBytes) : 0;
	const cached = new Set<string>();
	for (const id of candidates?.cached ?? []) if (typeof id === "string" && id) cached.add(id);
	const sizes = candidates?.sizes ?? null;
	const seen = new Set<string>();
	const items: PackItem[] = [];
	let bytes = 0;
	let seconds = 0;
	let left = 0;
	let seenCandidates = 0;
	const sources: Array<[PackItem["source"], ReadonlyArray<any> | null | undefined]> = [
		["favorites", candidates?.favorites],
		["recent", candidates?.recent],
		["mix", candidates?.mix],
	];
	for (const [source, list] of sources) {
		for (const item of keepableTracks(Array.isArray(list) ? (list as any[]) : [])) {
			const id = String(item.videoId);
			if (seen.has(id)) continue;
			seen.add(id);
			if (cached.has(id) || item._cached === true) continue;
			seenCandidates++;
			const s = packSizeOf(item, sizes);
			const sec = packSecondsOf(item);
			const used = mode === "seconds" ? seconds + sec : bytes + s.bytes;
			if (target <= 0 || used > target) {
				left++;
				continue;
			}
			items.push({ item, videoId: id, bytes: s.bytes, estimated: s.estimated, seconds: sec, source });
			bytes += s.bytes;
			seconds += sec;
		}
	}
	return { items, bytes, seconds, count: items.length, target, mode, left, candidates: seenCandidates };
}

/** "12 morceaux · 48 Mo" for a plan, "3/12 · 12 Mo sur 100 Mo" while running. */
export function packLabel(done: number, total: number, doneBytes: number, target: number): string {
	const mb = (n: number) => formatMoFr(Math.max(0, Math.round(n / (1024 * 1024))));
	if (total <= 0) return "Aucun morceau à préparer";
	return `${done}/${total} · ${mb(doneBytes)} sur ${mb(target)}`;
}

/** "12/30 · 48 min sur 1 h" while a duration pack runs. */
export function packDurationText(done: number, total: number, doneSeconds: number, targetSeconds: number): string {
	if (total <= 0) return "Aucun morceau à préparer";
	const d = doneSeconds > 0 ? formatDuration(doneSeconds) : "0 min";
	return `${done}/${total} · ${d} sur ${formatDuration(targetSeconds)}`;
}

// ---- B7-8 (L12-14): space guard for a pack by duration ----
// planPack in "seconds" mode bounds listening time, not bytes: "4 h" can ask
// 240 to 320 Mo (more in high quality) with no look at the quota. Before the
// keep job starts, the card estimates the bytes (known size, else length x
// average bitrate) and compares them to what the pinned total may still grow
// by (quota minus pinned bytes, 10 % headroom), and to the device's free
// storage when the browser tells it. Too big = refused, with the longest
// head of the plan that fits offered instead ("1 h 20 tient").

/** 1 Mo per minute of audio, the default bitrate guess (Opus / AAC streams). */
export const PACK_DEFAULT_BPS = Math.round((1024 * 1024) / 60);
/** Share of the free space the guard leaves untouched (metadata, API cache). */
export const PACK_SPACE_HEADROOM = 0.1;

/**
 * Average bytes per second of listening, from the cached entries whose length
 * is known (`seconds` by videoId: the local list `length` / `duration`), the
 * default when fewer than two entries can be measured.
 */
export function averageBytesPerSecond(
	entries: ReadonlyArray<{ videoId?: string; bytes?: number } | null | undefined> | null | undefined,
	seconds: ReadonlyMap<string, number> | null | undefined,
): number {
	let bytes = 0;
	let secs = 0;
	let n = 0;
	for (const e of entries ?? []) {
		if (!e || !e.videoId) continue;
		const b = Number(e.bytes);
		const s = Number(seconds?.get(e.videoId));
		if (!Number.isFinite(b) || b <= 0 || !Number.isFinite(s) || s <= 0) continue;
		bytes += b;
		secs += s;
		n++;
	}
	if (n < 2 || secs <= 0) return PACK_DEFAULT_BPS;
	const bps = Math.round(bytes / secs);
	return bps > 0 ? bps : PACK_DEFAULT_BPS;
}

/** Bytes a planned item will take: its known size, else its length at `bps`. */
export function packItemEstimate(item: Pick<PackItem, "bytes" | "estimated" | "seconds">, bps: number): number {
	if (!item.estimated && item.bytes > 0) return item.bytes;
	const b = Math.round(Math.max(0, item.seconds) * (bps > 0 ? bps : PACK_DEFAULT_BPS));
	return b > 0 ? b : PACK_EST_BYTES;
}

/** Estimated bytes of a whole plan (see packItemEstimate). */
export function estimatePackBytes(plan: Pick<PackPlan, "items">, bps: number): number {
	return plan.items.reduce((s, i) => s + packItemEstimate(i, bps), 0);
}

export type PackSpace = {
	/** SW audio quota (bytes), <= 0 = unlimited. */
	quota: number;
	/** Bytes already pinned (never evicted, so a pack can only add to them). */
	pinnedBytes: number;
	/** Free bytes on the device (navigator.storage.estimate quota - usage), null when unknown. */
	deviceFree?: number | null;
};

export type PackGuard = {
	/** true: the whole plan fits, start it as is. */
	fits: boolean;
	/** Estimated bytes of the plan. */
	estimated: number;
	/** Bytes the pack may take (Infinity when nothing bounds it). */
	available: number;
	/** What bounds `available`: the quota, the device, or nothing. */
	limit: "none" | "quota" | "device";
	/** The longest head of the plan that fits (the plan itself when it fits). */
	shrunk: PackPlan;
	/** "Pas assez de place : …" when it does not fit, "" otherwise. */
	message: string;
};

/**
 * Compare a plan to the space it may take. Not fitting = the plan is cut
 * (same order, first fit on estimated bytes) and a French message names the
 * demand, what fits and why ("quota 500 Mo, 400 Mo épinglés").
 */
export function guardPackSpace(plan: PackPlan, space: PackSpace, bps = PACK_DEFAULT_BPS): PackGuard {
	const keep = 1 - PACK_SPACE_HEADROOM;
	let available = Infinity;
	let limit: PackGuard["limit"] = "none";
	const quota = Number(space.quota) || 0;
	const pinned = Math.max(0, Number(space.pinnedBytes) || 0);
	if (quota > 0) {
		available = Math.max(0, Math.floor((quota - pinned) * keep));
		limit = "quota";
	}
	// null / undefined = the browser gave no estimate: nothing to bound.
	const free = space.deviceFree == null ? NaN : Number(space.deviceFree);
	if (Number.isFinite(free) && free >= 0) {
		const dev = Math.floor(free * keep);
		if (dev < available) {
			available = dev;
			limit = "device";
		}
	}
	const estimated = estimatePackBytes(plan, bps);
	if (estimated <= available) return { fits: true, estimated, available, limit, shrunk: plan, message: "" };
	const items: PackItem[] = [];
	let bytes = 0;
	let seconds = 0;
	let used = 0;
	for (const i of plan.items) {
		const e = packItemEstimate(i, bps);
		if (used + e > available) continue;
		items.push(i);
		used += e;
		bytes += i.bytes;
		seconds += i.seconds;
	}
	const shrunk: PackPlan = { items, bytes, seconds, count: items.length, target: plan.target, mode: plan.mode, left: plan.left + plan.items.length - items.length, candidates: plan.candidates };
	const asked = plan.mode === "seconds" ? `${formatDuration(plan.target)} demandées` : `${formatBytesFr(plan.target)} demandés`;
	const fitsTxt = items.length ? `${plan.mode === "seconds" ? formatDuration(seconds) : formatBytesFr(used)} ${items.length > 1 ? "tiennent" : "tient"}` : "rien ne tient";
	const why = limit === "device" ? "l'appareil est presque plein" : `quota ${formatBytesFr(quota)}, ${formatBytesFr(pinned)} épinglés`;
	const message = `Pas assez de place : ${asked} (≈ ${formatBytesFr(estimated)}), ${fitsTxt} dans les ${formatBytesFr(available)} libres (${why}).`;
	return { fits: false, estimated, available, limit, shrunk, message };
}

// ---- B7-7 "Rafraîchir mon pack" ----
// The last pack the card prepared is remembered (localStorage LAST_PACK_KEY:
// when it started, its mode / target, its tracks with their length). A
// refresh drops the pack tracks really listened to since the pack began
// (L13-1: a play event dated after `pack.at` with >= 50 % of the track or
// >= 2 min listened, listenLog.ts; never the SW `lastAccess`, which moves
// whenever the SW merely SERVES the audio: startup restore, a 2 s skip, a
// seek) and fills the same listening time with new tracks (planPack by
// seconds, the pack's own tracks excluded). Pinned entries outside the pack
// are never touched: only the dropped pack tracks are uncached, and never
// the track playing / restored.

export const LAST_PACK_KEY = "ytm-offline-pack-last";
export type LastPackItem = { videoId: string; seconds: number; bytes: number };
export type LastPack = { at: number; mode: "bytes" | "seconds"; target: number; items: LastPackItem[] };
type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** The record to remember for a plan that starts now. */
export function lastPackOf(plan: Pick<PackPlan, "items" | "mode" | "target">, at = Date.now()): LastPack {
	return {
		at,
		mode: plan.mode,
		target: plan.target,
		items: plan.items.map((i) => ({ videoId: i.videoId, seconds: i.seconds, bytes: i.bytes })),
	};
}

export function readLastPack(store: KV | null | undefined): LastPack | null {
	try {
		const raw = store?.getItem(LAST_PACK_KEY);
		if (!raw) return null;
		const p = JSON.parse(raw);
		if (!p || typeof p !== "object" || !Array.isArray(p.items)) return null;
		const at = Number(p.at);
		const items: LastPackItem[] = [];
		const seen = new Set<string>();
		for (const i of p.items) {
			const id = typeof i?.videoId === "string" ? i.videoId : "";
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const s = Number(i.seconds);
			const b = Number(i.bytes);
			items.push({ videoId: id, seconds: Number.isFinite(s) && s > 0 ? Math.round(s) : PACK_EST_SECONDS, bytes: Number.isFinite(b) && b > 0 ? Math.floor(b) : PACK_EST_BYTES });
		}
		if (!items.length) return null;
		return { at: Number.isFinite(at) && at > 0 ? at : 0, mode: p.mode === "bytes" ? "bytes" : "seconds", target: Number(p.target) || 0, items };
	} catch {
		return null;
	}
}

export function writeLastPack(store: KV | null | undefined, pack: LastPack | null): void {
	try {
		if (!store) return;
		if (!pack || !pack.items.length) store.removeItem(LAST_PACK_KEY);
		else store.setItem(LAST_PACK_KEY, JSON.stringify(pack));
	} catch {
		/* private mode / full storage: the refresh button is simply absent next time */
	}
}

export type PlayEvent = {
	videoId?: string | null;
	playedAt?: number | null;
	/** Seconds really listened (the device's listen log); absent on a me/stats/recent play. */
	seconds?: number | null;
	/** The track's length (seconds); the pack item's own length when absent. */
	duration?: number | null;
};
export type ListenedSources = {
	/**
	 * SW list-audio entries. L13-1: ignored (kept for callers): `lastAccess`
	 * moves whenever the SW serves the audio, listened or not.
	 */
	entries?: ReadonlyArray<{ videoId?: string; at?: number; lastAccess?: number } | null | undefined> | null;
	/** Play events: the local listen log (`seconds`), me/stats/recent items zipped with `playedAt`. */
	plays?: Iterable<PlayEvent | null | undefined> | null;
};

/**
 * The pack tracks listened to since the pack began (L13-1): a play event
 * dated after `pack.at` whose listened `seconds` reach the listenLog rule
 * (>= 50 % of the track, or >= 2 min). A play without `seconds` (the server
 * history, 30 s rule) and an SW entry served after the pack began are never
 * enough. Tracks outside the pack are never reported.
 */
export function listenedPackIds(pack: Pick<LastPack, "at" | "items">, src: ListenedSources): Set<string> {
	const length = new Map<string, number>();
	for (const i of pack.items) if (!length.has(i.videoId)) length.set(i.videoId, i.seconds);
	const out = new Set<string>();
	const since = Math.max(0, Number(pack.at) || 0);
	for (const p of src.plays ?? []) {
		const id = typeof p?.videoId === "string" ? p.videoId : "";
		if (!id || !length.has(id) || out.has(id)) continue;
		const at = Number(p?.playedAt);
		if (!Number.isFinite(at) || at <= since) continue;
		const own = Number(p?.duration);
		const duration = Number.isFinite(own) && own > 0 ? own : length.get(id) || 0;
		if (isListened(p?.seconds, duration)) out.add(id);
	}
	return out;
}

export type PackRefreshPlan = {
	/** Pack tracks to uncache (listened). */
	drop: LastPackItem[];
	/** Pack tracks that stay. */
	keep: LastPackItem[];
	/** Listening time freed by `drop` (what `add` fills). */
	seconds: number;
	/** New tracks of that duration (planPack by seconds, pack tracks excluded). */
	add: PackPlan;
};

/**
 * The refresh: drop the listened pack tracks, plan as many seconds of new
 * tracks (favourites, recent plays, mix: same order as a pack, cached ones and
 * the pack's own tracks excluded). `protect` (L13-1: the track playing, the
 * restored last track) is never dropped, listened or not. Pure: the card
 * uncaches `drop`, then runs `add` as a pack.
 */
export function planPackRefresh(
	pack: Pick<LastPack, "items">,
	listened: Iterable<string>,
	candidates: PackCandidates | null | undefined,
	protect?: Iterable<string | null | undefined> | null,
): PackRefreshPlan {
	const gone = new Set<string>();
	for (const id of listened) if (typeof id === "string" && id) gone.add(id);
	for (const id of protect ?? []) if (typeof id === "string" && id) gone.delete(id);
	const drop: LastPackItem[] = [];
	const keep: LastPackItem[] = [];
	for (const i of pack.items) (gone.has(i.videoId) ? drop : keep).push(i);
	const seconds = drop.reduce((s, i) => s + i.seconds, 0);
	const cached = new Set<string>();
	for (const id of candidates?.cached ?? []) if (typeof id === "string" && id) cached.add(id);
	for (const i of pack.items) cached.add(i.videoId);
	const add = planPack({ ...(candidates ?? {}), cached }, seconds, "seconds");
	return { drop, keep, seconds, add };
}

/** The pack remembered after a refresh: what stayed plus what was added, dated now. */
export function refreshedLastPack(prev: Pick<LastPack, "mode" | "target">, plan: PackRefreshPlan, at = Date.now()): LastPack {
	return { at, mode: prev.mode, target: prev.target, items: [...plan.keep, ...lastPackOf(plan.add, at).items] };
}

/** "3 titres écoutés remplacés par 4 nouveaux (42 min)" / "Rien à rafraîchir : …". */
export function packRefreshSummary(plan: Pick<PackRefreshPlan, "drop" | "seconds" | "add">): string {
	if (!plan.drop.length) return "Rien à rafraîchir : aucun titre du pack n'a encore été écouté.";
	const dropped = `${plan.drop.length} titre${plan.drop.length > 1 ? "s" : ""} écouté${plan.drop.length > 1 ? "s" : ""}`;
	if (!plan.add.count) return `Rien à rafraîchir : pas de nouveau titre pour remplacer ${dropped} (${formatDuration(plan.seconds)}).`;
	return `${dropped} remplacé${plan.drop.length > 1 ? "s" : ""} par ${plan.add.count} nouveau${plan.add.count > 1 ? "x" : ""} (${formatDuration(plan.add.seconds)})`;
}
