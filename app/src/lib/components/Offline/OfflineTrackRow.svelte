<script lang="ts">
	// One cached track. Click = play (event "play"), ✕ = remove (event "remove";
	// a pinned track asks for an inline confirmation first, G20), pin (event
	// "pin"), "Retélécharger" on an evicted entry (event "recache").
	// Deliberately not Item/Listing: its click path calls the network mix API,
	// while this row must start playback from the cached copy only.
	// States: ready (default), pending (`_cached === false`, download in flight)
	// and evicted (`_evicted`, F5/G8: the SW dropped the entry, re-downloadable).
	import Icon from "$components/Icon/Icon.svelte";
	import { artistName, thumbnailOf } from "$lib/offlineQueue";
	import { createEventDispatcher, tick } from "svelte";

	export let track: any;
	export let active = false;
	export let number: number | undefined = undefined;
	export let showArtist = true;
	/** H6: "Retélécharger" needs the network; disabled while offline. */
	export let online = true;

	const dispatch = createEventDispatcher<{ play: any; remove: any; pin: any; recache: any }>();

	$: thumb = thumbnailOf(track);
	$: artist = artistName(track);
	$: length = (track?.length && (track.length.text || track.length)) || "";
	$: evicted = track?._evicted === true;
	$: pending = track?._cached === false && !evicted;
	$: title = track?.title || track?.videoId;
	let imgBroken = false;

	// Removing a pinned track asks for an inline confirmation (G20), same
	// pattern as Settings > Offline "Clear offline cache": the ✕ turns into a
	// "Retirer ? Oui / Annuler" group, focus moves to the confirm button and
	// back to the ✕ on cancel. Unpinned tracks are removed at once (re-cached
	// on the next play anyway).
	let confirmRemove = false;
	let removeButton: HTMLButtonElement | null = null;
	let confirmButton: HTMLButtonElement | null = null;
	async function askRemove() {
		if (!track?._pinned) return dispatch("remove", track);
		confirmRemove = true;
		await tick();
		confirmButton?.focus();
	}
	async function cancelRemove() {
		confirmRemove = false;
		await tick();
		removeButton?.focus();
	}
	function doRemove() {
		confirmRemove = false;
		dispatch("remove", track);
	}
</script>

<div
	class="row"
	class:active
	class:pending
	class:evicted
	role="button"
	tabindex="0"
	title={evicted
		? "À retélécharger : le cache a évincé ce morceau, clique sur Retélécharger"
		: pending
			? "Mise en cache en cours : lecture possible dès la fin du téléchargement"
			: "Lire"}
	on:click={() => dispatch("play", track)}
	on:keydown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), dispatch("play", track))}
>
	<div
		class="lead"
		class:has-thumb={number === undefined && !!thumb && !imgBroken}
	>
		{#if number !== undefined}
			<span class="num">{number}</span>
		{:else if thumb && !imgBroken}
			<img
				alt=""
				src={thumb}
				loading="lazy"
				on:error={() => (imgBroken = true)}
			/>
		{:else}
			<span class="ph"><Icon name="list-music" size="1.1em" /></span>
		{/if}
		{#if active}
			<span class="playing"><Icon name="play" size="0.9em" fill="currentColor" /></span>
		{/if}
	</div>
	<div class="meta">
		<p
			class="title"
			{title}
		>
			{title}
		</p>
		<p class="sub">
			{#if showArtist}<span class="artist">{artist}</span>{/if}
			{#if showArtist && length}<span class="dot">·</span>{/if}
			{#if length}{length}{/if}
			{#if evicted}<span class="evicted-label"
					>{#if showArtist || length}<span class="dot">·</span>{/if}À retélécharger</span
				>{:else if pending}<span class="pending-label"
					>{#if showArtist || length}<span class="dot">·</span>{/if}mise en cache en cours</span
				>{/if}
		</p>
	</div>
	{#if evicted}
		<button
			type="button"
			class="btn recache"
			title={online ? "Retélécharger ce morceau évincé du cache" : "Hors connexion : disponible avec le réseau"}
			aria-label="Retélécharger"
			disabled={!online}
			on:click|stopPropagation={() => dispatch("recache", track)}>
			<Icon name="download" size="1em" />
		</button>
	{/if}
	<button
		type="button"
		class="btn pin"
		class:on={!!track._pinned}
		aria-pressed={!!track._pinned}
		aria-label={track._pinned ? "Désépingler" : "Épingler hors-ligne"}
		title={track._pinned ? "Désépingler (peut être évincé)" : "Épingler hors-ligne (jamais évincé)"}
		on:click|stopPropagation={() => dispatch("pin", track)}>
		<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill={track._pinned ? "currentColor" : "none"} stroke="currentColor" stroke-width="2"><path d="M16 3l5 5-4 1-5 5 1 5-3 3-4-6-4 4-1-1 4-4-6-4 3-3 5 1 5-5z"/></svg>
	</button>
	{#if confirmRemove}
		<span
			class="confirm"
			role="group"
			aria-label="Confirmer le retrait d'un morceau épinglé"
		>
			<span class="confirm-text">Épinglé : retirer quand même ?</span>
			<button
				class="btn confirm-yes"
				type="button"
				aria-label="Confirmer le retrait"
				bind:this={confirmButton}
				on:keydown|stopPropagation
				on:click|stopPropagation={doRemove}>Retirer</button
			>
			<button
				class="btn confirm-no"
				type="button"
				aria-label="Annuler le retrait"
				on:keydown|stopPropagation
				on:click|stopPropagation={cancelRemove}>Annuler</button
			>
		</span>
	{:else}
		<button
			class="rm"
			type="button"
			title={track?._pinned ? "Retirer du cache (épinglé : confirmation demandée)" : "Retirer du cache"}
			aria-label="Retirer du cache"
			bind:this={removeButton}
			on:click|stopPropagation={askRemove}>✕</button
		>
	{/if}
</div>

<style lang="scss">
	$text: var(--color-dark, #fafafa);
	$muted: #b3b3b3;
	$accent: #1ed760;
	$warn: #e0a000;

	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.4rem 0.5rem;
		min-height: 2.75rem;
		border-radius: 0.5rem;
		cursor: pointer;
		min-width: 0;
		transition: background 120ms ease;
		&:hover,
		&:focus-visible {
			background: rgba(255, 255, 255, 0.06);
			outline: none;
		}
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: -2px;
		}
		&:active {
			background: rgba(255, 255, 255, 0.1);
		}
		&.active {
			background: rgba(30, 215, 96, 0.1);
		}
	}
	.lead {
		position: relative;
		flex: 0 0 auto;
		width: 2.75rem;
		height: 2.75rem;
		display: grid;
		place-items: center;
		border-radius: 0.35rem;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.05);
		color: #aaa;
		img {
			width: 100%;
			height: 100%;
			object-fit: cover;
			display: block;
		}
		.num {
			font-variant-numeric: tabular-nums;
			color: $muted;
		}
		.playing {
			position: absolute;
			inset: 0;
			display: grid;
			place-items: center;
			background: rgba(0, 0, 0, 0.55);
			color: $accent;
		}
	}
	.meta {
		flex: 1 1 auto;
		min-width: 0;
		p {
			margin: 0;
			min-width: 0;
		}
	}
	// Title: up to two lines, then an ellipsis (long "(feat. …)" titles on mobile).
	.title {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
		line-height: 1.3;
	}
	.active .title {
		color: $accent;
	}
	.pending .title {
		opacity: 0.75;
	}
	.sub {
		font-size: var(--text-secondary-size);
		color: $muted;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dot {
		margin: 0 0.3em;
	}
	.pending-label {
		color: $warn;
	}
	.evicted .title {
		opacity: 0.75;
	}
	.evicted-label {
		color: $warn;
		font-weight: 600;
	}
	// Pin + remove buttons (audit v3 1.8 / TOP 10 #9): outline boxes, 44x36
	// minimum, transparent background with a 1px rgba(255,255,255,.35) border
	// (the global %button-base paints a solid white pill, which made the
	// unpinned pin look "active"). Pinned = green border + icon.
	// The minima carry a px floor (audit v4 TOP 3): the mobile root font is
	// 12px, so 2.75rem alone collapsed to 33x27.
	// Audit v6 TOP 7: 44x44 minimum (36 px tall was a phone tap-target
	// regression) and round like the header play / shuffle circles.
	.pin,
	.rm,
	.recache,
	.confirm-yes,
	.confirm-no {
		flex: 0 0 auto;
		box-sizing: border-box;
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		width: auto;
		height: auto;
		padding: 0;
		margin: 0;
		display: grid;
		place-items: center;
		background: transparent !important;
		border: 1px solid rgba(255, 255, 255, 0.35) !important;
		box-shadow: none !important;
		color: $text !important;
		border-radius: 999px;
		font: inherit;
		font-size: 1rem;
		line-height: 1;
		text-transform: none;
		cursor: pointer;
		// Global `button:not(.icon-btn):focus/:active` (0,2,1) paints a light
		// grey background !important; keep ours on every interactive state.
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.12) !important;
			border-color: rgba(255, 255, 255, 0.6) !important;
			color: $text !important;
			box-shadow: none !important;
		}
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
		}
	}
	// Inline remove confirmation (G20): red-tinted group like Settings > Offline.
	.confirm {
		flex: 0 0 auto;
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.5rem;
		border-radius: 0.5rem;
		background: rgb(220 53 69 / 12%);
		border: 1px solid rgb(220 53 69 / 45%);
		font-size: var(--text-secondary-size);
		line-height: 1.3;
	}
	.confirm-text {
		color: $text;
	}
	.confirm-yes,
	.confirm-no {
		width: auto;
		min-width: max(2.75rem, 44px);
		padding: 0 0.6rem;
		font-size: var(--text-secondary-size);
		font-weight: 600;
	}
	.confirm-yes,
	.confirm-yes:hover,
	.confirm-yes:focus,
	.confirm-yes:focus-within,
	.confirm-yes:active {
		color: #ffb3b3 !important;
		border-color: rgb(220 53 69 / 70%) !important;
	}
	.recache,
	.recache:hover,
	.recache:focus,
	.recache:focus-within,
	.recache:active {
		color: $warn !important;
		border-color: rgba(224, 160, 0, 0.7) !important;
	}
	.recache:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.pin.on,
	.pin.on:hover,
	.pin.on:focus,
	.pin.on:focus-within,
	.pin.on:active {
		color: $accent !important;
		border-color: $accent !important;
		background: rgba(30, 215, 96, 0.12) !important;
	}
	@media (max-width: 640px) {
		.sub {
			white-space: normal;
		}
	}
	// Touch screens: a visible 36px round play badge on the cover, like the
	// search rows (ListItem index.scss). Decorative: the row itself is the
	// button ("Lire"), so pointer-events none and no extra name.
	@media (hover: none) {
		.lead.has-thumb::after {
			content: "";
			position: absolute;
			inset: 0;
			margin: auto;
			width: 36px;
			height: 36px;
			border-radius: 50%;
			pointer-events: none;
			background: rgba(0, 0, 0, 0.55)
				url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23ffffff'><path d='M8 5v14l11-7z'/></svg>")
				center / 16px 16px no-repeat;
			box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
		}
		.row.active .lead.has-thumb::after,
		.row.pending .lead.has-thumb::after,
		.row.evicted .lead.has-thumb::after {
			display: none;
		}
	}
</style>
