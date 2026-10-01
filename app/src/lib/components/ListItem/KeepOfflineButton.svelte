<script lang="ts">
	// O8: "Garder hors-ligne" for a whole source (album, server playlist,
	// favourites). Labels: "Garder hors-ligne" → "9/14 prêts" (+ "Annuler")
	// → "Prêt hors-ligne". Engine: $lib/offlineBatch keepOffline().
	// I12: the batch runs in the module store `keepJobs` (keyed by source):
	// leaving the page does not cancel it, only "Annuler" does, and the
	// button shows the running batch again when the page is reopened.
	import { page } from "$app/stores";
	import { getOfflineTracks } from "$lib/offline";
	import { cancelKeepJob, findKeepJob, keepJobs, keepLabel, keepSummary, keepableTracks, startKeepJob, type KeepProgress } from "$lib/offlineBatch";
	import { notify } from "$lib/utils";

	/** Tracks of the source, or a loader (album pages resolve their queue lazily). */
	export let tracks: any[] = [];
	export let load: (() => Promise<any[]>) | null = null;
	/** Identity of the source (defaults to the page URL: one source button per page). */
	export let sourceKey: string | null = null;

	// $page (not `location`): a same-route navigation (release?id=A → B) reuses this component.
	$: key = sourceKey || ($page?.url ? $page.url.pathname + $page.url.search : "");
	// I13: a menu ⋮ batch of this album / playlist shows (and cancels) here too.
	$: job = key ? findKeepJob($keepJobs, key) : undefined;
	$: running = !!job;

	let progress: KeepProgress | null = null;

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

	$: if (job) progress = job.progress;
	$: if (!running) {
		const n = keepableTracks(tracks).length;
		progress = n && allPinned(tracks) ? { ready: n, failed: 0, refused: 0, total: n } : null;
	}
	$: label = keepLabel(progress, running);
	$: state = running ? "running" : progress && progress.total && progress.ready === progress.total ? "ready" : "idle";

	function start() {
		if (running || !key) return;
		const list = tracks;
		const loader = load;
		void startKeepJob(
			key,
			async () => (loader && !keepableTracks(list).length ? await loader().catch(() => []) : list),
			{
				onDone: (r) => {
					const s = keepSummary(r);
					notify(s.text, s.type);
				},
			},
		);
	}
	function cancel() {
		if (job) cancelKeepJob(job.key);
	}
</script>

<span class="keep-offline">
	<button
		type="button"
		class="keep-btn btn-reset btn-secondary"
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
			class="keep-btn cancel btn-reset btn-ghost"
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
	// Shape and colours come from the button system (.btn-secondary, "Annuler"
	// as .btn-ghost; global/redesign/modules/_button.scss). States only here.
	.keep-btn {
		&:disabled {
			// "9/14 prêts" is a progress label, not a disabled control.
			cursor: progress;
			opacity: 1;
		}
		&[data-state="ready"] {
			// Green is the state colour: "Prêt hors-ligne", border only.
			border-color: rgba(120, 220, 150, 0.6);
		}
	}
</style>
