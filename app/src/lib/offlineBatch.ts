// O8 "Garder hors-ligne" depuis la source: download the tracks of an album /
// playlist / favourites that are not cached yet (2 at a time), then pin every
// one of them so the SW never evicts it. Same rules as the downloads-offline
// page's downloadThenPin + pin() batch (H5): the quota is checked BEFORE each
// download (pinned bytes + estimated size) and the batch stops downloading as
// soon as the quota refuses, so nothing gets evicted for a pin that would be
// refused anyway. Pure core (`keepOffline` with injectable deps) + the toast
// text (`keepSummary`), both covered by offlineBatch.test.ts.
import {
	cacheTrackOffline,
	downloadForOffline,
	isStableAudioUrl,
	listCachedAudio,
	pinOffline,
	requestPersistentStorage,
	type OfflineResult,
	type PinResult,
} from "$lib/offline";
import { get, writable, type Readable } from "svelte/store";

/** Toast shown when the SW refuses a pin because pinned bytes would exceed the quota (G7). */
export const QUOTA_MSG = "Quota atteint, augmente-le dans Réglages";
/** Default size guess for a track not downloaded yet (no `_bytes`, empty cache). */
export const EST_TRACK_BYTES = 8 * 1024 * 1024;
export const KEEP_CONCURRENCY = 2;

export type KeepProgress = { ready: number; failed: number; refused: number; total: number };
export type KeepResult = KeepProgress & { cancelled: boolean };
export type KeepOptions = { onProgress?: (p: KeepProgress) => void; signal?: AbortSignal };
export type KeepDeps = {
	pin: (t: any) => Promise<PinResult>;
	download: (t: any) => Promise<OfflineResult>;
	/** SW cache summary for the quota estimate; null = unknown (no SW answer). */
	cacheInfo: () => Promise<{ quota: number; pinnedBytes: number; avgBytes: number } | null>;
};

const NON_TRACK = /ARTIST|ALBUM|PLAYLIST|USER_CHANNEL|SINGLE|EP/;

/** The playable tracks of a list (favourites mix albums / artists): one per videoId. */
export function keepableTracks(items: any[] | null | undefined): any[] {
	const seen = new Set<string>();
	const out: any[] = [];
	for (const it of Array.isArray(items) ? items : []) {
		const id = it && typeof it.videoId === "string" ? it.videoId : "";
		if (!id || seen.has(id)) continue;
		const pt = String(it?.endpoint?.pageType ?? "");
		if (pt && NON_TRACK.test(pt)) continue;
		if (it.type === "artist" || it.type === "artists" || it.type === "playlist") continue;
		seen.add(id);
		out.push(it);
	}
	return out;
}

const defaultDeps: KeepDeps = {
	pin: (t) => pinOffline(t, true),
	// A stable /localf or /aud URL goes straight to the SW, otherwise through
	// the API URL resolution (downloadForOffline).
	download: (t) => (isStableAudioUrl(t?._offlineUrl) ? cacheTrackOffline(t, t._offlineUrl) : downloadForOffline(t)),
	cacheInfo: async () => {
		const l = await listCachedAudio().catch(() => null);
		if (!l || !Array.isArray(l.entries)) return null;
		const entries = l.entries;
		const avgBytes = entries.length ? Math.round(entries.reduce((s, e) => s + (Number(e?.bytes) || 0), 0) / entries.length) : 0;
		return { quota: Number(l.quota) || 0, pinnedBytes: Number(l.pinnedBytes) || 0, avgBytes };
	},
};

/**
 * Keep `tracks` offline: pin the cached ones, download the others
 * (KEEP_CONCURRENCY in parallel) then pin them. Never throws.
 * `ready` = pinned, `refused` = refused by the quota (or not attempted once
 * the quota refused), `failed` = download / pin impossible. Abort via
 * `signal`: running downloads finish, nothing new starts, `cancelled: true`.
 */
export async function keepOffline(tracks: any[], opts: KeepOptions = {}, deps: KeepDeps = defaultDeps): Promise<KeepResult> {
	const list = keepableTracks(tracks);
	const p: KeepProgress = { ready: 0, failed: 0, refused: 0, total: list.length };
	const emit = () => {
		try {
			opts.onProgress?.({ ...p });
		} catch {
			/* a UI callback must not break the batch */
		}
	};
	const aborted = () => !!opts.signal?.aborted;
	if (!list.length) return { ...p, cancelled: false };
	// O10: the first "Garder hors-ligne" asks for persistent storage.
	if (deps === defaultDeps) void requestPersistentStorage();
	emit();

	// 1. Cached tracks: pin right away; "not_cached" ones are downloaded below.
	const toDownload: any[] = [];
	for (const t of list) {
		if (aborted()) return { ...p, cancelled: true };
		const r = await deps.pin(t).catch(() => ({ ok: false, reason: "error" }) as PinResult);
		if (r.ok) p.ready++;
		else if (r.reason === "not_cached") toDownload.push(t);
		else if (r.reason === "quota") p.refused++;
		else p.failed++;
		emit();
	}
	if (!toDownload.length) return { ...p, cancelled: false };
	// The quota already refused a cached track: every download would be refused too.
	if (p.refused) {
		p.refused += toDownload.length;
		emit();
		return { ...p, cancelled: false };
	}

	// 2. Downloads, quota checked before each one.
	const info = await deps.cacheInfo().catch(() => null);
	const quota = info ? info.quota : 0;
	let pinnedBytes = info ? info.pinnedBytes : 0;
	const estimate = (t: any) => Number(t?._bytes) || (info && info.avgBytes) || EST_TRACK_BYTES;
	let next = 0;
	let quotaStop = false;
	const worker = async () => {
		while (!quotaStop && !aborted() && next < toDownload.length) {
			const t = toDownload[next++];
			const est = estimate(t);
			if (quota > 0 && pinnedBytes + est > quota) {
				quotaStop = true;
				p.refused++;
				break;
			}
			pinnedBytes += est; // reserve while the download runs
			const r = await deps.download(t).catch(() => ({ ok: false, reason: "error" }) as OfflineResult);
			if (!r.ok) {
				pinnedBytes -= est;
				if (/quota/.test(r.reason || "")) {
					quotaStop = true;
					p.refused++;
				} else p.failed++;
				emit();
				continue;
			}
			const pr = await deps.pin(t).catch(() => ({ ok: false, reason: "error" }) as PinResult);
			if (pr.ok) {
				p.ready++;
				pinnedBytes += (Number(r.bytes) || est) - est;
			} else {
				pinnedBytes -= est;
				if (pr.reason === "quota") {
					quotaStop = true;
					p.refused++;
				} else p.failed++;
			}
			emit();
		}
	};
	await Promise.all(Array.from({ length: Math.min(KEEP_CONCURRENCY, toDownload.length) }, worker));
	if (quotaStop && next < toDownload.length) {
		// Never started: refused by the quota as well.
		p.refused += toDownload.length - next;
		next = toDownload.length;
		emit();
	}
	return { ...p, cancelled: aborted() && next < toDownload.length };
}

/** Button label for a running / finished batch: "9/14 prêts", "Prêt hors-ligne". */
export function keepLabel(p: KeepProgress | null, running: boolean): string {
	if (!p || !p.total) return "Garder hors-ligne";
	if (!running && p.ready === p.total) return "Prêt hors-ligne";
	if (running) return `${p.ready}/${p.total} prêts`;
	return "Garder hors-ligne";
}

/** One toast for a finished batch: "N prêts hors-ligne · K refusés : quota … · F impossibles". */
export function keepSummary(r: KeepResult): { text: string; type: "success" | "error" } {
	if (!r.total) return { text: "Aucun morceau à garder hors-ligne", type: "error" };
	if (r.cancelled) return { text: `Annulé : ${r.ready} sur ${r.total} prêts hors-ligne`, type: "success" };
	if (r.ready === r.total) {
		return { text: r.total > 1 ? `${r.total} morceaux prêts hors-ligne` : "Prêt hors-ligne", type: "success" };
	}
	if (r.total === 1) {
		if (r.refused) return { text: QUOTA_MSG, type: "error" };
		return { text: "Impossible de garder ce morceau hors-ligne pour l'instant", type: "error" };
	}
	const parts = [`${r.ready} ${r.ready > 1 ? "prêts" : "prêt"} sur ${r.total}`];
	if (r.refused) parts.push(`${r.refused} ${r.refused > 1 ? "refusés" : "refusé"} : ${QUOTA_MSG.charAt(0).toLowerCase()}${QUOTA_MSG.slice(1)}`);
	if (r.failed) parts.push(`${r.failed} ${r.failed > 1 ? "impossibles" : "impossible"} à télécharger`);
	return { text: parts.join(" · "), type: "error" };
}

/** Album / playlist entries whose tracks come from get_queue.json (menu ⋮ on a card). */
export function isCollectionItem(item: any): boolean {
	return !!item && !!item.playlistId && /ALBUM|PLAYLIST|SINGLE/.test(String(item?.endpoint?.pageType ?? ""));
}

/**
 * Menu ⋮ "Garder hors-ligne" (dropdowns.config "Download offline"): one track,
 * or every track of an album / playlist card. Ends with the batch toast.
 */
export async function keepItemOffline(item: any): Promise<KeepResult | null> {
	const { notify } = await import("$lib/utils");
	let tracks: any[] = [item];
	if (isCollectionItem(item)) {
		try {
			const { APIClient } = await import("$lib/api");
			const res = await APIClient.fetch(`/api/v1/get_queue.json?playlistId=` + encodeURIComponent(item.playlistId));
			const data = await res.json();
			tracks = Array.isArray(data) ? data : [];
		} catch {
			tracks = [];
		}
	}
	if (!keepableTracks(tracks).length) {
		notify("Aucun morceau à garder hors-ligne", "error");
		return null;
	}
	const n = keepableTracks(tracks).length;
	if (n > 1) notify(`${n} morceaux : téléchargement hors-ligne en cours…`, "success");
	const r = await keepOffline(tracks);
	const s = keepSummary(r);
	notify(s.text, s.type);
	return r;
}

/**
 * V1 row state: "ready" when the track is cached (badge), "unavailable" when
 * the device is offline and the track is not cached (muted, click = toast),
 * "" otherwise (not a track, or online and not cached).
 */
export function rowOfflineState(videoId: string | null | undefined, cached: Set<string> | null | undefined, offline: boolean): "ready" | "unavailable" | "" {
	if (!videoId) return "";
	if (cached && cached.has(videoId)) return "ready";
	return offline ? "unavailable" : "";
}

/* ------------------------------------------------------------------------ */
/* I12: running batches live in a module store keyed by source, so leaving  */
/* the page no longer cancels them; only "Annuler" (cancelKeepJob) does.    */
/* A reopened page finds its job and shows its progress.                    */
/* ------------------------------------------------------------------------ */

export type KeepJob = { key: string; progress: KeepProgress | null; ctrl: AbortController; done: Promise<KeepResult | null> };
const _keepJobs = writable<Map<string, KeepJob>>(new Map());
export const keepJobs: Readable<Map<string, KeepJob>> = { subscribe: _keepJobs.subscribe };

function patchJob(key: string, fn: (j: KeepJob) => KeepJob | null): void {
	_keepJobs.update((m) => {
		const cur = m.get(key);
		if (!cur) return m;
		const next = new Map(m);
		const j = fn(cur);
		if (j) next.set(key, j);
		else next.delete(key);
		return next;
	});
}

/**
 * Start (or join) the batch of `key`: `getTracks` resolves the source's
 * tracks (lazy album queues), `onDone` gets the result (toast) even when the
 * page that started it is gone. A second start while running returns the
 * running job's promise.
 */
export function startKeepJob(
	key: string,
	getTracks: () => Promise<any[]> | any[],
	opts: { onDone?: (r: KeepResult) => void; deps?: KeepDeps } = {},
): Promise<KeepResult | null> {
	const running = get(_keepJobs).get(key);
	if (running) return running.done;
	const ctrl = new AbortController();
	let resolveDone: (r: KeepResult | null) => void = () => {};
	const done = new Promise<KeepResult | null>((r) => (resolveDone = r));
	_keepJobs.update((m) => new Map(m).set(key, { key, progress: null, ctrl, done }));
	void (async () => {
		let result: KeepResult | null = null;
		try {
			const list = keepableTracks(await Promise.resolve(getTracks()).catch(() => []));
			patchJob(key, (j) => ({ ...j, progress: { ready: 0, failed: 0, refused: 0, total: list.length } }));
			result = await keepOffline(
				list,
				{ signal: ctrl.signal, onProgress: (p) => patchJob(key, (j) => ({ ...j, progress: p })) },
				opts.deps ?? defaultDeps,
			);
			try {
				opts.onDone?.(result);
			} catch {
				/* a UI callback must not break the store */
			}
		} catch {
			result = null;
		} finally {
			patchJob(key, () => null);
			resolveDone(result);
		}
	})();
	return done;
}

/** "Annuler": abort the batch of `key` (the downloads in flight finish). */
export function cancelKeepJob(key: string): void {
	get(_keepJobs).get(key)?.ctrl.abort();
}

