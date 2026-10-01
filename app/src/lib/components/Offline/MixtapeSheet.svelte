<script lang="ts">
	// Mixtape options (idea O3): bottom sheet on mobile, popover under the
	// Mixtape button on desktop. Pure preview over `tracks` (the READY offline
	// tracks) through $lib/offlineQueue.mixtape; playing dispatches the list so
	// the page starts it through the usual offline path (play -> toPlayableItems).
	//
	// Options persist in localStorage `ytm-mixtape-opts`; the seed is renewed by
	// "Nouvelle mixtape" so the same options give a new order.
	import Icon from "$components/Icon/Icon.svelte";
	import { formatDuration, mixtape, notPlayedSince, totalDuration } from "$lib/offlineQueue";
	import { createEventDispatcher, onMount, tick } from "svelte";

	/** Ready (really cached) offline tracks. */
	export let tracks: any[] = [];
	/**
	 * videoId -> last played (ms). `undefined` while being read, `null` when the
	 * device has no play history (option disabled with a hint).
	 */
	export let lastPlayed: Map<string, number> | null | undefined = undefined;

	const dispatch = createEventDispatcher<{ close: void; play: { items: any[] } }>();
	const STORAGE = "ytm-mixtape-opts";
	const DAY = 86_400_000;
	const DURATIONS: { min: number; label: string }[] = [
		{ min: 30, label: "30 min" },
		{ min: 60, label: "60 min" },
		{ min: 90, label: "90 min" },
		{ min: 0, label: "Toute la bibliothèque" },
	];

	let targetMin = 60;
	let noRepeat = true;
	let notRecent = false;
	let seed = newSeed();
	let sheet: HTMLDivElement;

	function newSeed() {
		return Math.floor(Math.random() * 0x7fffffff);
	}

	// Saved options are read at init (before the reactive `persist` below runs).
	try {
		const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE) : null;
		if (raw) {
			const o = JSON.parse(raw);
			if ([0, 30, 60, 90].includes(o.targetMin)) targetMin = o.targetMin;
			if (typeof o.noRepeat === "boolean") noRepeat = o.noRepeat;
			if (typeof o.notRecent === "boolean") notRecent = o.notRecent;
		}
	} catch {
		/* ignore */
	}

	onMount(() => {
		tick().then(() => sheet?.focus());
	});

	$: persist(targetMin, noRepeat, notRecent);
	function persist(t: number, r: boolean, n: boolean) {
		try {
			localStorage.setItem(STORAGE, JSON.stringify({ targetMin: t, noRepeat: r, notRecent: n }));
		} catch {
			/* ignore */
		}
	}

	$: historyState = lastPlayed === undefined ? "loading" : lastPlayed && lastPlayed.size ? "ok" : "none";
	$: historyOn = notRecent && historyState === "ok";
	$: eligible = historyOn ? notPlayedSince(tracks, lastPlayed as Map<string, number>, 30 * DAY) : tracks;
	$: mix = mixtape(tracks, {
		avoidSameArtistInARow: noRepeat,
		seed,
		targetSec: targetMin > 0 ? targetMin * 60 : undefined,
		lastPlayed: historyOn ? (lastPlayed as Map<string, number>) : undefined,
		notPlayedSinceMs: historyOn ? 30 * DAY : undefined,
	});
	$: count = mix.length;
	$: preview =
		count === 0
			? "Aucun morceau éligible avec ces réglages"
			: `${count} ${count > 1 ? "morceaux" : "morceau"} · ${formatDuration(totalDuration(mix))}`;
	$: shortOfTarget = targetMin > 0 && count > 0 && totalDuration(mix) < targetMin * 60 * 0.9;

	function close() {
		dispatch("close");
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.stopPropagation();
			close();
		}
	}
	function launch() {
		if (!count) return;
		dispatch("play", { items: mix });
	}
</script>

<svelte:window on:keydown={onKey} />

<div
	class="backdrop"
	on:click={close}
	role="presentation"
	aria-hidden="true"
/>
<div
	class="sheet"
	id="mixtape-sheet"
	role="dialog"
	aria-modal="true"
	aria-labelledby="mixtape-title"
	tabindex="-1"
	bind:this={sheet}
>
	<div class="grip" aria-hidden="true" />
	<div class="head">
		<h2 id="mixtape-title">Mixtape</h2>
		<button
			class="icon"
			id="mixtape-close"
			type="button"
			aria-label="Fermer"
			title="Fermer"
			on:click={close}
		>
			<Icon
				name="x"
				size="1.1em"
			/>
		</button>
	</div>

	<fieldset class="group">
		<legend>Durée</legend>
		<div
			class="seg"
			role="radiogroup"
			aria-label="Durée cible"
		>
			{#each DURATIONS as d (d.min)}
				<button
					type="button"
					id="mixtape-dur-{d.min}"
					class="chip"
					class:on={targetMin === d.min}
					role="radio"
					aria-checked={targetMin === d.min}
					on:click={() => (targetMin = d.min)}>{d.label}</button
				>
			{/each}
		</div>
	</fieldset>

	<label
		class="opt"
		for="mixtape-no-repeat"
	>
		<span class="text">Pas deux fois le même artiste de suite</span>
		<input
			id="mixtape-no-repeat"
			type="checkbox"
			bind:checked={noRepeat}
		/>
	</label>
	<label
		class="opt"
		class:disabled={historyState !== "ok"}
		for="mixtape-not-recent"
	>
		<span class="text">
			Pas écouté depuis 30 jours
			{#if historyState === "loading"}
				<small id="mixtape-recent-hint">Lecture de l'historique…</small>
			{:else if historyState === "none"}
				<small id="mixtape-recent-hint">Aucun historique d'écoute sur cet appareil</small>
			{:else if notRecent}
				<small id="mixtape-recent-hint"
					>{eligible.length} {eligible.length > 1 ? "morceaux éligibles" : "morceau éligible"} sur {tracks.length}</small
				>
			{/if}
		</span>
		<input
			id="mixtape-not-recent"
			type="checkbox"
			bind:checked={notRecent}
			disabled={historyState !== "ok"}
			aria-describedby={historyState !== "ok" || notRecent ? "mixtape-recent-hint" : undefined}
		/>
	</label>

	<p
		class="preview"
		id="mixtape-preview"
		class:none={count === 0}
		aria-live="polite"
	>
		{preview}{#if shortOfTarget}<span class="dot">·</span>plus court que prévu, la bibliothèque est petite{/if}
	</p>

	<div class="actions">
		<button
			class="cta"
			id="mixtape-reshuffle"
			type="button"
			title="Nouvelle mixtape : un autre ordre avec les mêmes réglages"
			on:click={() => (seed = newSeed())}
		>
			<Icon
				name="refresh"
				size="1em"
			/>
			Nouvelle mixtape
		</button>
		<button
			class="cta primary"
			id="mixtape-play"
			type="button"
			disabled={count === 0}
			aria-disabled={count === 0}
			on:click={launch}
		>
			<Icon
				name="play"
				size="1em"
				fill="currentColor"
			/>
			Lancer
		</button>
	</div>
</div>

<style lang="scss">
	$text: var(--color-dark, #fafafa);
	$muted: #b3b3b3;
	$accent: #1ed760;
	$surface: #1c1c1c;

	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		background: rgba(0, 0, 0, 0.55);
	}
	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 71;
		box-sizing: border-box;
		max-height: 85vh;
		overflow-y: auto;
		padding: 0.5rem 1rem calc(1rem + env(safe-area-inset-bottom, 0px));
		background: $surface;
		color: $text;
		border-radius: 1rem 1rem 0 0;
		box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.5);
		text-align: left;
		&:focus {
			outline: none;
		}
	}
	.grip {
		width: 2.5rem;
		height: 0.3rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.25);
		margin: 0.25rem auto 0.75rem;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
		h2 {
			margin: 0;
			font-size: 1.15rem;
		}
	}
	// Overrides of the global %button-base (dark text !important, capitalize…).
	.icon,
	.chip,
	.cta {
		font: inherit;
		font-size: 1rem;
		line-height: 1.2;
		text-transform: none;
		box-shadow: none !important;
		color: $text !important;
		cursor: pointer;
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
		}
	}
	.icon {
		width: 2.75rem;
		height: 2.75rem;
		min-width: 2.75rem;
		padding: 0;
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08) !important;
		border: 1px solid rgba(255, 255, 255, 0.15) !important;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.16) !important;
			border-color: rgba(255, 255, 255, 0.3) !important;
			color: $text !important;
		}
	}
	.group {
		border: 0;
		padding: 0;
		margin: 0 0 0.5rem;
		min-width: 0;
		legend {
			padding: 0;
			margin-bottom: 0.4rem;
			color: $muted;
			font-size: var(--text-secondary-size);
		}
	}
	.seg {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		min-height: 2.75rem;
		padding: 0 0.95rem;
		border-radius: 1.4rem;
		border: 1px solid transparent !important;
		background: rgba(255, 255, 255, 0.06) !important;
		color: #d4d4d4 !important;
		font-weight: 500;
		white-space: nowrap;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.12) !important;
			border-color: transparent !important;
			color: $text !important;
		}
		&.on,
		&.on:focus,
		&.on:active {
			background: rgba(30, 215, 96, 0.18) !important;
			border-color: rgba(30, 215, 96, 0.6) !important;
			color: $text !important;
			font-weight: 600;
		}
	}
	.opt {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		/* U12-9: undo the global small caps of _forms.scss (original Beatbump forms only). */
		font-variant-caps: normal;
		letter-spacing: normal;
		min-height: 2.75rem;
		padding: 0.35rem 0;
		cursor: pointer;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
		&.disabled {
			cursor: not-allowed;
			.text {
				color: $muted;
			}
		}
		.text {
			display: flex;
			flex-direction: column;
			gap: 0.1rem;
			min-width: 0;
		}
		small {
			color: $muted;
			font-size: var(--text-secondary-size);
		}
		input {
			flex: 0 0 auto;
			width: 1.4rem;
			height: 1.4rem;
			margin: 0;
			accent-color: $accent;
			cursor: inherit;
		}
	}
	.preview {
		margin: 0.5rem 0 0.75rem;
		font-size: var(--text-secondary-size);
		color: $muted;
		&.none {
			color: #e0a000;
		}
	}
	.dot {
		margin: 0 0.3em;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.cta {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		flex: 1 1 10rem;
		padding: 0.55rem 1rem;
		min-height: 2.75rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.18) !important;
		background: rgba(255, 255, 255, 0.08) !important;
		font-weight: 600;
		white-space: nowrap;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.16) !important;
			border-color: rgba(255, 255, 255, 0.3) !important;
			color: $text !important;
		}
		&.primary {
			background: $accent !important;
			border-color: $accent !important;
			color: #000 !important;
			&:hover,
			&:focus,
			&:focus-within,
			&:active {
				background: #22e668 !important;
				border-color: #22e668 !important;
				color: #000 !important;
			}
		}
		&:disabled {
			opacity: 0.6;
			cursor: not-allowed;
			background: rgba(255, 255, 255, 0.06) !important;
			border-color: rgba(255, 255, 255, 0.12) !important;
			color: $text !important;
		}
	}
	// Desktop: popover anchored under the Mixtape button (the page wraps the
	// button and this component in a `position: relative` container).
	@media (min-width: 641px) {
		.backdrop {
			background: transparent;
		}
		.sheet {
			position: absolute;
			left: 0;
			right: auto;
			bottom: auto;
			top: calc(100% + 0.5rem);
			width: 24rem;
			max-width: calc(100vw - 2rem);
			max-height: none;
			border-radius: 0.9rem;
			border: 1px solid rgba(255, 255, 255, 0.14);
			box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
			padding-top: 0.75rem;
		}
		.grip {
			display: none;
		}
	}
</style>
