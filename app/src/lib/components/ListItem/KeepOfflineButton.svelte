<script lang="ts">
	// O8: "Garder hors-ligne" for a whole source (album, server playlist,
	// favourites). Labels: "Garder hors-ligne" → "9/14 prêts" (+ "Annuler")
	// → "Prêt hors-ligne". Engine: $lib/offlineBatch keepOffline().
	import { getOfflineTracks } from "$lib/offline";
	import { keepLabel, keepOffline, keepSummary, keepableTracks, type KeepProgress } from "$lib/offlineBatch";
	import { notify } from "$lib/utils";
	import { onDestroy } from "svelte";

	/** Tracks of the source, or a loader (album pages resolve their queue lazily). */
	export let tracks: any[] = [];
	export let load: (() => Promise<any[]>) | null = null;

	let running = false;
	let progress: KeepProgress | null = null;
	let ctrl: AbortController | null = null;

	function allPinned(list: any[]): boolean {
		const ks = keepableTracks(list);
		if (!ks.length) return false;
		try {
			const pinned = new Set(getOfflineTracks().filter((t) => t._pinned === true && t._cached === true).map((t) => t.videoId));
			return ks.every((t) => pinned.has(t.videoId));
		} catch {
			return false;
		}
	}

	$: if (!running) {
		const n = keepableTracks(tracks).length;
		progress = n && allPinned(tracks) ? { ready: n, failed: 0, refused: 0, total: n } : null;
	}
	$: label = keepLabel(progress, running);
	$: state = running ? "running" : progress && progress.total && progress.ready === progress.total ? "ready" : "idle";

	async function start() {
		if (running) return;
		running = true;
		ctrl = new AbortController();
		try {
			let list = tracks;
			if (load && !keepableTracks(list).length) list = await load().catch(() => []);
			const ks = keepableTracks(list);
			progress = { ready: 0, failed: 0, refused: 0, total: ks.length };
			const r = await keepOffline(ks, { signal: ctrl.signal, onProgress: (p) => (progress = p) });
			progress = r;
			const s = keepSummary(r);
			notify(s.text, s.type);
		} finally {
			running = false;
			ctrl = null;
		}
	}
	function cancel() {
		ctrl?.abort();
	}
	onDestroy(() => ctrl?.abort());
</script>

<span class="keep-offline">
	<button
		type="button"
		class="keep-btn"
		data-testid="keep-offline"
		data-state={state}
		data-ready={progress ? progress.ready : 0}
		data-total={progress ? progress.total : 0}
		title={progress && progress.total ? `${progress.ready}/${progress.total} prêts` : "Télécharger et épingler pour l'écoute sans connexion"}
		aria-live="polite"
		disabled={running}
		on:click|stopPropagation={start}>{label}</button
	>
	{#if running}
		<button
			type="button"
			class="keep-btn cancel"
			data-testid="keep-offline-cancel"
			on:click|stopPropagation={cancel}>Annuler</button
		>
	{/if}
</span>

<style lang="scss">
	.keep-offline {
		display: inline-flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.keep-btn {
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 2rem;
		color: inherit;
		padding: 0.45rem 1rem;
		min-height: 44px;
		cursor: pointer;
		font: inherit;
		&:disabled {
			cursor: progress;
			opacity: 1;
		}
		&[data-state="ready"] {
			border-color: rgba(120, 220, 150, 0.6);
		}
		&.cancel {
			background: transparent;
		}
	}
</style>
