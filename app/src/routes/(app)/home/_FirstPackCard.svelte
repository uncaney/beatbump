<script lang="ts">
	// c48c B8-2 "Emporte 1 h de musique": the day-one card of the home. For a
	// profile without history (no play recorded, like _FirstRun) and once the
	// service worker is active, one tap prepares a 1 h trip pack drawn from
	// the album of the day, the artist of the day and a decade mix (the pack
	// sources of the Espace card are empty on a blank profile), run as THE
	// pack job of the Hors-ligne page (FIRST_PACK_JOB_KEY = its PACK_KEY: the
	// Espace card shows the progress, cancels it and remembers it), then the
	// page moves there. "✕" or the tap writes the memo (localStorage
	// FIRST_PACK_KEY): the card is shown once, never again. Self-contained:
	// mounted by one line in +page.svelte. window.__ytmFirstPack carries the
	// plan for the harness (first_pack_card).
	// U13-4: never on the first screen of the session. The card waits for the
	// first sound (AudioPlayer.paused true -> false once, the InstallHint
	// gate's `heardFirstSound`): on day one the Bienvenue block has stepped
	// aside by then, and the first screen carries one call to action less.
	import { onMount } from "svelte";
	import { get } from "svelte/store";
	import { goto } from "$app/navigation";
	import { APIClient } from "$lib/api";
	import { heardFirstSound } from "$lib/components/InstallHint/gate";
	import { isDataSaver } from "$lib/dataSaver";
	import { utcDay } from "$lib/albumOfDay";
	import { FIRST_PACK_HREF, FIRST_PACK_JOB_KEY, FIRST_PACK_KEY, firstPackSizeText, firstPackSources, freezeFirstPack, frozenEstimateFor, hasFirstPackMaterial, planFirstPack, readFrozenFirstPack, shouldShowFirstPackCard, sizeFirstPack, type FirstPackEstimate } from "$lib/firstPack";
	import { getRecent } from "$lib/me";
	import { cachedIds, getOfflineTracks, listCachedAudio, requestPersistentStorage, storageStatus, type AudioListEntry } from "$lib/offline";
	import { defaultKeepDeps, keepDepsWithAbort, keepJobs, keepSummary, startKeepJob, type KeepResult } from "$lib/offlineBatch";
	import { averageBytesPerSecond, estimatePackBytes, guardPackSpace, lastPackOf, originRoom, packDefaultBps, packIsLossless, packSourceEntries, writeLastPack, type PackPlan } from "$lib/offlinePack";
	import { durationOf } from "$lib/offlineQueue";
	import { AudioPlayer } from "$lib/player";
	import { notify } from "$lib/utils";

	// The profile-side conditions (no history, service worker active, no memo).
	let eligible = false;
	// A sound was heard this session (never reset).
	let heardSound = false;
	$: show = eligible && heardSound;
	// U13-2 x U13-4: the size is announced when the card actually shows (after the first sound), once.
	let announced = false;
	$: if (show && !announced) {
		announced = true;
		void announce();
	}
	let busy = false;
	let alive = true;
	// U13-2 (audit UX v13): the plan is computed as soon as the card shows, so
	// the size is announced BEFORE the tap ("Environ 1,1 Go à télécharger"):
	// the library keeps lossless files and "1 h" is no small download on a
	// phone's data plan. Under data saver the plan is cut to PACK_DATA_SAVER_CAP
	// and the line says so. The tap reuses this plan (no second round of calls).
	let sizeText = "";
	type Gathered =
		| { ok: true; plan: PackPlan; estimate: FirstPackEstimate; bps: number; entries: AudioListEntry[]; quota: number; pinnedBytes: number; st: { persisted: boolean | null; usage: number; quota: number } }
		| { ok: false; reason: "no_material" | "empty_plan"; candidates: number };
	let prepared: Gathered | null = null;

	function storage(): Storage | null {
		try {
			return typeof localStorage !== "undefined" ? localStorage : null;
		} catch {
			return null;
		}
	}
	function remember() {
		try {
			storage()?.setItem(FIRST_PACK_KEY, "1");
		} catch {
			/* private mode: hidden for this visit only */
		}
	}
	/** L15-9: the pack job crashed before downloading anything: the card may show again. */
	function forget() {
		try {
			storage()?.removeItem(FIRST_PACK_KEY);
		} catch {
			/* private mode: nothing was stored */
		}
	}
	/** The service worker is active (navigator.serviceWorker.ready, bounded: a first visit installs it). */
	async function swActive(ms = 15000): Promise<boolean> {
		try {
			if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
			const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
			return !!(reg && reg.active);
		} catch {
			return false;
		}
	}

	onMount(() => {
		let alive = true;
		// U13-4: the first sound of the session (a track already playing when
		// the home mounts counts: the store's first emission is "not paused").
		let prevPaused = true;
		const unsubPaused = AudioPlayer.paused.subscribe((paused) => {
			if (heardFirstSound(prevPaused, paused)) heardSound = true;
			prevPaused = paused;
		});
		void (async () => {
			let stored: string | null = null;
			try {
				stored = storage()?.getItem(FIRST_PACK_KEY) ?? null;
			} catch {
				stored = null;
			}
			if (stored === "1") return;
			let recentCount: number | null = 0;
			try {
				// Shares PersonalRows' / FirstRun's me/stats/recent call (getRecent memo).
				const r = await getRecent(1);
				recentCount = Array.isArray(r?.items) ? r.items.length : 0;
			} catch {
				// L14-5: a failed call (offline, 500) is "unknown", not "no history":
				// a named profile with plays elsewhere is not offered a day-one pack.
				recentCount = null;
			}
			if (recentCount === null || recentCount > 0) return;
			const sw = await swActive();
			// The sound gate is applied reactively (`show`): the profile-side
			// answer is computed once, with the gate held open here.
			if (alive) eligible = shouldShowFirstPackCard({ stored, recentCount, swActive: sw, heardSound: true });
		})();
		return () => {
			alive = false;
			unsubPaused();
		};
	});

	function dismiss() {
		remember();
		eligible = false;
	}

	type FirstPackWindow = Window & { __ytmFirstPack?: Record<string, unknown> };
	function expose(extra: Record<string, unknown>) {
		if (typeof window === "undefined") return;
		(window as FirstPackWindow).__ytmFirstPack = { ...((window as FirstPackWindow).__ytmFirstPack ?? {}), ...extra };
	}

	const getJson = async (url: string): Promise<unknown> => {
		const r = await APIClient.fetch(url);
		return r.ok ? r.json() : null;
	};

	/** The sources, the cache and the sized plan (U13-2): shared by the announcement and the tap. */
	async function gather(): Promise<Gathered> {
		const [src, l, st] = await Promise.all([
			firstPackSources(getJson),
			listCachedAudio().catch(() => null),
			storageStatus().catch(() => ({ persisted: null, usage: 0, quota: 0 })),
		]);
		if (!hasFirstPackMaterial(src)) return { ok: false, reason: "no_material", candidates: 0 };
		const entries: AudioListEntry[] = l && Array.isArray(l.entries) ? l.entries : [];
		const cached = new Set<string>(get(cachedIds));
		const sizes = new Map<string, number>();
		const secs = new Map<string, number>();
		for (const t of getOfflineTracks()) {
			if (t.videoId && Number(t._bytes) > 0) sizes.set(t.videoId, Number(t._bytes));
			const d = durationOf(t);
			if (t.videoId && d && d > 0) secs.set(t.videoId, d);
		}
		for (const e of entries) {
			if (e.videoId) cached.add(e.videoId);
			if (e.videoId && e.bytes > 0) sizes.set(e.videoId, e.bytes);
		}
		const plan = planFirstPack(src, cached, sizes);
		if (!plan.count) return { ok: false, reason: "empty_plan", candidates: plan.candidates };
		// U14-1: a library pack downloads lossless files: its default is
		// PACK_LOSSLESS_BPS (25 Mo per 4 min), never the 1 Mo/min of a stream,
		// and the measured bitrate only comes from cache entries of its own
		// source (two Opus streams said 60 Mo for 2 Go of FLAC).
		const lossless = packIsLossless(plan.items);
		const bps = averageBytesPerSecond(packSourceEntries(entries, lossless), secs, packDefaultBps(plan.items));
		let sized = sizeFirstPack(plan, bps, isDataSaver());
		// U14-1: one number per pack: the first estimate announced for these
		// tracks is reused (same figure before and after the tap, on every
		// return to the home), a new plan gets a new one.
		const day = utcDay();
		const frozen = frozenEstimateFor(readFrozenFirstPack(storage(), day), sized.plan);
		if (frozen) sized = { plan: sized.plan, estimate: frozen };
		else freezeFirstPack(storage(), day, sized.plan, sized.estimate);
		return { ok: true, plan: sized.plan, estimate: sized.estimate, bps, entries, quota: typeof l?.quota === "number" ? l.quota : 0, pinnedBytes: Number(l?.pinnedBytes) || 0, st };
	}

	/** U13-2: announce the size on the card (nothing is downloaded; a failure leaves the line empty, the tap plans again). */
	async function announce() {
		try {
			const g = await gather();
			if (!alive) return;
			prepared = g;
			sizeText = g.ok ? firstPackSizeText(g.estimate) : "";
			if (g.ok) expose({ estimate: { ...g.estimate } });
		} catch {
			prepared = null;
			sizeText = "";
		}
	}

	async function start() {
		if (busy) return;
		busy = true;
		try {
			if (get(keepJobs).has(FIRST_PACK_JOB_KEY)) {
				// L14-5: the Espace card's pack runs under the same key: starting
				// here would overwrite its memo (writeLastPack) with a plan that
				// never downloads (startKeepJob returns the running job). Say so,
				// show that pack; the card stays (no memo) for a later trip.
				notify("Un pack est déjà en cours de préparation : retrouve-le sur la page Hors-ligne.", "success");
				expose({ started: false, reason: "pack_running" });
				await goto(FIRST_PACK_HREF);
				return;
			}
			const g = prepared && prepared.ok ? prepared : await gather();
			if (!g.ok) {
				if (g.reason === "no_material") notify("Rien à emporter pour l'instant : la bibliothèque n'a pas encore d'album du jour.", "error");
				else notify(g.candidates ? "Rien ne rentre dans 1 h pour l'instant." : "Tout est déjà hors-ligne : rien à emporter de plus.", "success");
				expose({ started: false, reason: g.reason, candidates: g.candidates });
				dismiss();
				return;
			}
			let plan: PackPlan = g.plan;
			// B7-8: measured against the room left before anything downloads; the
			// head that fits is taken on its own (day one: no dialog to answer).
			const guard = guardPackSpace(plan, { quota: g.quota, pinnedBytes: g.pinnedBytes, originFree: originRoom(g.st, g.entries) }, g.bps);
			if (!guard.fits) {
				if (!guard.shrunk.count) {
					notify(guard.message, "error");
					expose({ started: false, reason: "too_big", message: guard.message });
					return;
				}
				plan = guard.shrunk;
			}
			const estimatedBytes = plan === g.plan ? g.estimate.bytes : estimatePackBytes(plan, g.bps);
			expose({ started: true, count: plan.count, seconds: plan.seconds, target: plan.target, items: plan.items.map((i) => i.videoId), estimatedBytes, capped: g.estimate.capped, dataSaver: g.estimate.dataSaver });
			// O10: a pack is an explicit "keep offline"; the Espace card's "Rafraîchir mon pack" remembers it.
			void requestPersistentStorage();
			// U13-2: the memo carries the estimate, so the Espace card's progress
			// line reports THIS pack ("y Mo sur env. 1,1 Go"), not its selector.
			writeLastPack(storage(), { ...lastPackOf(plan), estimatedBytes });
			const items = plan.items.map((i) => i.item);
			// L15-9: the memo above is written BEFORE the job on purpose (the
			// Espace card adopts it for its progress line as soon as the job is
			// registered, U13-2), but it must not outlive a job that never ran:
			// startKeepJob registers the job synchronously (a throwing `deps`
			// factory lands in the catch below, where the memo is rolled back),
			// and its promise resolves null when the batch itself crashed (SW not
			// answering): then the memo and the "card shown once" marker are
			// dropped, so "Rafraîchir mon pack" does not describe a pack that
			// was never downloaded and the card comes back for a later trip.
			let started: Promise<KeepResult | null>;
			try {
				started = startKeepJob(FIRST_PACK_JOB_KEY, () => items, {
					deps: (signal) => keepDepsWithAbort(signal, defaultKeepDeps),
					onDone: (r: KeepResult) => {
						const s = keepSummary(r);
						notify(s.text, s.type);
						expose({ result: { ...r } });
					},
				});
			} catch (e) {
				writeLastPack(storage(), null);
				throw e;
			}
			remember();
			eligible = false;
			void started.then((r) => {
				if (r !== null) return;
				writeLastPack(storage(), null);
				forget();
				expose({ result: null, reason: "job_crashed" });
			});
			await goto(FIRST_PACK_HREF);
		} catch (e) {
			notify(`Impossible de préparer le pack : ${(e as Error)?.message ?? e}`, "error");
			expose({ started: false, reason: "error", message: String((e as Error)?.message ?? e) });
		} finally {
			busy = false;
		}
	}
</script>

{#if show}
	<div
		class="first-pack-card"
		data-testid="first-pack-card"
	>
		<div class="first-pack-card-body">
			<p class="first-pack-card-title">Emporte 1 h de musique</p>
			<p class="first-pack-card-text">L'album et l'artiste du jour, plus un mix, prêts sans réseau pour ton trajet.</p>
			{#if sizeText}
				<p
					class="first-pack-card-size"
					data-testid="first-pack-size"
				>
					{sizeText}
				</p>
			{/if}
		</div>
		<button
			type="button"
			class="btn-reset btn-secondary first-pack-card-start"
			data-testid="first-pack-start"
			disabled={busy}
			on:click={start}>{busy ? "Préparation…" : "Préparer 1 h"}</button
		>
		<button
			type="button"
			class="btn-reset first-pack-card-dismiss"
			data-testid="first-pack-dismiss"
			aria-label="Fermer la carte Emporte 1 h de musique"
			on:click={dismiss}
		>
			✕
		</button>
	</div>
{/if}

<style>
	/* Same footprint as the weekend card and the Monday "Ta semaine" card. */
	.first-pack-card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin: 0.5em 1rem 0;
		padding: 0.75rem 1rem;
		border-radius: 0.9rem;
		background: hsl(0deg 0% 100% / 6%);
	}
	.first-pack-card-body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.first-pack-card-title {
		font-weight: 600;
		margin: 0 0 0.15em;
	}
	.first-pack-card-text {
		margin: 0;
		opacity: 0.85;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.first-pack-card-size {
		margin: 0.25em 0 0;
		font-size: var(--text-secondary-size);
		color: #bbb;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.first-pack-card-start {
		flex: 0 0 auto;
		white-space: nowrap;
	}
	.first-pack-card-dismiss {
		flex: 0 0 auto;
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		width: max(2.75rem, 44px);
		height: max(2.75rem, 44px);
		opacity: 0.7;
		color: inherit;
		background: none;
		cursor: pointer;
	}
	.first-pack-card-dismiss:hover,
	.first-pack-card-dismiss:focus-visible {
		opacity: 1;
	}
</style>
