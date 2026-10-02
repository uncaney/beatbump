<script lang="ts">
	// F7 + F15: "Espace" card of the Hors-ligne page. The two offline ACTIONS
	// that used to sit in Settings > Offline (HL2 "Libérer de l'espace", HL3
	// "Préparer un pack") live here, behind ONE size selector shared by both:
	// "Libérer 250 Mo" removes the least recently played tracks up to that size
	// (pinned never touched), "Préparer un pack" downloads + pins favourites /
	// recent plays / mix up to the same size. Settings keeps the switches, the
	// quota and the persistent-storage state only.
	//
	// Harness contract (harness-offline free_up_and_pack): data-testids
	// free-up, free-up-plan, free-up-confirm, free-up-cancel, free-up-result,
	// pack-size, pack-start, pack-progress, pack-cancel and the globals
	// window.__ytmFreeUpPlan / window.__ytmPackPlan are unchanged.
	//
	// UX8 (cycle 35): the card folds to one summary line behind
	// [data-testid=space-toggle] so "Tout lire" stays above the fold.
	// U12-9 (cycle 37): FOLDED by default (no stored preference); the user's
	// choice is remembered both ways (localStorage SPACE_OPEN_KEY "1" / "0"),
	// and a running pack opens it so its progress and "Annuler" stay in view.
	// Harness free_up_and_pack expands it through space-toggle first.
	//
	// B6-16 (cycle 40, pack trajet): pack-size also offers durations
	// (value "dur:1800" … "dur:14400"); sizes keep their values ("100" …).
	// A duration fills the pack by track length (planPack mode "seconds") and
	// "Libérer" is disabled then (it frees by size only). `?pack=dur:7200` (the
	// home weekend card) preselects the choice and unfolds the card.
	//
	// B7-8 (cycle 44, L12-14): a pack by duration is measured before it starts
	// (guardPackSpace: known sizes else length x average bitrate of the cache,
	// against quota - pinned bytes and, L13-4, the storage the browser grants
	// this origin: estimate quota - usage + unpinned audio). Too big =
	// packState "too-big" ([data-testid=pack-progress][data-state=too-big],
	// "Pas assez de place : …") with the head that fits offered behind
	// [data-testid=pack-shrink]; nothing is downloaded until the user says so.
	//
	// B7-7 (cycle 44, "Rafraîchir mon pack"): the last pack is remembered
	// (localStorage LAST_PACK_KEY); [data-testid=pack-refresh] replaces its
	// tracks already listened to (a play since the pack began, or the SW
	// lastAccess moved) by new ones of the same listening time, run as a pack
	// (same job key, same "Annuler"). Pinned entries outside the pack are never
	// touched. window.__ytmPackRefresh carries the outcome for the harness.
	// B8-11 (cycle 47): the refresh is previewed first ([pack-refresh-preview]
	// lists the tracks that would go, [pack-refresh-confirm] runs it).
	//
	// B7-12: `?pack=1` (manifest shortcut "Pack trajet") unfolds the card and
	// focuses the size / duration selector.
	import { createEventDispatcher, onMount, tick } from "svelte";
	import { get } from "svelte/store";
	import { goto } from "$app/navigation";
	import {
		applySwEviction,
		cachedIds,
		getOfflineTracks,
		listCachedAudio,
		requestPersistentStorage,
		scheduleSwAudioRefresh,
		storageStatus,
		swRequest,
		type AudioListEntry,
	} from "$lib/offline";
	import { freeUpSummary, planFreeUp, type FreeUpPlan } from "$lib/offlineFreeUp";
	import {
		PACK_DURATIONS_SEC,
		PACK_SIZES_MB,
		averageBytesPerSecond,
		estimatePackBytes,
		guardPackSpace,
		lastPackOf,
		listenedPackIds,
		originRoom,
		packDoneOf,
		packDurationLabel,
		packDurationText,
		packLabel,
		packRefreshPreviewTitle,
		packRefreshRows,
		packRefreshSummary,
		packSecondsOf,
		packSizeOf,
		parsePackChoice,
		planPack,
		planPackRefresh,
		readLastPack,
		refreshedLastPack,
		writeLastPack,
		type LastPack,
		type PackGuard,
		type PackPlan,
		type PackRefreshPlan,
		type PackRefreshRow,
	} from "$lib/offlinePack";
	import { durationOf } from "$lib/offlineQueue";
	import { fmtBytesFr, spaceButtonLabels, spaceStatusLine } from "$lib/offlineSpace";
	import { cancelKeepJob, defaultKeepDeps, keepDepsWithAbort, keepJobs, keepSummary, startKeepJob, type KeepProgress, type KeepResult } from "$lib/offlineBatch";
	import { getFavorites, getMix, getRecent } from "$lib/me";
	import { readLastTrack } from "$lib/homeRows";
	import { readListenLog } from "$lib/listenLog";
	import { notify } from "$lib/utils";
	import { formatMoFr } from "$lib/utils/formatFr";
	import { currentTrack } from "$lib/stores/list";

	const MB = 1024 * 1024;
	/** U12-9: "1" = the user opened the card, "0" = folded; nothing = folded. */
	const SPACE_OPEN_KEY = "ytm-offline-space-open";
	const SW_UNAVAILABLE = "Cache hors-ligne indisponible : le service worker n'a pas répondu (première visite, fenêtre privée ou rechargement nécessaire).";
	const dispatch = createEventDispatcher<{ changed: void }>();

	let loading = true;
	let error = "";
	let busy: "" | "freeup" = "";
	let entries: AudioListEntry[] = [];
	let total = 0;
	let pinnedBytes = 0;
	let quota = 0;
	/** The selector value: a size in Mo ("100") or a duration ("dur:3600"). */
	let choice = "100";
	$: parsedChoice = parsePackChoice(choice) ?? { kind: "bytes" as const, mb: 100 };
	/** The one size (Mo) both actions use (100 while a duration is chosen). */
	$: sizeMb = parsedChoice.kind === "bytes" ? parsedChoice.mb : 100;
	$: durationSec = parsedChoice.kind === "seconds" ? parsedChoice.seconds : 0;

	/** U12-9: card folded to its summary line (default) or unfolded. */
	let open = false;
	function toggleOpen() {
		open = !open;
		try {
			localStorage.setItem(SPACE_OPEN_KEY, open ? "1" : "0");
		} catch {
			/* private mode: the choice lasts for this visit only */
		}
	}

	$: cachedTracks = entries.length;
	$: labels = durationSec ? { freeUp: spaceButtonLabels(sizeMb).freeUp, pack: `Préparer un pack de ${packDurationLabel(durationSec)}` } : spaceButtonLabels(sizeMb);
	$: status = spaceStatusLine({ total, quota, pinnedBytes, loading, unknown: !!error && !entries.length });

	async function refresh() {
		loading = true;
		error = "";
		try {
			const r = await listCachedAudio();
			if (!r || !Array.isArray(r.entries)) {
				error = SW_UNAVAILABLE;
			} else {
				entries = r.entries;
				total = r.total || 0;
				pinnedBytes = Number(r.pinnedBytes) || 0;
				quota = typeof r.quota === "number" ? r.quota : 0;
			}
		} catch (e) {
			error = `Impossible de lire le cache hors-ligne : ${(e as Error)?.message ?? e}`;
		} finally {
			loading = false;
		}
	}

	// HL2 "Libérer de l'espace": plan (planFreeUp, LRU, pinned never touched),
	// show count + Mo, apply on confirm (uncache-audio per entry, sequential so
	// each ack matches, then applySwEviction so `cachedIds` / badges follow at
	// once) and show the new total. The plan (then the outcome) is exposed in
	// window.__ytmFreeUpPlan for the browser harness.
	let freePlan: FreeUpPlan<AudioListEntry> | null = null;
	let freeResult = "";
	let freeConfirmButton: HTMLButtonElement | null = null;
	let freeUpButton: HTMLButtonElement | null = null;
	type FreeUpWindow = Window & { __ytmFreeUpPlan?: Record<string, unknown> };
	function exposePlan(extra: Record<string, unknown> = {}) {
		if (!freePlan || typeof window === "undefined") return;
		(window as FreeUpWindow).__ytmFreeUpPlan = {
			target: freePlan.target,
			count: freePlan.count,
			bytes: freePlan.bytes,
			reached: freePlan.reached,
			protectedBytes: freePlan.protectedBytes,
			videoIds: freePlan.entries.map((e) => e.videoId),
			...extra,
		};
	}
	async function askFreeUp() {
		if (busy) return;
		busy = "freeup";
		error = "";
		freeResult = "";
		try {
			// Fresh listing: lastAccess moves with every play.
			const l = await listCachedAudio();
			if (!l || !Array.isArray(l.entries)) {
				error = SW_UNAVAILABLE;
				return;
			}
			entries = l.entries;
			total = l.total || 0;
			pinnedBytes = Number(l.pinnedBytes) || 0;
			const playing = $currentTrack?.videoId;
			freePlan = planFreeUp(entries, sizeMb * MB, { protect: playing ? [playing] : [] });
			exposePlan({ applied: false });
			await tick();
			freeConfirmButton?.focus();
		} catch (e) {
			error = `Impossible de préparer la libération : ${(e as Error)?.message ?? e}`;
		} finally {
			busy = "";
		}
	}
	async function cancelFreeUp() {
		freePlan = null;
		await tick();
		freeUpButton?.focus();
	}
	async function doFreeUp() {
		if (busy || !freePlan || !freePlan.count) return;
		busy = "freeup";
		error = "";
		const plan = freePlan;
		try {
			let failed = 0;
			const removed: string[] = [];
			for (const e of plan.entries) {
				const r = await swRequest<{ type: "audio-uncached"; ok: boolean }>(
					{ type: "uncache-audio", url: e.url || "", videoId: e.videoId || "" },
					"audio-uncached",
					5_000,
				);
				if (r && r.ok) removed.push(e.videoId);
				else failed++;
			}
			// Same path as an SW eviction: badges and the local list follow at once,
			// then the debounced list-audio refresh confirms.
			if (removed.length) applySwEviction(removed);
			scheduleSwAudioRefresh();
			await refresh();
			const freed = plan.entries.filter((e) => removed.includes(e.videoId)).reduce((s, e) => s + (Number(e.bytes) || 0), 0);
			freeResult = `${freeUpSummary({ count: removed.length, bytes: freed })} libéré${removed.length > 1 ? "s" : ""}${failed ? ` · ${failed} impossible${failed > 1 ? "s" : ""}` : ""} · ${status.totalText} restants`;
			exposePlan({ applied: true, removed: removed.length, failed, freedBytes: freed, totalAfter: total });
			notify(freeResult, failed ? "error" : "success");
			dispatch("changed");
		} catch (e) {
			error = `Impossible de libérer de l'espace : ${(e as Error)?.message ?? e}`;
		} finally {
			busy = "";
			freePlan = null;
			await tick();
			freeUpButton?.focus();
		}
	}

	// HL3 "Préparer un pack": plan (planPack: favourites, recent plays, mix,
	// uncached only, known size else 4 Mo) up to the chosen size, then one keep
	// job (I12 store, so leaving the page keeps it running) that downloads +
	// pins each track, 2 at a time. "Annuler" aborts the job: the in-flight SW
	// fetches are aborted too (keepDepsWithAbort), what landed stays pinned.
	// window.__ytmPackPlan carries the plan, then the outcome, for the harness.
	const PACK_KEY = "pack:offline";
	function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
		return p.catch(() => fallback);
	}
	let packState: "" | "planning" | "running" | "done" | "cancelled" | "too-big" = "";
	let packPlan: PackPlan | null = null;
	let packProgress: KeepProgress | null = null;
	let packDoneBytes = 0;
	let packDoneSeconds = 0;
	/** U13-2: estimated bytes of the running duration pack (the progress line's "sur env. 1,1 Go"). */
	let packEstBytes = 0;
	let packResult = "";
	let packOwned = false; // started by this instance (its onDone writes the outcome)
	/** B7-8: the refused plan and the head of it that fits ("Préparer 1 h 20 quand même"). */
	let packGuard: PackGuard | null = null;
	/** B7-7: the last pack this device prepared (null = no "Rafraîchir" button). */
	let lastPack: LastPack | null = null;
	let packStartButton: HTMLButtonElement | null = null;
	let sizeSelect: HTMLSelectElement | null = null;
	function storage(): Storage | null {
		try {
			return typeof localStorage !== "undefined" ? localStorage : null;
		} catch {
			return null;
		}
	}
	$: packJob = $keepJobs.get(PACK_KEY);
	$: if (packJob?.progress) packProgress = packJob.progress;
	// A pack started before (a previous visit of the page) still runs: show it;
	// when it ends without our onDone, close it from the last progress seen.
	$: if (packJob && packState === "") packState = "running";
	$: if (!packJob && packState === "running" && !packOwned) {
		packState = "done";
		packResult = packProgress ? `${packProgress.ready}/${packProgress.total} prêts hors-ligne` : "Pack terminé";
	}
	$: packRunning = packState === "running" || packState === "planning";
	// U12-9: a pack in progress (started here or found running on mount) unfolds
	// the card once; only `packRunning` is read, so the user can still fold it.
	$: if (packRunning) open = true;
	// U13-2 (audit UX v13): a pack started by another page (the home "Emporte
	// 1 h" card) runs under PACK_KEY without a plan here. Its memo
	// (LAST_PACK_KEY, written before the job starts) carries its mode, target,
	// tracks and estimate, so the progress line reports THAT pack ("3/19 ·
	// 12 min sur 1 h · 180 Mo sur env. 1,1 Go", done = its tracks now cached)
	// and the disabled selector shows its duration, never the selector's own
	// "100 Mo" (which used to read "0/19 · 0 Mo sur 100 Mo").
	$: adopted = packJob && !packPlan && lastPack ? lastPack : null;
	$: adoptedDone = adopted ? packDoneOf(adopted, $cachedIds, packProgress?.ready ?? 0) : null;
	$: if (adopted && packState === "running") {
		const want = adopted.mode === "seconds" ? `dur:${adopted.target}` : String(Math.round(adopted.target / MB));
		if (parsePackChoice(want) && choice !== want) choice = want;
	}
	$: packTarget = packPlan ? packPlan.target : adopted ? adopted.target : durationSec || sizeMb * MB;
	$: packMode = packPlan ? packPlan.mode : adopted ? adopted.mode : durationSec ? "seconds" : "bytes";
	$: shownDoneSeconds = adoptedDone ? adoptedDone.seconds : packDoneSeconds;
	$: shownDoneBytes = adoptedDone ? adoptedDone.bytes : packDoneBytes;
	$: shownEstBytes = adopted ? (adopted.estimatedBytes ?? 0) : packEstBytes;
	$: packText =
		packState === "planning"
			? "Préparation…"
			: packState === "running"
				? packMode === "seconds"
					? packDurationText(packProgress?.ready ?? 0, packProgress?.total ?? packPlan?.count ?? 0, shownDoneSeconds, packTarget, shownDoneBytes, shownEstBytes)
					: packLabel(packProgress?.ready ?? 0, packProgress?.total ?? packPlan?.count ?? 0, shownDoneBytes, packTarget)
				: packResult;
	type PackWindow = Window & { __ytmPackPlan?: Record<string, unknown>; __ytmPackRefresh?: Record<string, unknown> };
	function exposePack(extra: Record<string, unknown> = {}) {
		if (typeof window === "undefined") return;
		(window as PackWindow).__ytmPackPlan = {
			target: packTarget,
			mode: packMode,
			count: packPlan?.count ?? 0,
			bytes: packPlan?.bytes ?? 0,
			seconds: packPlan?.seconds ?? 0,
			doneSeconds: packDoneSeconds,
			left: packPlan?.left ?? 0,
			candidates: packPlan?.candidates ?? 0,
			videoIds: packPlan ? packPlan.items.map((i) => i.videoId) : [],
			state: packState,
			doneBytes: packDoneBytes,
			estimatedBytes: packEstBytes,
			progress: packProgress,
			guard: packGuard
				? { fits: packGuard.fits, estimated: packGuard.estimated, available: packGuard.available, limit: packGuard.limit, shrunkCount: packGuard.shrunk.count, shrunkSeconds: packGuard.shrunk.seconds, message: packGuard.message }
				: null,
			...extra,
		};
	}
	function resetPackRun() {
		packOwned = true;
		packPlan = null;
		packProgress = null;
		packDoneBytes = 0;
		packDoneSeconds = 0;
		packEstBytes = 0;
		packResult = "";
		packGuard = null;
		refreshNothing = "";
		error = "";
	}
	// U13-18 (audit UX v13): "Rien à rafraîchir" / "Rien à préparer" answered
	// in the progress box with an empty bar, like a stuck job. A status that
	// no job produced (packProgress null) is a plain line, no <progress>, and
	// goes at the next gesture (the selector).
	$: packHasBar = packState === "planning" || packState === "running" || !!packProgress;
	function dismissStatusLine() {
		if (packState === "done" && !packProgress) {
			packState = "";
			packResult = "";
			refreshNothing = "";
			exposePack();
		}
	}
	type PackSources = { favorites: any[]; recent: any[]; plays: Array<{ videoId?: string; playedAt?: number }>; mix: any[]; cached: Set<string>; sizes: Map<string, number> };
	/** The three sources of a pack plus the cache (fresh SW listing, local sizes). */
	async function packSources(): Promise<PackSources> {
		const [fav, rec, mix, l] = await Promise.all([
			safe(getFavorites(), { favorites: [], items: [] } as { favorites: any[]; items: any[] }),
			safe(getRecent(100), { items: [] } as { items: any[]; playedAt?: number[] }),
			safe(getMix(), { items: [], seeds: 0 } as { items: any[]; seeds: number }),
			safe(listCachedAudio(), null),
		]);
		if (l && Array.isArray(l.entries)) {
			entries = l.entries;
			total = l.total || 0;
			pinnedBytes = Number(l.pinnedBytes) || 0;
			quota = typeof l.quota === "number" ? l.quota : 0;
		}
		const cached = new Set<string>(get(cachedIds));
		const sizes = new Map<string, number>();
		for (const t of getOfflineTracks()) if (t.videoId && Number(t._bytes) > 0) sizes.set(t.videoId, Number(t._bytes));
		for (const e of entries) {
			if (e.videoId) cached.add(e.videoId);
			if (e.videoId && e.bytes > 0) sizes.set(e.videoId, e.bytes);
		}
		const favorites = Array.isArray(fav?.items) && fav.items.length ? fav.items : Array.isArray(fav?.favorites) ? fav.favorites : [];
		const recent = Array.isArray(rec?.items) ? rec.items : [];
		// me/stats/recent: `playedAt` (epoch ms) aligned with `items` (S3).
		const playedAt = Array.isArray((rec as { playedAt?: unknown })?.playedAt) ? ((rec as { playedAt?: number[] }).playedAt as number[]) : [];
		// L13-1: the device's listen log carries the seconds really listened
		// (listenedPackIds only trusts those); the server plays date the rest.
		const plays = [
			...recent.map((it, i) => ({ videoId: it?.videoId, playedAt: Number(playedAt[i]) || 0 })),
			...readListenLog(storage()).map((e) => ({ videoId: e.videoId, playedAt: e.at, seconds: e.seconds, duration: e.duration })),
		];
		return { favorites, recent, plays, mix: Array.isArray(mix?.items) ? mix.items : [], cached, sizes };
	}
	/** B7-8: the average bitrate of what is cached (bytes / known length), 1 Mo/min by default. */
	function cacheBytesPerSecond(): number {
		const secs = new Map<string, number>();
		for (const t of getOfflineTracks()) {
			const d = durationOf(t);
			if (t.videoId && d && d > 0) secs.set(t.videoId, d);
		}
		return averageBytesPerSecond(entries, secs);
	}
	async function startPack() {
		if (packRunning || busy || loading) return;
		packState = "planning";
		resetPackRun();
		try {
			const src = await packSources();
			packPlan = planPack({ favorites: src.favorites, recent: src.recent, mix: src.mix, cached: src.cached, sizes: src.sizes }, durationSec || sizeMb * MB, durationSec ? "seconds" : "bytes");
			if (!packPlan.count) {
				packState = "done";
				packResult = packPlan.candidates ? "Rien ne rentre dans ce pack : choisis une taille ou une durée plus grande." : "Rien à préparer : tes favoris et tes écoutes récentes sont déjà hors-ligne.";
				exposePack();
				return;
			}
			// B7-8 (L12-14): a duration bounds listening time, not bytes: measure
			// the plan against the room left (quota - pinned, and L13-4 the
			// storage the browser grants this origin, unpinned audio counted as
			// free since the SW evicts it by itself) first.
			if (packPlan.mode === "seconds") {
				const st = await safe(storageStatus(), { persisted: null, usage: 0, quota: 0 });
				const originFree = originRoom(st, entries);
				const guard = guardPackSpace(packPlan, { quota, pinnedBytes, originFree }, cacheBytesPerSecond());
				if (!guard.fits) {
					packGuard = guard;
					packState = "too-big";
					packResult = guard.message;
					exposePack();
					return;
				}
			}
			runPack(packPlan, src.sizes);
		} catch (e) {
			packState = "";
			error = `Impossible de préparer le pack : ${(e as Error)?.message ?? e}`;
		}
	}
	/** B7-8: start the head of the refused plan that fits. */
	function startShrunkPack() {
		if (packState !== "too-big" || !packGuard || !packGuard.shrunk.count) return;
		const plan = packGuard.shrunk;
		packGuard = null;
		const sizes = new Map<string, number>();
		for (const i of plan.items) if (!i.estimated) sizes.set(i.videoId, i.bytes);
		runPack(plan, sizes);
	}
	function dismissPackGuard() {
		if (packState !== "too-big") return;
		packState = "";
		packGuard = null;
		packResult = "";
		exposePack();
	}
	/**
	 * Run a plan as THE pack job (PACK_KEY): downloads + pins, 2 at a time,
	 * cancellable; `lastPackNext` is what the device remembers as its pack
	 * once the job starts (the plan itself for a pack, keep + add for a refresh).
	 */
	function runPack(plan: PackPlan, sizes: Map<string, number>, lastPackNext: LastPack = lastPackOf(plan)) {
		packPlan = plan;
		packState = "running";
		packProgress = { ready: 0, failed: 0, refused: 0, total: plan.count };
		// U13-2: a duration pack says what it costs in bytes ("y Mo sur env. 1,1 Go").
		packEstBytes = plan.mode === "seconds" ? estimatePackBytes(plan, cacheBytesPerSecond()) : 0;
		exposePack();
		// O10: a pack is an explicit "keep offline".
		void requestPersistentStorage();
		const memo: LastPack = packEstBytes > 0 && !lastPackNext.estimatedBytes ? { ...lastPackNext, estimatedBytes: packEstBytes } : lastPackNext;
		lastPack = memo;
		writeLastPack(storage(), memo);
		void startKeepJob(PACK_KEY, () => plan.items.map((i) => i.item), {
			deps: (signal) =>
				keepDepsWithAbort(signal, {
					...defaultKeepDeps,
					download: async (t, o) => {
						const r = await defaultKeepDeps.download(t, o);
						if (r.ok) {
							packDoneBytes += Number(r.bytes) || packSizeOf(t, sizes).bytes;
							packDoneSeconds += packSecondsOf(t);
						}
						return r;
					},
				}),
			onDone: (r: KeepResult) => {
				packState = r.cancelled ? "cancelled" : "done";
				packProgress = { ready: r.ready, failed: r.failed, refused: r.refused, total: r.total };
				const s = keepSummary(r);
				packResult = `${s.text} · ${plan.mode === "seconds" ? packDurationLabel(packDoneSeconds) || "0 min" : fmtBytesFr(packDoneBytes)}`;
				notify(s.text, s.type);
				exposePack({ result: { ...r } });
				void refresh();
				dispatch("changed");
			},
		});
	}
	// B7-7 "Rafraîchir mon pack": the pack tracks really listened to since the
	// pack began (L13-1: >= 50 % / >= 2 min in the device's listen log, never
	// the SW lastAccess, which a startup restore or a 2 s skip also moves) are
	// uncached (the same uncache-audio path as "Libérer", so pinned entries
	// outside the pack stay) and as many seconds of new tracks are run as a
	// pack. The track playing and the restored last track are never dropped.
	//
	// B8-11 (cycle 47): the refresh is previewed first. "Rafraîchir mon pack"
	// computes the plan and shows [data-testid=pack-refresh-preview]: the
	// tracks that would be uncached (title, artist, one [pack-refresh-row]
	// each), what replaces them, then [pack-refresh-confirm] runs it and
	// [pack-refresh-cancel] drops it. Nothing is uncached before the
	// confirmation. window.__ytmPackRefresh carries the plan at the preview
	// (`preview: true`, no `applied`), then the outcome (`applied`).
	type RefreshPreview = { prev: LastPack; src: PackSources; listened: Set<string>; plan: PackRefreshPlan; rows: PackRefreshRow[] };
	let refreshPreview: RefreshPreview | null = null;
	/** The refresh plan is being computed (the "Rafraîchir" button says so, not "Préparer un pack"). */
	let refreshPlanning = false;
	/** U13-18: why the last refresh had nothing to do ("" = it had): the button's title while it stays disabled. */
	let refreshNothing = "";
	let refreshButton: HTMLButtonElement | null = null;
	let refreshConfirmButton: HTMLButtonElement | null = null;
	function exposeRefresh(p: Pick<RefreshPreview, "prev" | "listened" | "plan">, extra: Record<string, unknown> = {}) {
		if (typeof window === "undefined") return;
		(window as PackWindow).__ytmPackRefresh = {
			packAt: p.prev.at,
			packIds: p.prev.items.map((i) => i.videoId),
			listened: [...p.listened],
			dropped: p.plan.drop.map((i) => i.videoId),
			kept: p.plan.keep.map((i) => i.videoId),
			seconds: p.plan.seconds,
			added: p.plan.add.items.map((i) => i.videoId),
			addedSeconds: p.plan.add.seconds,
			...extra,
		};
	}
	async function refreshPack() {
		if (packRunning || busy || loading || !lastPack || refreshPreview) return;
		const prev = lastPack;
		packState = "planning";
		refreshPlanning = true;
		resetPackRun();
		try {
			const src = await packSources();
			const listened = listenedPackIds(prev, { plays: src.plays });
			const protect = [get(currentTrack)?.videoId, readLastTrack(storage() ?? undefined)?.videoId];
			const plan = planPackRefresh(prev, listened, { favorites: src.favorites, recent: src.recent, mix: src.mix, cached: src.cached, sizes: src.sizes }, protect);
			if (!plan.drop.length || !plan.add.count) {
				// U13-18: no job ran: a plain status line (no bar), the button
				// stays disabled with the reason until the next gesture.
				packState = "done";
				packResult = packRefreshSummary(plan);
				refreshNothing = plan.drop.length ? "Pas de nouveau titre pour remplacer les titres écoutés" : "Aucun titre écouté depuis le pack";
				exposeRefresh({ prev, listened, plan }, { applied: false });
				exposePack();
				return;
			}
			// The names come from the local offline list first (what the SW
			// holds), then from the pack sources the plan was built on.
			const rows = packRefreshRows(plan.drop, [...getOfflineTracks(), ...src.favorites, ...src.recent, ...src.mix]);
			packState = "";
			refreshPreview = { prev, src, listened, plan, rows };
			exposeRefresh({ prev, listened, plan }, { preview: true, rows: rows.map((r) => ({ videoId: r.videoId, title: r.title, artist: r.artist })) });
			await tick();
			refreshConfirmButton?.focus();
		} catch (e) {
			packState = "";
			error = `Impossible de rafraîchir le pack : ${(e as Error)?.message ?? e}`;
		} finally {
			refreshPlanning = false;
		}
	}
	async function cancelRefresh() {
		if (!refreshPreview) return;
		exposeRefresh(refreshPreview, { preview: false, cancelled: true });
		refreshPreview = null;
		await tick();
		refreshButton?.focus();
	}
	async function confirmRefresh() {
		if (!refreshPreview || packRunning || busy) return;
		const { prev, src, listened, plan } = refreshPreview;
		refreshPreview = null;
		packState = "planning";
		try {
			const byId = new Map<string, AudioListEntry>();
			for (const e of entries) if (e.videoId) byId.set(e.videoId, e);
			const removed: string[] = [];
			let failed = 0;
			for (const d of plan.drop) {
				const e = byId.get(d.videoId);
				const r = await swRequest<{ type: "audio-uncached"; ok: boolean }>({ type: "uncache-audio", url: e?.url || "", videoId: d.videoId }, "audio-uncached", 5_000);
				if (r && r.ok) removed.push(d.videoId);
				else if (e) failed++;
			}
			if (removed.length) applySwEviction(removed);
			scheduleSwAudioRefresh();
			exposeRefresh({ prev, listened, plan }, { applied: true, removed, failed });
			notify(packRefreshSummary(plan), "success");
			// L13-16: a drop the SW did not uncache stays pinned: keep it in the
			// remembered pack rather than forgetting it while it holds its bytes.
			const stillCached = plan.drop.map((d) => d.videoId).filter((id) => !removed.includes(id));
			runPack(plan.add, src.sizes, refreshedLastPack(prev, plan, Date.now(), stillCached));
		} catch (e) {
			packState = "";
			error = `Impossible de rafraîchir le pack : ${(e as Error)?.message ?? e}`;
		}
	}
	function cancelPack() {
		if (packState !== "running") return;
		// The UI stops now; onDone (within the second, the SW fetches are
		// aborted) writes the final count.
		packState = "cancelled";
		packResult = `Annulation… ${packProgress?.ready ?? 0} prêt${(packProgress?.ready ?? 0) > 1 ? "s" : ""}`;
		cancelKeepJob(PACK_KEY);
		exposePack();
	}

	onMount(() => {
		try {
			const stored = localStorage.getItem(SPACE_OPEN_KEY);
			if (stored === "1") open = true;
			else if (stored === "0" && !packRunning) open = false;
		} catch {
			/* ignore */
		}
		// B7-7: the pack this device prepared last ("Rafraîchir mon pack").
		lastPack = readLastPack(storage());
		// B6-17: /library/downloads-offline?pack=dur:7200 (home weekend card)
		// preselects the pack and unfolds the card, without storing a preference.
		// B7-12: ?pack=1 (manifest shortcut "Pack trajet") unfolds it and
		// focuses the selector, the duration list first; the parameter is then
		// dropped so a reload does not replay it.
		try {
			const url = new URL(window.location.href);
			const wanted = url.searchParams.get("pack");
			if (wanted === "1") {
				open = true;
				if (!parsePackChoice(choice) || parsedChoice.kind !== "seconds") choice = `dur:${PACK_DURATIONS_SEC[1]}`;
				url.searchParams.delete("pack");
				// L13-14: through the router, so $page.url forgets the parameter
				// too and a "back" to this entry does not unfold the card again.
				void goto(url.pathname + url.search + url.hash, { replaceState: true, noScroll: true, keepFocus: true }).catch(() => {
					/* keep the parameter: harmless */
				});
				void tick().then(() => {
					sizeSelect?.scrollIntoView({ block: "center" });
					sizeSelect?.focus();
				});
			} else if (wanted && parsePackChoice(wanted)) {
				choice = wanted;
				open = true;
				void tick().then(() => document.getElementById("offline-pack-start")?.scrollIntoView({ block: "center" }));
			}
		} catch {
			/* ignore */
		}
		void refresh();
	});
</script>

<section
	class="space"
	data-testid="offline-space"
	aria-labelledby="offline-space-heading"
	aria-busy={loading || !!busy || packRunning}
>
	<h2
		class="space-head"
		class:open
		id="offline-space-heading"
	>
		<button
			type="button"
			class="btn-reset space-toggle"
			data-testid="space-toggle"
			aria-expanded={open}
			aria-controls={open ? "offline-space-body" : undefined}
			title={open ? "Replier l'espace" : "Gérer l'espace : libérer ou préparer un pack"}
			on:click={toggleOpen}
		>
			<span
				class="chev"
				class:open
				aria-hidden="true">›</span
			>
			<span class="space-title">Espace</span>
			<span
				class="space-status"
				id="offline-space-status"
				aria-live="polite">{status.text}{#if !open}{packState === "running" ? " · pack en cours" : " · Libérer · Préparer un pack"}{/if}</span
			>
		</button>
	</h2>
	{#if !open && packState === "running"}
		<!-- L10-14: folding the card during a pack keeps its "Annuler" reachable. -->
		<div
			class="space-folded-actions"
			data-testid="space-folded-actions"
		>
			<button
				type="button"
				class="btn-reset btn-secondary danger"
				data-testid="pack-cancel"
				aria-label="Annuler le pack"
				on:click={cancelPack}
			>
				Annuler
			</button>
		</div>
	{/if}
	{#if open}
		<div
			class="space-body"
			id="offline-space-body"
		>
		<div class="space-row">
			<label
				class="size-label"
				for="offline-space-size">Taille ou durée</label
			>
			<div class="select">
				<select
					id="offline-space-size"
					name="offline-space-size"
					data-testid="pack-size"
					aria-describedby="offline-space-desc"
					disabled={packRunning || !!busy || !!freePlan}
					bind:value={choice}
					bind:this={sizeSelect}
					on:change={dismissStatusLine}
				>
					<optgroup label="Taille">
						{#each PACK_SIZES_MB as mb}
							<option value={String(mb)}>{formatMoFr(mb)}</option>
						{/each}
					</optgroup>
					<optgroup label="Durée d'écoute">
						{#each PACK_DURATIONS_SEC as sec}
							<option value={`dur:${sec}`}>{packDurationLabel(sec)}</option>
						{/each}
					</optgroup>
				</select>
			</div>
			{#if !freePlan}
				<button
					type="button"
					id="offline-free-up"
					class="btn-reset btn-secondary"
					data-testid="free-up"
					aria-describedby="offline-space-desc"
					disabled={loading || !!busy || packRunning || cachedTracks === 0 || durationSec > 0}
					title={durationSec > 0
						? "Choisis une taille pour libérer de l'espace"
						: cachedTracks === 0 && !loading
							? "Rien en cache : rien à libérer"
							: "Retire les morceaux les moins écoutés, jamais les épinglés"}
					bind:this={freeUpButton}
					on:click={askFreeUp}
				>
					{busy === "freeup" ? "Calcul…" : labels.freeUp}
				</button>
			{/if}
			{#if packState === "running"}
				<button
					type="button"
					id="offline-pack-cancel"
					class="btn-reset btn-secondary danger"
					data-testid="pack-cancel"
					on:click={cancelPack}
				>
					Annuler
				</button>
			{:else}
				<button
					type="button"
					id="offline-pack-start"
					class="btn-reset btn-secondary"
					data-testid="pack-start"
					aria-describedby="offline-space-desc"
					disabled={loading || !!busy || packRunning || !!freePlan}
					title="Télécharge et épingle tes favoris, puis tes écoutes récentes, puis ta sélection"
					bind:this={packStartButton}
					on:click={startPack}
				>
					{packState === "planning" && !refreshPlanning ? "Préparation…" : labels.pack}
				</button>
				{#if lastPack && lastPack.items.length}
					<!-- B7-7: only once a pack was prepared on this device. -->
					<button
						type="button"
						id="offline-pack-refresh"
						class="btn-reset btn-secondary"
						data-testid="pack-refresh"
						data-pack-count={lastPack.items.length}
						aria-describedby="offline-space-desc"
						disabled={loading || !!busy || packRunning || !!freePlan || !!refreshPreview || !!refreshNothing}
						title={refreshNothing || "Montre d'abord les titres du pack déjà écoutés qui seraient remplacés par de nouveaux, même durée d'écoute ; les épinglés hors du pack ne bougent pas"}
						bind:this={refreshButton}
						on:click={refreshPack}
					>
						{refreshPlanning ? "Préparation…" : "Rafraîchir mon pack"}
					</button>
				{/if}
			{/if}
		</div>
		{#if refreshPreview}
			<!-- B8-11: what the refresh would uncache, before anything happens. -->
			<div
				class="panel"
				role="group"
				aria-labelledby="offline-pack-refresh-preview"
				data-testid="pack-refresh-preview"
				data-count={refreshPreview.rows.length}
				data-seconds={refreshPreview.plan.seconds}
				data-add={refreshPreview.plan.add.count}
			>
				<span id="offline-pack-refresh-preview">{packRefreshPreviewTitle(refreshPreview.plan)}</span>
				<ol class="preview-list">
					{#each refreshPreview.rows as r (r.videoId)}
						<li
							data-testid="pack-refresh-row"
							data-video-id={r.videoId}
						>
							<span class="preview-title">{r.title}</span>
							{#if r.artist}<span class="preview-artist">{r.artist}</span>{/if}
						</li>
					{/each}
				</ol>
				<div class="panel-actions">
					<button
						type="button"
						id="offline-pack-refresh-confirm"
						class="btn-reset btn-secondary danger"
						data-testid="pack-refresh-confirm"
						disabled={!!busy || packRunning}
						bind:this={refreshConfirmButton}
						on:click={confirmRefresh}
					>
						Rafraîchir
					</button>
					<button
						type="button"
						id="offline-pack-refresh-cancel"
						class="btn-reset btn-ghost"
						data-testid="pack-refresh-cancel"
						on:click={cancelRefresh}
					>
						Annuler
					</button>
				</div>
			</div>
		{/if}
		<p
			class="space-desc"
			id="offline-space-desc"
		>
			{#if durationSec}
				Un pack trajet télécharge et épingle tes favoris, puis tes écoutes récentes, puis ta sélection, jusqu'à {packDurationLabel(durationSec)}
				d'écoute. Choisis une taille pour libérer de l'espace.
			{:else}
				Libérer retire les morceaux les moins écoutés jusqu'à {formatMoFr(sizeMb)} (les épinglés ne sont jamais touchés) ; un pack télécharge
				et épingle tes favoris, puis tes écoutes récentes, puis ta sélection, jusqu'à {formatMoFr(sizeMb)}.
			{/if}
		</p>
		{#if freePlan}
			<div
				class="panel"
				role="group"
				aria-labelledby="offline-free-up-plan"
			>
				<span
					id="offline-free-up-plan"
					data-testid="free-up-plan"
					data-count={freePlan.count}
					data-bytes={freePlan.bytes}
					>{#if freePlan.count}{freeUpSummary(freePlan)} seront libérés{#if !freePlan.reached}
							(moins que {formatMoFr(sizeMb)} : le reste est épinglé ou en lecture){/if}.{:else}Rien à libérer : tout est épinglé ou
						en lecture.{/if}</span
				>
				<div class="panel-actions">
					{#if freePlan.count}
						<button
							type="button"
							id="offline-free-up-confirm"
							class="btn-reset btn-secondary danger"
							data-testid="free-up-confirm"
							disabled={!!busy}
							bind:this={freeConfirmButton}
							on:click={doFreeUp}
						>
							{busy === "freeup" ? "Libération…" : "Libérer"}
						</button>
					{/if}
					<button
						type="button"
						id="offline-free-up-cancel"
						class="btn-reset btn-ghost"
						data-testid="free-up-cancel"
						disabled={!!busy}
						on:click={cancelFreeUp}
					>
						{freePlan.count ? "Annuler" : "Fermer"}
					</button>
				</div>
			</div>
		{/if}
		{#if freeResult}
			<p
				class="space-result"
				id="offline-free-up-result"
				data-testid="free-up-result"
				aria-live="polite"
			>
				{freeResult}
			</p>
		{/if}
		{#if packState}
			<div
				class="panel pack-progress"
				class:pack-status={!packHasBar}
				data-testid="pack-progress"
				data-state={packState}
				data-bar={packHasBar ? "1" : "0"}
				data-ready={packProgress?.ready ?? 0}
				data-total={packProgress?.total ?? packPlan?.count ?? 0}
				data-bytes={shownDoneBytes}
				data-seconds={shownDoneSeconds}
				data-estimated={shownEstBytes}
				data-mode={packMode}
				role="status"
				aria-live="polite"
			>
				{#if packHasBar}
					{#if packState === "planning"}
						<!-- Planning: no value attribute = indeterminate, not a bar stuck
						     at 0. c52d: never `value={undefined}` on a <progress>: Svelte
						     sets the DOM property, the setter throws (non-finite double)
						     inside the flush and the scheduler never resets
						     update_scheduled: the whole app stops re-rendering
						     ("Préparation…" forever, chain 60). -->
						<progress
							max="1"
							aria-label="Progression du pack"
						/>
					{:else}
						<progress
							max={Math.max(1, packProgress?.total ?? packPlan?.count ?? 1)}
							value={packProgress?.ready ?? 0}
							aria-label="Progression du pack"
						/>
					{/if}
				{/if}
				<span id="offline-pack-text">{packText}</span>
				{#if packState === "too-big" && packGuard}
					<!-- B7-8: nothing was downloaded; the head that fits is one tap away. -->
					<div class="panel-actions">
						{#if packGuard.shrunk.count}
							<button
								type="button"
								id="offline-pack-shrink"
								class="btn-reset btn-secondary"
								data-testid="pack-shrink"
								data-count={packGuard.shrunk.count}
								data-seconds={packGuard.shrunk.seconds}
								on:click={startShrunkPack}
							>
								Préparer {packDurationLabel(packGuard.shrunk.seconds) || "ce qui tient"} quand même
							</button>
						{/if}
						<button
							type="button"
							id="offline-pack-dismiss"
							class="btn-reset btn-ghost"
							data-testid="pack-dismiss"
							on:click={() => {
								dismissPackGuard();
								void tick().then(() => packStartButton?.focus());
							}}
						>
							Fermer
						</button>
					</div>
				{/if}
			</div>
		{/if}
		{#if error}
			<p
				class="space-error"
				id="offline-space-error"
				role="alert"
			>
				{error}
				<button
					type="button"
					class="btn-reset btn-ghost"
					disabled={loading || !!busy}
					on:click={refresh}>Réessayer</button
				>
			</p>
		{/if}
		</div>
	{/if}
</section>

<style lang="scss">
	$muted: #b3b3b3;
	$accent: #1ed760;

	// Compact card: one heading line, one control row, one help line.
	.space {
		margin: 0.25rem 0 1rem;
		padding: 0.25rem 0.9rem 0.5rem;
		border-radius: 0.8rem;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
	}
	.space-head {
		margin: 0;
		font-size: 1.05rem;
		&.open {
			margin-bottom: 0.5rem;
		}
	}
	// UX8: the whole summary line is the disclosure (44 px target).
	.space-toggle {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.6rem;
		width: 100%;
		min-height: max(2.75rem, 44px);
		padding: 0.25rem 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
			border-radius: 0.4rem;
		}
	}
	.chev {
		display: inline-block;
		align-self: center;
		width: 1em;
		color: $muted;
		transition: transform 0.15s ease;
		&.open {
			transform: rotate(90deg);
		}
	}
	.space-title {
		font-weight: 700;
	}
	.space-status {
		color: $muted;
		font-size: var(--text-secondary-size);
		font-weight: 400;
	}
	.space-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.size-label {
		color: $muted;
		font-size: var(--text-secondary-size);
		text-transform: none;
		/* U12-9: undo the global small caps of _forms.scss (original Beatbump forms only). */
		font-variant-caps: normal;
		letter-spacing: normal;
	}
	.select select {
		min-height: max(2.75rem, 44px);
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
	.danger {
		border-color: rgba(220, 53, 69, 0.6);
	}
	.space-desc {
		margin: 0.5rem 0 0;
		color: #999;
		font-size: var(--text-secondary-size);
		line-height: 1.35;
	}
	.panel {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin-top: 0.6rem;
		padding: 0.6rem 0.75rem;
		border-radius: 0.5rem;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.25);
		font-size: 0.9375em;
		line-height: 1.3;
	}
	.panel-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	// B8-11: the tracks a refresh would remove, one line each (title, artist).
	.preview-list {
		margin: 0;
		padding-left: 1.4rem;
		max-height: 14rem;
		overflow-y: auto;
		li {
			padding: 0.2rem 0;
			line-height: 1.3;
		}
	}
	.preview-title {
		overflow-wrap: anywhere;
	}
	.preview-artist {
		color: $muted;
		font-size: var(--text-secondary-size);
		&::before {
			content: " · ";
		}
	}
	.pack-progress progress {
		width: 100%;
		height: 0.5rem;
		accent-color: $accent;
	}
	// U13-18: a status no job produced is one line, not a boxed progress panel.
	.pack-progress.pack-status {
		background: none;
		border: 0;
		padding: 0.25rem 0;
		color: rgba(255, 255, 255, 0.85);
	}
	.space-result {
		margin: 0.5rem 0 0;
		font-size: var(--text-secondary-size);
		color: rgba(255, 255, 255, 0.85);
	}
	.space-error {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0.5rem 0 0;
		font-size: var(--text-secondary-size);
		color: #ffb3b3;
	}
	.space-folded-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 0.5rem;
	}
</style>
