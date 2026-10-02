// O8 "Garder hors-ligne" depuis la source: download the tracks of an album /
// playlist / favourites that are not cached yet (2 at a time), then pin every
// one of them so the SW never evicts it. Same rules as the downloads-offline
// page's downloadThenPin + pin() batch (H5): the quota is checked BEFORE each
// download (pinned bytes + estimated size) and the batch stops downloading as
// soon as the quota refuses, so nothing gets evicted for a pin that would be
// refused anyway. Pure core (`keepOffline` with injectable deps) + the toast
// text (`keepSummary`), both covered by offlineBatch.test.ts.
import {
	abortCacheAudio,
	cacheTrackOffline,
	deviceOffline,
	downloadForOffline,
	isStableAudioUrl,
	listCachedAudio,
	pinOffline,
	requestPersistentStorage,
	type OfflineResult,
	type PinResult,
} from "$lib/offline";
import { get, writable, type Readable } from "svelte/store";
import { clearFailed, recordFailed } from "$lib/offlineFailed";

/** Toast shown when the SW refuses a pin because pinned bytes would exceed the quota (G7). */
export const QUOTA_MSG = "Quota atteint, augmente-le dans Réglages";
/** Default size guess for a track not downloaded yet (no `_bytes`, empty cache). */
export const EST_TRACK_BYTES = 8 * 1024 * 1024;
export const KEEP_CONCURRENCY = 2;

export type KeepProgress = { ready: number; failed: number; refused: number; total: number };
export type KeepResult = KeepProgress & { cancelled: boolean };
export type KeepOptions = {
	onProgress?: (p: KeepProgress) => void;
	signal?: AbortSignal;
	/** UX9: one track counted in `failed` (download / pin impossible). */
	onFailed?: (t: any) => void;
	/** UX9: one track counted in `ready` (pinned offline). */
	onReady?: (t: any) => void;
};
export type KeepDeps = {
	pin: (t: any) => Promise<PinResult>;
	/** I15: `pinned: true` asks the SW to write the entry pinned (atomic pin). */
	download: (t: any, opts?: { pinned?: boolean }) => Promise<OfflineResult>;
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
	// U14-2: a keep is explicit: never deferred to a listen (cacheTrackOffline).
	download: (t, opts) => (isStableAudioUrl(t?._offlineUrl) ? cacheTrackOffline(t, t._offlineUrl, { ...opts, explicit: true }) : downloadForOffline(t, opts)),
	cacheInfo: async () => {
		const l = await listCachedAudio().catch(() => null);
		if (!l || !Array.isArray(l.entries)) return null;
		const entries = l.entries;
		const avgBytes = entries.length ? Math.round(entries.reduce((s, e) => s + (Number(e?.bytes) || 0), 0) / entries.length) : 0;
		return { quota: Number(l.quota) || 0, pinnedBytes: Number(l.pinnedBytes) || 0, avgBytes };
	},
};
/** The real deps (SW helpers of $lib/offline), for callers that wrap them. */
export const defaultKeepDeps: KeepDeps = defaultDeps;

/** `reason` of a download stopped by an abort (HL3 pack "Annuler"). */
export const CANCELLED_REASON = "cancelled";

/**
 * HL3: deps whose downloads stop on `signal` abort: the SW is told to abort
 * its fetch (abort-audio) and the download resolves at once with reason
 * "cancelled", so a batch cut by "Annuler" ends within the second whatever
 * the SW does. What landed before the abort stays cached and pinned.
 */
export function keepDepsWithAbort(signal: AbortSignal, base: KeepDeps = defaultDeps, abort: (t: any) => void = (t) => abortCacheAudio(t?.videoId, t?._offlineUrl)): KeepDeps {
	const cancelled = (): OfflineResult => ({ ok: false, reason: CANCELLED_REASON });
	return {
		...base,
		download: (t, opts) => {
			if (signal.aborted) return Promise.resolve(cancelled());
			return new Promise<OfflineResult>((resolve) => {
				let settled = false;
				const finish = (r: OfflineResult) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve(r);
				};
				const onAbort = () => {
					try {
						abort(t);
					} catch {
						/* best effort */
					}
					finish(cancelled());
				};
				signal.addEventListener("abort", onAbort, { once: true });
				base.download(t, opts).then(finish, () => finish({ ok: false, reason: "error" }));
			});
		},
	};
}

/**
 * Keep `tracks` offline: pin the cached ones, download the others
 * (KEEP_CONCURRENCY in parallel), each pinned right after its own download
 * (I15; one re-download when the SW evicted it before the pin). Never throws.
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
	const hook = (fn: ((t: any) => void) | undefined, t: any) => {
		try {
			fn?.(t);
		} catch {
			/* a UI callback must not break the batch */
		}
	};
	const ready = (t: any) => {
		p.ready++;
		hook(opts.onReady, t);
	};
	const failed = (t: any) => {
		p.failed++;
		hook(opts.onFailed, t);
	};
	if (!list.length) return { ...p, cancelled: false };
	// O10: the first "Garder hors-ligne" asks for persistent storage.
	if (deps === defaultDeps) void requestPersistentStorage();
	emit();

	// 1. Cached tracks: pin right away; "not_cached" ones are downloaded below.
	const toDownload: any[] = [];
	for (const t of list) {
		if (aborted()) return { ...p, cancelled: true };
		const r = await deps.pin(t).catch(() => ({ ok: false, reason: "error" }) as PinResult);
		if (r.ok) ready(t);
		else if (r.reason === "not_cached") toDownload.push(t);
		else if (r.reason === "quota") p.refused++;
		else failed(t);
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
	let cancelledInFlight = 0;
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
			// I15: the download is written pinned by the SW (no eviction window
			// before the pin below, which then only confirms the flag).
			const dl = () => deps.download(t, { pinned: true }).catch(() => ({ ok: false, reason: "error" }) as OfflineResult);
			const pinIt = () => deps.pin(t).catch(() => ({ ok: false, reason: "error" }) as PinResult);
			let r = await dl();
			// I15: each track is pinned as soon as ITS download lands (never
			// after the batch), so a batch cut midway keeps what it finished.
			let pr: PinResult | null = r.ok ? await pinIt() : null;
			let retried = false;
			if (pr && !pr.ok && pr.reason === "not_cached" && !aborted()) {
				retried = true;
				// Evicted between its write and its pin (the other worker's
				// write ran the SW LRU): download it again once, pin at once.
				r = await dl();
				pr = r.ok ? await pinIt() : null;
			}
			if (!r.ok) {
				pinnedBytes -= est;
				if (/quota/.test(r.reason || "")) {
					quotaStop = true;
					p.refused++;
				} else if (r.reason === CANCELLED_REASON && aborted()) {
					// HL3: stopped by "Annuler" (keepDepsWithAbort): neither failed
					// nor refused, the batch reports cancelled below.
					cancelledInFlight++;
				} else failed(t);
				emit();
				continue;
			}
			if (!pr) continue;
			if (pr.ok) {
				ready(t);
				pinnedBytes += (Number(r.bytes) || est) - est;
			} else {
				pinnedBytes -= est;
				// Still evicted after a second download: the cache cannot hold it.
				if (pr.reason === "quota" || (retried && pr.reason === "not_cached")) {
					quotaStop = true;
					p.refused++;
				} else failed(t);
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
	return { ...p, cancelled: aborted() && (next < toDownload.length || cancelledInFlight > 0) };
}

/** Button label for a running / finished batch: "9/14 prêts", "Prêt hors-ligne". */
export function keepLabel(p: KeepProgress | null, running: boolean): string {
	if (!p || !p.total) return "Garder hors-ligne";
	if (!running && p.ready === p.total) return "Prêt hors-ligne";
	if (running) return `${p.ready}/${p.total} prêts`;
	return "Garder hors-ligne";
}

/**
 * c43d: whether a finished batch leaves its source "Prêt hors-ligne": every one
 * of its tracks is ready, nothing was cancelled, and it covered the `expected`
 * tracks of the button's source. KeepOfflineButton used to read that state
 * ONCE from the localStorage list when the job ended; another tab (a running
 * pack, its reconcile after a cancel) rewrites that list concurrently and can
 * drop the flags, so a complete batch showed "Garder hors-ligne" under its
 * success toast. The batch result decides first, the list is the fallback.
 */
export function keepDoneReady(r: KeepResult | null | undefined, expected: number): boolean {
	if (!r || r.cancelled || !r.total || !(expected > 0)) return false;
	return r.ready === r.total && r.total === expected;
}

/**
 * L13-16: the track count the idle button compares the last batch with. A
 * source whose tracks are at hand (n > 0) counts them. A lazily loaded source
 * (n === 0: a mix card, an album queue resolved by `load`) used to take the
 * batch's own total, so keepDoneReady(done, done.total) was a tautology: a
 * complete batch of a queue SHORTER than the source (loader cap, a truncated
 * queue) said "Prêt hors-ligne" for the whole source. `expected` (the
 * source's own count: an album's trackCount, a card's size) now bounds it,
 * and the batch total is the fallback only when the source has no count.
 */
export function keepIdleTotal(n: number, expected: number | null | undefined, done: KeepResult | null | undefined): number {
	if (n > 0) return n;
	if (typeof expected === "number" && Number.isFinite(expected) && expected > 0) return Math.floor(expected);
	return done && !done.cancelled ? done.total : 0;
}

/**
 * L10-13: accessible name of the compact (icon-only) keep button: its state
 * AND the card it belongs to ("Garder hors-ligne : Années 1990", "Prêt
 * hors-ligne : Rock", "9/14 prêts : Daft Punk"); 20 identical names on
 * /library/mixes otherwise.
 */
export function compactKeepAriaLabel(label: string, cardTitle?: string | null): string {
	const t = typeof cardTitle === "string" ? cardTitle.trim() : "";
	return t ? `${label} : ${t}` : label;
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

/** I13: toast for a menu "Garder hors-ligne" while the device is offline. */
export const KEEP_OFFLINE_MSG = "Indisponible hors connexion";
/** I13: toast when the same album / playlist / track is already being kept. */
export const KEEP_RUNNING_MSG = "Garder hors-ligne : déjà en cours";

/** I13: ids naming a menu item's source (album browseId, playlistId, videoId). */
export function keepAliases(item: any): string[] {
	if (!item || typeof item !== "object") return [];
	// A track row is its own source (its endpoint may name its album).
	const out = isCollectionItem(item) ? [item?.endpoint?.browseId, item?.browseId, item?.playlistId] : [item?.videoId];
	return out.filter((x, i, a): x is string => typeof x === "string" && x.length > 0 && a.indexOf(x) === i);
}

/** I13: job key of a menu "Garder hors-ligne" (one per source). */
export function keepMenuKey(item: any): string {
	return "keep:" + (keepAliases(item)[0] ?? "");
}

/** I13: whether `key` (a page URL or a menu key) names the source id `a`. */
function keyNames(key: string, a: string): boolean {
	if (!key || !a) return false;
	if (key === "keep:" + a) return true;
	for (const sep of ["=", "/"]) {
		let i = key.indexOf(sep + a);
		while (i !== -1) {
			const end = key.charAt(i + 1 + a.length);
			if (end === "" || end === "&" || end === "/" || end === "#") return true;
			i = key.indexOf(sep + a, i + 1);
		}
	}
	return false;
}

/**
 * I13: whether job `j` keeps the same source as `key` / `aliases`: same key,
 * the key names one of the job's aliases, or the job key (a page URL such as
 * /release?id=MPREb…) names one of `aliases`.
 */
export function jobMatchesKey(j: Pick<KeepJob, "key" | "aliases">, key: string, aliases: string[] = []): boolean {
	if (key && j.key === key) return true;
	if ((j.aliases ?? []).some((a) => keyNames(key, a))) return true;
	return aliases.some((a) => keyNames(j.key, a));
}

/** I13: the running job for `key` (exact, else by alias), if any. */
export function findKeepJob(jobs: Map<string, KeepJob>, key: string, aliases: string[] = []): KeepJob | undefined {
	const exact = key ? jobs.get(key) : undefined;
	if (exact) return exact;
	for (const j of jobs.values()) if (jobMatchesKey(j, key, aliases)) return j;
	return undefined;
}

export type KeepMenuDeps = {
	offline: () => boolean;
	notify: (msg: string, type: "success" | "error", action?: { label: string; run: () => void }) => void;
	/** Tracks of an album / playlist card (get_queue.json). */
	fetchQueue: (playlistId: string) => Promise<any[]>;
	keep?: KeepDeps;
};

/**
 * Menu ⋮ "Garder hors-ligne" core (I13): offline → "Indisponible hors
 * connexion", nothing starts; the same source already running → "déjà en
 * cours" (+ Annuler) and the running batch is joined; otherwise a keep job
 * (I12 store, so the page button and the toast can cancel it) whose toasts
 * carry an "Annuler" action. Ends with the batch toast.
 */
export async function keepItemOfflineWith(item: any, deps: KeepMenuDeps): Promise<KeepResult | null> {
	const cancelAction = (key: string) => ({ label: "Annuler", run: () => cancelKeepJob(key) });
	if (deps.offline()) {
		deps.notify(KEEP_OFFLINE_MSG, "error");
		return null;
	}
	const key = keepMenuKey(item);
	const running = findKeepJob(get(_keepJobs), key, keepAliases(item));
	if (running) {
		deps.notify(KEEP_RUNNING_MSG, "success", cancelAction(running.key));
		return running.done;
	}
	return startKeepJob(
		key,
		async () => {
			let tracks: any[] = [item];
			if (isCollectionItem(item)) tracks = await deps.fetchQueue(item.playlistId).catch(() => []);
			const n = keepableTracks(tracks).length;
			if (n > 1) deps.notify(`${n} morceaux : téléchargement hors-ligne en cours…`, "success", cancelAction(key));
			return tracks;
		},
		{
			aliases: keepAliases(item),
			deps: deps.keep,
			onDone: (r) => {
				const s = keepSummary(r);
				deps.notify(s.text, s.type);
			},
		},
	);
}

/**
 * Menu ⋮ "Garder hors-ligne" (dropdowns.config "Download offline"): one track,
 * or every track of an album / playlist card. Ends with the batch toast.
 */
export async function keepItemOffline(item: any): Promise<KeepResult | null> {
	const { notify } = await import("$lib/utils");
	return keepItemOfflineWith(item, {
		offline: deviceOffline,
		notify: (msg, type, action) => notify(msg, type, action),
		fetchQueue: async (playlistId) => {
			const { APIClient } = await import("$lib/api");
			const res = await APIClient.fetch(`/api/v1/get_queue.json?playlistId=` + encodeURIComponent(playlistId));
			const data = await res.json();
			return Array.isArray(data) ? data : [];
		},
	});
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

export type KeepJob = {
	key: string;
	progress: KeepProgress | null;
	ctrl: AbortController;
	done: Promise<KeepResult | null>;
	/** I13: source ids (album / playlist / track) so another entry point finds this job. */
	aliases?: string[];
};
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
	opts: {
		onDone?: (r: KeepResult) => void;
		/** HL3: a factory gets the job's abort signal (keepDepsWithAbort). */
		deps?: KeepDeps | ((signal: AbortSignal) => KeepDeps);
		aliases?: string[];
	} = {},
): Promise<KeepResult | null> {
	const running = get(_keepJobs).get(key);
	if (running) return running.done;
	const ctrl = new AbortController();
	const deps: KeepDeps = typeof opts.deps === "function" ? opts.deps(ctrl.signal) : (opts.deps ?? defaultDeps);
	let resolveDone: (r: KeepResult | null) => void = () => {};
	const done = new Promise<KeepResult | null>((r) => (resolveDone = r));
	_keepJobs.update((m) => new Map(m).set(key, { key, progress: null, ctrl, done, aliases: opts.aliases ?? [] }));
	void (async () => {
		let result: KeepResult | null = null;
		try {
			const list = keepableTracks(await Promise.resolve(getTracks()).catch(() => []));
			patchJob(key, (j) => ({ ...j, progress: { ready: 0, failed: 0, refused: 0, total: list.length } }));
			result = await keepOffline(
				list,
				{
					signal: ctrl.signal,
					onProgress: (p) => patchJob(key, (j) => ({ ...j, progress: p })),
					// UX9: every keep / pack job feeds the failed-downloads store.
					onFailed: recordFailed,
					onReady: (t) => clearFailed(t?.videoId),
				},
				deps,
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

