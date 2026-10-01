<script lang="ts">
	// Settings > Offline: auto-cache switch (settings.offline.autoCache), cached
	// audio summary, quota selector, clear cache (with confirmation) and re-sync.
	// Talks to the service worker only through the helpers of $lib/offline.
	import { onMount, tick } from "svelte";
	import { settings } from "$stores/settings";
	import {
		applySwEviction,
		cachedIds,
		getOfflineTracks,
		listCachedAudio,
		reconcileOfflineList,
		removeOffline,
		requestPersistentStorage,
		scheduleSwAudioRefresh,
		setAudioQuota,
		storageStatus,
		swRequest,
		type AudioListEntry,
	} from "$lib/offline";
	import { freeUpSummary, planFreeUp, type FreeUpPlan } from "$lib/offlineFreeUp";
	import { PACK_SIZES_MB, packLabel, packSizeOf, planPack, type PackPlan } from "$lib/offlinePack";
	import { cancelKeepJob, defaultKeepDeps, keepDepsWithAbort, keepJobs, keepSummary, startKeepJob, type KeepProgress, type KeepResult } from "$lib/offlineBatch";
	import { getFavorites, getMix, getRecent } from "$lib/me";
	import { notify } from "$lib/utils";
	import { currentTrack } from "$lib/stores/list";
	import { get } from "svelte/store";

	const MB = 1024 * 1024;
	const GB = 1024 * MB;
	const QUOTA_OPTIONS: { label: string; bytes: number }[] = [
		{ label: "500 MB", bytes: 500 * MB },
		{ label: "1 Go", bytes: 1 * GB },
		{ label: "2 Go", bytes: 2 * GB },
		{ label: "5 Go", bytes: 5 * GB },
		{ label: "Unlimited", bytes: 0 },
	];
	const SW_UNAVAILABLE =
		"Offline cache unavailable: the service worker did not answer (first visit, private window, or reload needed).";

	let loading = true;
	let error = "";
	let message = "";
	let busy: "" | "quota" | "clear" | "resync" | "freeup" = "";
	let entries: AudioListEntry[] = [];
	let total = 0;
	// Bytes held by pinned entries (never evicted, G7): the quota cannot go below.
	let pinnedBytes = 0;
	let quota = 0; // <= 0 = unlimited
	let quotaValue = 2 * GB;
	let confirmClear = false;
	let localCount = 0; // tracks in the local offline list (localStorage)
	let confirmButton: HTMLButtonElement | null = null;
	let clearButton: HTMLButtonElement | null = null;

	$: customQuota = quota > 0 && !QUOTA_OPTIONS.some((o) => o.bytes === quota);
	$: cachedTracks = entries.length;
	// The status line shows "0 tracks": nothing to re-sync. Not when the SW
	// did not answer ("Unknown"): Re-sync stays available as a retry.
	$: nothingCached = !loading && !(error && !entries.length) && cachedTracks === 0;

	// French units (audit v7 item 10): "2 Mo utilisés sur 11 Go", like the
	// Hors-ligne page ("56 Mo"); decimal comma for the fractional Go.
	function fmtBytes(bytes: number): string {
		if (!(bytes > 0)) return "0 Mo";
		if (bytes >= GB) {
			const go = (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1).replace(".", ",");
			return `${go} Go`;
		}
		return `${Math.max(1, Math.round(bytes / MB))} Mo`;
	}
	function fmtQuota(q: number): string {
		return q > 0 ? fmtBytes(q) : "illimité";
	}

	// O10: persistent storage (navigator.storage.persist) + estimate().
	let persisted: boolean | null = null;
	let usage = 0;
	let storageQuota = 0;
	let persistBusy = false;
	async function refreshStorage() {
		const s = await storageStatus();
		persisted = s.persisted;
		usage = s.usage;
		storageQuota = s.quota;
	}
	async function askPersist() {
		if (persistBusy) return;
		persistBusy = true;
		try {
			const r = await requestPersistentStorage(true);
			await refreshStorage();
			if (r === false) notify("Le navigateur a refusé : installe l'app sur l'écran d'accueil puis réessaie", "error");
		} finally {
			persistBusy = false;
		}
	}

	async function refresh() {
		void refreshStorage();
		loading = true;
		error = "";
		try {
			localCount = getOfflineTracks().length;
			const r = await listCachedAudio();
			if (!r || !Array.isArray(r.entries)) {
				error = SW_UNAVAILABLE;
			} else {
				entries = r.entries;
				total = r.total || 0;
				pinnedBytes = Number(r.pinnedBytes) || 0;
				quota = typeof r.quota === "number" ? r.quota : 0;
				quotaValue = quota > 0 ? quota : 0;
			}
		} catch (e) {
			error = `Could not read the offline cache: ${(e as Error)?.message ?? e}`;
		} finally {
			loading = false;
		}
	}

	async function onQuotaChange() {
		if (busy) return;
		busy = "quota";
		error = "";
		message = "";
		try {
			const requested = Number(quotaValue);
			// Pinned entries are never evicted (G7): a quota below their total
			// could never be met. Re-read the pinned total, then refuse.
			const l = await listCachedAudio().catch(() => null);
			if (l && Array.isArray(l.entries)) pinnedBytes = Number(l.pinnedBytes) || 0;
			if (requested > 0 && pinnedBytes > requested) {
				const msg = `Les morceaux épinglés occupent déjà ${fmtBytes(pinnedBytes)}`;
				notify(`${msg} : choisis une limite plus haute ou désépingle des morceaux.`, "error");
				error = `${msg}, la limite reste à ${fmtQuota(quota)}.`;
				quotaValue = quota > 0 ? quota : 0;
				return;
			}
			const r = await setAudioQuota(requested);
			if (!r) {
				error = SW_UNAVAILABLE;
			} else {
				quota = typeof r.quota === "number" ? r.quota : Number(quotaValue);
				message = `Offline quota set to ${fmtQuota(quota)}.`;
				await refresh();
			}
		} catch (e) {
			error = `Could not change the quota: ${(e as Error)?.message ?? e}`;
		} finally {
			busy = "";
		}
	}

	async function askClear() {
		confirmClear = true;
		await tick();
		confirmButton?.focus();
	}
	async function cancelClear() {
		confirmClear = false;
		await tick();
		clearButton?.focus();
	}
	async function doClear() {
		if (busy) return;
		busy = "clear";
		error = "";
		message = "";
		try {
			// 1. Local list (localStorage) + uncache request for each listed track.
			const local = getOfflineTracks();
			for (const t of local) removeOffline(t);
			// 2. Entries the SW still holds (also covers tracks missing from the list).
			//    Sequential so each "audio-uncached" ack matches its request.
			let failed = 0;
			for (const e of entries) {
				const r = await swRequest<{ type: "audio-uncached"; ok: boolean }>(
					{ type: "uncache-audio", url: e.url || "", videoId: e.videoId || "" },
					"audio-uncached",
					5_000,
				);
				if (!r || !r.ok) failed++;
			}
			await reconcileOfflineList().catch(() => null);
			await refresh();
			message = failed
				? `Offline cache cleared, ${failed} entr${failed === 1 ? "y" : "ies"} could not be removed.`
				: "Offline cache cleared.";
		} catch (e) {
			error = `Could not clear the offline cache: ${(e as Error)?.message ?? e}`;
		} finally {
			busy = "";
			confirmClear = false;
			await tick();
			clearButton?.focus();
		}
	}

	// HL2 "Libérer de l'espace": plan (planFreeUp, LRU, pinned never touched),
	// show count + Mo, apply on confirm (uncache-audio per entry, sequential so
	// each ack matches, then applySwEviction so `cachedIds` / badges follow at
	// once) and show the new total. The plan (then the outcome) is exposed in
	// window.__ytmFreeUpPlan for the browser harness.
	const FREE_UP_TARGET = 500 * MB;
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
		message = "";
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
			freePlan = planFreeUp(entries, FREE_UP_TARGET, { protect: playing ? [playing] : [] });
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
		message = "";
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
			freeResult = `${freeUpSummary({ count: removed.length, bytes: freed })} libéré${removed.length > 1 ? "s" : ""}${failed ? ` · ${failed} impossible${failed > 1 ? "s" : ""}` : ""} · ${fmtBytes(total)} restants`;
			exposePlan({ applied: true, removed: removed.length, failed, freedBytes: freed, totalAfter: total });
			notify(freeResult, failed ? "error" : "success");
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
	const PACK_KEY = "pack:settings";
	function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
		return p.catch(() => fallback);
	}
	let packSizeMb: (typeof PACK_SIZES_MB)[number] = 100;
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
	$: packTarget = packPlan ? packPlan.target : packSizeMb * MB;
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
			packPlan = planPack({ favorites: favItems, recent: rec?.items, mix: mix?.items, cached, sizes }, packSizeMb * MB);
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
					packResult = `${s.text} · ${fmtBytes(packDoneBytes)}`;
					notify(s.text, s.type);
					exposePack({ result: { ...r } });
					void refresh();
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

	async function doResync() {
		if (busy) return;
		busy = "resync";
		error = "";
		message = "";
		try {
			const l = await reconcileOfflineList();
			if (l === null) {
				error = SW_UNAVAILABLE;
			} else {
				await refresh();
				message = `Offline list re-synced: ${l.length} morceau${l.length > 1 ? "x" : ""} listed.`;
			}
		} catch (e) {
			error = `Could not re-sync the offline list: ${(e as Error)?.message ?? e}`;
		} finally {
			busy = "";
		}
	}

	onMount(() => {
		void refresh();
	});
</script>

<section
	id="settings-offline"
	aria-labelledby="offline-heading"
	aria-busy={loading || !!busy}
>
	<span
		class="h5"
		id="offline-heading">Offline</span
	>

	<div class="setting">
		<label
			for="offline-autocache"
			id="offline-autocache-label"
		>
			Save every played track for offline
			<span id="offline-autocache-desc"
				>Tracks you play are kept on this device so they play without a
				connection, within the quota below.</span
			>
		</label>
		<span class="switch-wrap">
			<input
				type="checkbox"
				role="switch"
				id="offline-autocache"
				name="offline-autocache"
				class="sr-only"
				aria-describedby="offline-autocache-desc"
				bind:checked={$settings.offline.autoCache}
			/>
			<label
				for="offline-autocache"
				class="switch"
				aria-hidden="true"
			/>
		</span>
	</div>

	<div class="setting">
		<!-- svelte-ignore a11y-label-has-associated-control -->
		<label id="offline-cache-label">
			Cached audio
			<span
				id="offline-cache-status"
				aria-live="polite"
			>
				{#if loading}
					Loading…
				{:else if error && !entries.length}
					Unknown
				{:else}
					<!-- Audit v8 TOP 9: same words and units as the Hors-ligne page
					     ("4 morceaux · 40 Mo"): morceau / Mo / Go / sur. -->
					{cachedTracks} morceau{cachedTracks > 1 ? "x" : ""} · {fmtBytes(total)} sur {fmtQuota(
						quota,
					)}{#if pinnedBytes > 0}<span id="offline-pinned">, dont {fmtBytes(pinnedBytes)} épinglés</span>{/if}
				{/if}
			</span>
		</label>
		<span
			id="offline-resync-desc"
			class="sr-only"
			>Rebuilds the offline track list from what is really cached on this
			device.</span
		>
		<!-- Disabled while the status shows "0 tracks": there is nothing to
		     re-sync (audit v3 TOP 10 #10); the title says why. -->
		<button
			type="button"
			id="offline-resync"
			class="btn-reset btn"
			aria-describedby="offline-resync-desc"
			disabled={loading || !!busy || nothingCached}
			title={nothingCached
				? "Aucune piste en cache : rien à resynchroniser"
				: "Reconstruit la liste hors-ligne à partir du cache de cet appareil"}
			on:click={doResync}
		>
			{busy === "resync" ? "Re-syncing…" : "Re-sync list"}
		</button>
	</div>

	<div class="setting">
		<!-- svelte-ignore a11y-label-has-associated-control -->
		<label id="offline-storage-label">
			Stockage de l'appareil
			<span
				id="offline-persisted"
				data-persisted={persisted === null ? "unknown" : String(persisted)}
				>Stockage protégé : {persisted === null ? "inconnu" : persisted ? "oui" : "non"}{#if usage > 0}<span
						id="offline-storage-usage"
						>{" · "}{fmtBytes(usage)} utilisés{#if storageQuota > 0}{" sur "}{fmtBytes(storageQuota)}{/if}</span
					>{/if}</span
			>
		</label>
		{#if persisted === false}
			<button
				type="button"
				id="offline-persist-request"
				class="btn-reset btn"
				disabled={persistBusy}
				title="Demande au navigateur de ne jamais effacer le hors-ligne de cet appareil"
				on:click={askPersist}>Protéger</button
			>
		{/if}
	</div>

	<div class="setting">
		<label for="offline-quota">
			Offline storage limit
			<span id="offline-quota-desc"
				>Oldest tracks are removed first once the limit is reached.</span
			>
		</label>
		<div class="select">
			<select
				id="offline-quota"
				name="offline-quota"
				aria-describedby="offline-quota-desc"
				disabled={loading || !!busy || (!!error && !entries.length)}
				bind:value={quotaValue}
				on:change={onQuotaChange}
			>
				{#if customQuota}
					<option value={quota}>Custom ({fmtBytes(quota)})</option>
				{/if}
				{#each QUOTA_OPTIONS as opt}
					<option value={opt.bytes}>{opt.label}</option>
				{/each}
			</select>
		</div>
	</div>

	<!-- HL2: smart free-up, least recently played first, pinned never touched. -->
	<div class="setting">
		<label
			for="offline-free-up"
			id="offline-free-up-label"
		>
			Libérer de l'espace
			<span id="offline-free-up-desc"
				>Retire les morceaux les moins écoutés jusqu'à 500 Mo. Les morceaux
				épinglés ne sont jamais touchés.</span
			>
			{#if freeResult}
				<span
					id="offline-free-up-result"
					data-testid="free-up-result"
					aria-live="polite">{freeResult}</span
				>
			{/if}
		</label>
		{#if !freePlan}
			<button
				type="button"
				id="offline-free-up"
				class="btn btn-secondary"
				data-testid="free-up"
				aria-describedby="offline-free-up-desc"
				disabled={loading || !!busy || cachedTracks === 0}
				bind:this={freeUpButton}
				on:click={askFreeUp}
			>
				{busy === "freeup" ? "Calcul…" : "Libérer 500 Mo"}
			</button>
		{:else}
			<div
				class="confirm neutral"
				role="group"
				aria-labelledby="offline-free-up-plan"
			>
				<span
					id="offline-free-up-plan"
					data-testid="free-up-plan"
					data-count={freePlan.count}
					data-bytes={freePlan.bytes}
					>{#if freePlan.count}{freeUpSummary(freePlan)} seront libérés{#if !freePlan.reached}
							(moins que 500 Mo : le reste est épinglé ou en lecture){/if}.{:else}Rien à libérer : tout
						est épinglé ou en lecture.{/if}</span
				>
				<div class="confirm-actions">
					{#if freePlan.count}
						<button
							type="button"
							id="offline-free-up-confirm"
							class="btn btn-secondary danger"
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
						class="btn btn-secondary"
						data-testid="free-up-cancel"
						disabled={!!busy}
						on:click={cancelFreeUp}
					>
						{freePlan.count ? "Annuler" : "Fermer"}
					</button>
				</div>
			</div>
		{/if}
	</div>

	<!-- HL3: sized offline pack (favourites, recent plays, mix), pinned. -->
	<div class="setting">
		<label
			for="offline-pack-size"
			id="offline-pack-label"
		>
			Préparer un pack hors-ligne
			<span id="offline-pack-desc"
				>Télécharge et épingle tes favoris, puis tes écoutes récentes, puis ta
				sélection, jusqu'à la taille choisie.</span
			>
		</label>
		<div class="pack-controls">
			<div class="select">
				<select
					id="offline-pack-size"
					name="offline-pack-size"
					data-testid="pack-size"
					aria-describedby="offline-pack-desc"
					disabled={packRunning}
					bind:value={packSizeMb}
				>
					{#each PACK_SIZES_MB as mb}
						<option value={mb}>{mb} Mo</option>
					{/each}
				</select>
			</div>
			{#if packState === "running"}
				<button
					type="button"
					id="offline-pack-cancel"
					class="btn btn-secondary danger"
					data-testid="pack-cancel"
					on:click={cancelPack}
				>
					Annuler
				</button>
			{:else}
				<button
					type="button"
					id="offline-pack-start"
					class="btn btn-secondary"
					data-testid="pack-start"
					aria-describedby="offline-pack-desc"
					disabled={loading || !!busy || packRunning}
					on:click={startPack}
				>
					{packState === "planning" ? "Préparation…" : "Préparer"}
				</button>
			{/if}
		</div>
	</div>
	{#if packState}
		<div
			class="confirm neutral pack-progress"
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

	<div class="setting">
		<label
			for="offline-clear"
			id="offline-clear-label"
		>
			Clear offline cache
			<span id="offline-clear-desc"
				>Removes every cached track from this device. Your playlists and
				favorites are kept.</span
			>
		</label>
		{#if !confirmClear}
			<button
				type="button"
				id="offline-clear"
				class="btn-reset btn danger"
				aria-describedby="offline-clear-desc"
				disabled={loading || !!busy || (cachedTracks === 0 && localCount === 0)}
				bind:this={clearButton}
				on:click={askClear}
			>
				Clear offline cache
			</button>
		{:else}
			<div
				class="confirm"
				role="group"
				aria-labelledby="offline-clear-confirm-text"
			>
				<span id="offline-clear-confirm-text"
					>Delete {cachedTracks} cached morceau{cachedTracks > 1 ? "x" : ""} ({fmtBytes(
						total,
					)})? This cannot be undone.</span
				>
				<div class="confirm-actions">
					<button
						type="button"
						id="offline-clear-confirm"
						class="btn-reset btn danger"
						disabled={!!busy}
						bind:this={confirmButton}
						on:click={doClear}
					>
						{busy === "clear" ? "Clearing…" : "Yes, delete"}
					</button>
					<button
						type="button"
						id="offline-clear-cancel"
						class="btn-reset btn"
						disabled={!!busy}
						on:click={cancelClear}
					>
						Cancel
					</button>
				</div>
			</div>
		{/if}
	</div>

	{#if error}
		<p
			id="offline-error"
			class="feedback error"
			role="alert"
		>
			{error}
			<button
				type="button"
				id="offline-retry"
				class="btn-reset btn"
				disabled={loading || !!busy}
				on:click={refresh}>Retry</button
			>
		</p>
	{/if}
	<p
		id="offline-message"
		class="feedback"
		class:hidden={!message}
		aria-live="polite"
	>
		{message}
	</p>
</section>

<style lang="scss">
	section {
		display: flex;
		flex-direction: column;
		margin-block-end: 1em;
		border-bottom: 0.01em solid rgb(218 218 218 / 8.2%);
	}

	.setting {
		display: inline-flex;
		color: inherit;
		vertical-align: top;
		gap: 1em;
		flex-direction: column;
		margin-block: 1em;

		&:first-of-type {
			margin-block-start: 0;
		}

		@media screen and (min-width: 40em) {
			align-items: center;
			flex-direction: row;

			> :last-child:not(label) {
				margin-left: auto;
			}
		}
	}

	label {
		display: inline-flex;
		flex-direction: column;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
			Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue",
			sans-serif;
		font-size: 1em;
		text-transform: none !important;
		font-variant: unset;
		gap: 0.125em;
		line-height: 1.4;

		> span {
			font-size: 0.875em;
			color: hsla(0, 0%, 100%, 0.7);
			line-height: 1.2;
		}
	}

	/* "Stockage protégé : non · 2 Mo utilisés sur 10 Go" on one line beside
	   the Protéger button (audit v8 TOP 9). */
	@media screen and (min-width: 40em) {
		#offline-persisted,
		#offline-storage-usage {
			white-space: nowrap;
		}
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* Switch: the checkbox stays focusable (visually hidden, not display:none). */
	.switch-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-height: max(2.75rem, 44px); /* 44px hit area, px floor (mobile root font 12px) */
		flex-shrink: 0;
	}

	.switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		width: 3.8125em;
		height: 2em;
		cursor: pointer;
		background-color: rgb(109 109 109 / 35%);
		border-radius: 1.25rem;
		transition: background-color 0.3s;

		&::before {
			/* extend the pointer target to the 44px wrapper */
			content: "";
			position: absolute;
			inset: -0.375rem -0.25rem;
		}
	}

	.switch::after {
		--size: calc(2rem - (2px * 2));

		content: "";
		position: absolute;
		width: var(--size);
		height: var(--size);
		border-radius: 9999em;
		background-color: white;
		top: 50%;
		transform: translateY(-50%);
		left: 0.125em;
		transition: left 0.3s;
		box-shadow: 0 0 12px -3px rgb(0 0 0 / 38.4%);
	}

	[type="checkbox"]:checked + .switch::after {
		left: 2em;
	}

	[type="checkbox"]:checked + .switch {
		background-color: #00cd6a;
	}

	[type="checkbox"]:focus-visible + .switch {
		outline: 2px solid #fff;
		outline-offset: 3px;
	}

	.btn {
		all: unset;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* 44px with a px floor: the mobile root font is 12px, so 2.75rem alone
		   gave 33px tall buttons / selects (audit v4 TOP 3). */
		min-height: max(2.75rem, 44px);
		min-width: max(2.75rem, 44px);
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		font: inherit;
		font-weight: 500;
		/* The global %button-base forces `color: #0f0f0f !important`, which made
		   "Re-sync list" 1.11:1 on this translucent background (audit 1.10).
		   #f2f2f2 on rgb(255 255 255 / 10%) over #121212 (= #2a2a2a) = 11.7:1. */
		color: #f2f2f2 !important;
		background: rgb(255 255 255 / 10%);
		cursor: pointer;
		transition: background-color 0.15s;

		&:hover:not(:disabled) {
			background: rgb(255 255 255 / 18%);
			color: #fff !important;
		}
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
		/* Disabled: inherit the shared readable style (global _button.scss):
		   #9a9a9a on #2c2c2c = 4.96:1, no opacity stacking. */
		&:disabled {
			opacity: 1;
			color: #9a9a9a !important;
			background: rgb(44, 44, 44) !important;
			border: 1px solid rgba(255, 255, 255, 0.25);
			cursor: not-allowed;
		}
		&.danger {
			background: rgb(220 53 69 / 25%);
			&:hover:not(:disabled) {
				background: rgb(220 53 69 / 45%);
			}
		}
	}

	.select select {
		min-height: max(2.75rem, 44px);
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}

	.confirm {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: 0.5rem;
		background: rgb(220 53 69 / 12%);
		border: 1px solid rgb(220 53 69 / 45%);
		font-size: 0.9375em;
		line-height: 1.3;

		/* HL2 free-up plan / HL3 pack progress: informative, not destructive. */
		&.neutral {
			background: rgb(255 255 255 / 6%);
			border-color: rgb(255 255 255 / 25%);
		}
	}
	.confirm-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	/* HL3 pack: size select + Préparer / Annuler side by side; the progress
	   block spans the section below the row. */
	.pack-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.pack-progress {
		margin-block: 0 1em;
		progress {
			width: 100%;
			height: 0.5rem;
			accent-color: #00cd6a;
		}
	}

	.feedback {
		margin: 0 0 1em;
		font-size: 0.9375em;
		line-height: 1.4;
		color: hsla(0, 0%, 100%, 0.85);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;

		&.error {
			color: #ffb3b3;
		}
		&.hidden {
			display: none;
		}
	}
</style>
