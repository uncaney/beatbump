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
	import { onMount } from "svelte";
	import { get } from "svelte/store";
	import { goto } from "$app/navigation";
	import { APIClient } from "$lib/api";
	import { FIRST_PACK_HREF, FIRST_PACK_JOB_KEY, FIRST_PACK_KEY, firstPackSources, hasFirstPackMaterial, planFirstPack, shouldShowFirstPackCard } from "$lib/firstPack";
	import { getRecent } from "$lib/me";
	import { cachedIds, getOfflineTracks, listCachedAudio, requestPersistentStorage, storageStatus } from "$lib/offline";
	import { defaultKeepDeps, keepDepsWithAbort, keepSummary, startKeepJob, type KeepResult } from "$lib/offlineBatch";
	import { averageBytesPerSecond, guardPackSpace, lastPackOf, originRoom, writeLastPack, type PackPlan } from "$lib/offlinePack";
	import { durationOf } from "$lib/offlineQueue";
	import { notify } from "$lib/utils";

	let show = false;
	let busy = false;

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
		void (async () => {
			let stored: string | null = null;
			try {
				stored = storage()?.getItem(FIRST_PACK_KEY) ?? null;
			} catch {
				stored = null;
			}
			if (stored === "1") return;
			let recentCount = 0;
			try {
				// Shares PersonalRows' / FirstRun's me/stats/recent call (getRecent memo).
				const r = await getRecent(1);
				recentCount = Array.isArray(r?.items) ? r.items.length : 0;
			} catch {
				recentCount = 0; // anonymous profile or a failed call both read as "no history"
			}
			if (recentCount > 0) return;
			const sw = await swActive();
			if (alive) show = shouldShowFirstPackCard({ stored, recentCount, swActive: sw });
		})();
		return () => {
			alive = false;
		};
	});

	function dismiss() {
		remember();
		show = false;
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

	async function start() {
		if (busy) return;
		busy = true;
		try {
			const [src, l, st] = await Promise.all([
				firstPackSources(getJson),
				listCachedAudio().catch(() => null),
				storageStatus().catch(() => ({ persisted: null, usage: 0, quota: 0 })),
			]);
			if (!hasFirstPackMaterial(src)) {
				notify("Rien à emporter pour l'instant : la bibliothèque n'a pas encore d'album du jour.", "error");
				expose({ started: false, reason: "no_material" });
				dismiss();
				return;
			}
			const entries = l && Array.isArray(l.entries) ? l.entries : [];
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
			let plan: PackPlan = planFirstPack(src, cached, sizes);
			if (!plan.count) {
				notify(plan.candidates ? "Rien ne rentre dans 1 h pour l'instant." : "Tout est déjà hors-ligne : rien à emporter de plus.", "success");
				expose({ started: false, reason: "empty_plan", candidates: plan.candidates });
				dismiss();
				return;
			}
			// B7-8: measured against the room left before anything downloads; the
			// head that fits is taken on its own (day one: no dialog to answer).
			const quota = typeof l?.quota === "number" ? l.quota : 0;
			const pinnedBytes = Number(l?.pinnedBytes) || 0;
			const guard = guardPackSpace(plan, { quota, pinnedBytes, originFree: originRoom(st, entries) }, averageBytesPerSecond(entries, secs));
			if (!guard.fits) {
				if (!guard.shrunk.count) {
					notify(guard.message, "error");
					expose({ started: false, reason: "too_big", message: guard.message });
					return;
				}
				plan = guard.shrunk;
			}
			expose({ started: true, count: plan.count, seconds: plan.seconds, target: plan.target, items: plan.items.map((i) => i.videoId) });
			// O10: a pack is an explicit "keep offline"; the Espace card's "Rafraîchir mon pack" remembers it.
			void requestPersistentStorage();
			writeLastPack(storage(), lastPackOf(plan));
			const items = plan.items.map((i) => i.item);
			void startKeepJob(FIRST_PACK_JOB_KEY, () => items, {
				deps: (signal) => keepDepsWithAbort(signal, defaultKeepDeps),
				onDone: (r: KeepResult) => {
					const s = keepSummary(r);
					notify(s.text, s.type);
					expose({ result: { ...r } });
				},
			});
			remember();
			show = false;
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
