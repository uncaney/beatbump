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
	// [data-testid=space-toggle] so "Tout lire" stays above the fold. It is
	// open by default (no stored preference, harness free_up_and_pack clicks
	// free-up right after goto) and stays folded only once the user folded it
	// (localStorage SPACE_OPEN_KEY).
	import { createEventDispatcher, onMount, tick } from "svelte";
	import { get } from "svelte/store";
	import {
		applySwEviction,
		cachedIds,
		getOfflineTracks,
		listCachedAudio,
		requestPersistentStorage,
		scheduleSwAudioRefresh,
		swRequest,
		type AudioListEntry,
	} from "$lib/offline";
	import { freeUpSummary, planFreeUp, type FreeUpPlan } from "$lib/offlineFreeUp";
	import { PACK_SIZES_MB, packLabel, packSizeOf, planPack, type PackPlan } from "$lib/offlinePack";
	import { fmtBytesFr, spaceButtonLabels, spaceStatusLine } from "$lib/offlineSpace";
	import { cancelKeepJob, defaultKeepDeps, keepDepsWithAbort, keepJobs, keepSummary, startKeepJob, type KeepProgress, type KeepResult } from "$lib/offlineBatch";
	import { getFavorites, getMix, getRecent } from "$lib/me";
	import { notify } from "$lib/utils";
	import { formatMoFr } from "$lib/utils/formatFr";
	import { currentTrack } from "$lib/stores/list";

	const MB = 1024 * 1024;
	/** UX8: "0" = the user folded the card; anything else (or nothing) = open. */
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
	/** The one size (Mo) both actions use. */
	let sizeMb: (typeof PACK_SIZES_MB)[number] = 100;

	/** UX8: card unfolded (default) or folded to its summary line. */
	let open = true;
	function toggleOpen() {
		open = !open;
		try {
			localStorage.setItem(SPACE_OPEN_KEY, open ? "1" : "0");
		} catch {
			/* private mode: the choice lasts for this visit only */
		}
	}

	$: cachedTracks = entries.length;
	$: labels = spaceButtonLabels(sizeMb);
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
	let packState: "" | "planning" | "running" | "done" | "cancelled" = "";
	let packPlan: PackPlan | null = null;
	let packProgress: KeepProgress | null = null;
	let packDoneBytes = 0;
	let packResult = "";
	let packOwned = false; // started by this instance (its onDone writes the outcome)
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
	$: packTarget = packPlan ? packPlan.target : sizeMb * MB;
	$: packText =
		packState === "planning"
			? "Préparation…"
			: packState === "running"
				? packLabel(packProgress?.ready ?? 0, packProgress?.total ?? packPlan?.count ?? 0, packDoneBytes, packTarget)
				: packResult;
	type PackWindow = Window & { __ytmPackPlan?: Record<string, unknown> };
	function exposePack(extra: Record<string, unknown> = {}) {
		if (typeof window === "undefined") return;
		(window as PackWindow).__ytmPackPlan = {
			target: packTarget,
			count: packPlan?.count ?? 0,
			bytes: packPlan?.bytes ?? 0,
			left: packPlan?.left ?? 0,
			candidates: packPlan?.candidates ?? 0,
			videoIds: packPlan ? packPlan.items.map((i) => i.videoId) : [],
			state: packState,
			doneBytes: packDoneBytes,
			progress: packProgress,
			...extra,
		};
	}
	async function startPack() {
		if (packRunning || busy || loading) return;
		packState = "planning";
		packOwned = true;
		packPlan = null;
		packProgress = null;
		packDoneBytes = 0;
		packResult = "";
		error = "";
		try {
			const [fav, rec, mix, l] = await Promise.all([
				safe(getFavorites(), { favorites: [], items: [] } as { favorites: any[]; items: any[] }),
				safe(getRecent(100), { items: [] } as { items: any[] }),
				safe(getMix(), { items: [], seeds: 0 } as { items: any[]; seeds: number }),
				safe(listCachedAudio(), null),
			]);
			if (l && Array.isArray(l.entries)) {
				entries = l.entries;
				total = l.total || 0;
			}
			const cached = new Set<string>(get(cachedIds));
			const sizes = new Map<string, number>();
			for (const t of getOfflineTracks()) if (t.videoId && Number(t._bytes) > 0) sizes.set(t.videoId, Number(t._bytes));
			for (const e of entries) {
				if (e.videoId) cached.add(e.videoId);
				if (e.videoId && e.bytes > 0) sizes.set(e.videoId, e.bytes);
			}
			const favItems = Array.isArray(fav?.items) && fav.items.length ? fav.items : Array.isArray(fav?.favorites) ? fav.favorites : [];
			packPlan = planPack({ favorites: favItems, recent: rec?.items, mix: mix?.items, cached, sizes }, sizeMb * MB);
			if (!packPlan.count) {
				packState = "done";
				packResult = packPlan.candidates ? "Rien ne rentre dans ce pack : choisis une taille plus grande." : "Rien à préparer : tes favoris et tes écoutes récentes sont déjà hors-ligne.";
				exposePack();
				return;
			}
			packState = "running";
			packProgress = { ready: 0, failed: 0, refused: 0, total: packPlan.count };
			exposePack();
			// O10: a pack is an explicit "keep offline".
			void requestPersistentStorage();
			const plan = packPlan;
			void startKeepJob(PACK_KEY, () => plan.items.map((i) => i.item), {
				deps: (signal) =>
					keepDepsWithAbort(signal, {
						...defaultKeepDeps,
						download: async (t, o) => {
							const r = await defaultKeepDeps.download(t, o);
							if (r.ok) packDoneBytes += Number(r.bytes) || packSizeOf(t, sizes).bytes;
							return r;
						},
					}),
				onDone: (r: KeepResult) => {
					packState = r.cancelled ? "cancelled" : "done";
					packProgress = { ready: r.ready, failed: r.failed, refused: r.refused, total: r.total };
					const s = keepSummary(r);
					packResult = `${s.text} · ${fmtBytesFr(packDoneBytes)}`;
					notify(s.text, s.type);
					exposePack({ result: { ...r } });
					void refresh();
					dispatch("changed");
				},
			});
		} catch (e) {
			packState = "";
			error = `Impossible de préparer le pack : ${(e as Error)?.message ?? e}`;
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
			if (localStorage.getItem(SPACE_OPEN_KEY) === "0") open = false;
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
	{#if open}
		<div
			class="space-body"
			id="offline-space-body"
		>
		<div class="space-row">
			<label
				class="size-label"
				for="offline-space-size">Taille</label
			>
			<div class="select">
				<select
					id="offline-space-size"
					name="offline-space-size"
					data-testid="pack-size"
					aria-describedby="offline-space-desc"
					disabled={packRunning || !!busy || !!freePlan}
					bind:value={sizeMb}
				>
					{#each PACK_SIZES_MB as mb}
						<option value={mb}>{formatMoFr(mb)}</option>
					{/each}
				</select>
			</div>
			{#if !freePlan}
				<button
					type="button"
					id="offline-free-up"
					class="btn-reset btn-secondary"
					data-testid="free-up"
					aria-describedby="offline-space-desc"
					disabled={loading || !!busy || packRunning || cachedTracks === 0}
					title={cachedTracks === 0 && !loading ? "Rien en cache : rien à libérer" : "Retire les morceaux les moins écoutés, jamais les épinglés"}
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
					on:click={startPack}
				>
					{packState === "planning" ? "Préparation…" : labels.pack}
				</button>
			{/if}
		</div>
		<p
			class="space-desc"
			id="offline-space-desc"
		>
			Libérer retire les morceaux les moins écoutés jusqu'à {formatMoFr(sizeMb)} (les épinglés ne sont jamais touchés) ; un pack télécharge
			et épingle tes favoris, puis tes écoutes récentes, puis ta sélection, jusqu'à {formatMoFr(sizeMb)}.
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
				data-testid="pack-progress"
				data-state={packState}
				data-ready={packProgress?.ready ?? 0}
				data-total={packProgress?.total ?? packPlan?.count ?? 0}
				data-bytes={packDoneBytes}
				role="status"
				aria-live="polite"
			>
				<progress
					max={Math.max(1, packProgress?.total ?? packPlan?.count ?? 1)}
					value={packProgress?.ready ?? 0}
					aria-label="Progression du pack"
				/>
				<span id="offline-pack-text">{packText}</span>
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
	.pack-progress progress {
		width: 100%;
		height: 0.5rem;
		accent-color: $accent;
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
</style>
