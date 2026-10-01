<script lang="ts">
	// O8: "Garder hors-ligne" for a whole source (album, server playlist,
	// favourites). Labels: "Garder hors-ligne" → "9/14 prêts" (+ "Annuler")
	// → "Prêt hors-ligne". Engine: $lib/offlineBatch keepOffline().
	// I12: the batch runs in the module store `keepJobs` (keyed by source):
	// leaving the page does not cancel it, only "Annuler" does, and the
	// button shows the running batch again when the page is reopened.
	// UX2 (cycle 35): `compact` renders a 44px corner .icon-btn (pin
	// pictogram since U12-3, "9/14" while running, green when ready) for dense grids such
	// as the Mixes cards; same testid / data-state / data-ready / data-total.
	import { page } from "$app/stores";
	import Icon from "$components/Icon/Icon.svelte";
	import { getOfflineTracks } from "$lib/offline";
	import { cancelKeepJob, compactKeepAriaLabel, findKeepJob, keepJobs, keepLabel, keepSummary, keepableTracks, startKeepJob, type KeepProgress } from "$lib/offlineBatch";
	import { notify } from "$lib/utils";

	/** Tracks of the source, or a loader (album pages resolve their queue lazily). */
	export let tracks: any[] = [];
	export let load: (() => Promise<any[]>) | null = null;
	/** Identity of the source (defaults to the page URL: one source button per page). */
	export let sourceKey: string | null = null;
	/** data-testid of the button (HL6: "mix-keep" on a mix card). */
	export let testid = "keep-offline";
	/** UX2: icon-only variant (aria-label = state + card title, L10-13). */
	export let compact = false;
	/**
	 * UX7: album action row. A pin icon before the label (U12-3: the download
	 * arrow is reserved for "Télécharger sur l'appareil"); on phones the idle /
	 * ready label folds to a short "Garder" / "Gardé" next to the icon
	 * (aria-label keeps the full words), the running "9/14 prêts" stays written.
	 */
	export let responsive = false;
	/** L10-13: title of the card a compact button belongs to (part of its accessible name). */
	export let cardTitle = "";

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
	$: shortLabel = state === "ready" ? "Gardé" : "Garder";

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

{#if compact}
	<span class="keep-offline compact">
		<button
			type="button"
			class="keep-icon icon-btn"
			data-testid={testid}
			data-state={state}
			data-ready={progress ? progress.ready : 0}
			data-total={progress ? progress.total : 0}
			aria-label={compactKeepAriaLabel(label, cardTitle)}
			title={label}
			disabled={running}
			on:click|stopPropagation={start}
		>
			{#if running && progress && progress.total}
				<span
					class="keep-count"
					aria-live="polite">{progress.ready}/{progress.total}</span
				>
			{:else}
				<Icon
					name="pin"
					size="1.25em"
				/>
			{/if}
		</button>
		{#if running}
			<button
				type="button"
				class="keep-icon icon-btn"
				data-testid="keep-offline-cancel"
				aria-label={compactKeepAriaLabel("Annuler", cardTitle)}
				title="Annuler"
				on:click|stopPropagation={cancel}
			>
				<Icon
					name="x"
					size="1.1em"
				/>
			</button>
		{/if}
	</span>
{:else}
<span class="keep-offline">
	<button
		type="button"
		class="keep-btn btn-reset btn-secondary"
		class:responsive
		class:show-label={running}
		aria-label={responsive ? label : undefined}
		data-testid={testid}
		data-state={state}
		data-ready={progress ? progress.ready : 0}
		data-total={progress ? progress.total : 0}
		title={progress && progress.total ? `${progress.ready}/${progress.total} prêts` : "Télécharger et épingler pour l'écoute sans connexion"}
		aria-live="polite"
		disabled={running}
		on:click|stopPropagation={start}
		>{#if responsive}<Icon
				name="pin"
				size="1.1em"
			/><span class="keep-lbl">{label}</span><span
				class="keep-short"
				aria-hidden="true">{shortLabel}</span
			>{:else}{label}{/if}</button
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
{/if}

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
		.keep-short {
			display: none;
		}
		@media only screen and (max-width: 719px) {
			&.responsive:not(.show-label) {
				min-width: max(2.75rem, 44px);
				padding-inline: 0.75rem;
				gap: 0.3rem;
				.keep-lbl {
					display: none;
				}
				.keep-short {
					display: inline;
				}
			}
		}
		&[data-state="ready"] {
			// Green is the state colour: "Prêt hors-ligne", border only.
			border-color: rgba(120, 220, 150, 0.6);
		}
	}
	.compact {
		gap: 0;
		flex-wrap: nowrap;
	}
	// Round, translucent so it reads over a card; 44px from .icon-btn.
	.keep-icon {
		border-radius: 50%;
		background-color: hsl(0deg 0% 0% / 35%);
		&:hover {
			background-color: hsl(0deg 0% 0% / 55%);
		}
		&:disabled {
			cursor: progress;
		}
		&[data-state="ready"] {
			color: rgb(120, 220, 150);
		}
	}
	.keep-count {
		font-size: 0.75rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
</style>
