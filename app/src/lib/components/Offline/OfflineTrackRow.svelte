<script lang="ts">
	// One cached track. Click = play (event "play"), ✕ = remove (event "remove").
	// Deliberately not Item/Listing: its click path calls the network mix API,
	// while this row must start playback from the cached copy only.
	import Icon from "$components/Icon/Icon.svelte";
	import { artistName, thumbnailOf } from "$lib/offlineQueue";
	import { createEventDispatcher } from "svelte";

	export let track: any;
	export let active = false;
	export let number: number | undefined = undefined;
	export let showArtist = true;

	const dispatch = createEventDispatcher<{ play: any; remove: any; pin: any }>();

	$: thumb = thumbnailOf(track);
	$: artist = artistName(track);
	$: length = (track?.length && (track.length.text || track.length)) || "";
	$: pending = track?._cached === false;
	$: title = track?.title || track?.videoId;
	let imgBroken = false;
</script>

<div
	class="row"
	class:active
	class:pending
	role="button"
	tabindex="0"
	title={pending ? "Mise en cache en cours : lecture possible dès la fin du téléchargement" : "Lire"}
	on:click={() => dispatch("play", track)}
	on:keydown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), dispatch("play", track))}
>
	<div class="lead">
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
			{#if pending}<span class="pending-label"
					>{#if showArtist || length}<span class="dot">·</span>{/if}mise en cache en cours</span
				>{/if}
		</p>
	</div>
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
	<button
		class="rm"
		type="button"
		title="Retirer du cache"
		aria-label="Retirer du cache"
		on:click|stopPropagation={() => dispatch("remove", track)}>✕</button
	>
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
		font-size: 0.85rem;
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
	// Remove button: 44px square, light glyph (overrides global %button-base).
	.rm {
		flex: 0 0 auto;
		width: 2.75rem;
		height: 2.75rem;
		padding: 0;
		display: grid;
		place-items: center;
		background: rgba(255, 255, 255, 0.08) !important;
		border: 1px solid rgba(255, 255, 255, 0.2) !important;
		box-shadow: none !important;
		color: $text !important;
		border-radius: 0.5rem;
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
			background: rgba(255, 255, 255, 0.16) !important;
			border-color: rgba(255, 255, 255, 0.35) !important;
			color: $text !important;
			box-shadow: none !important;
		}
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
		}
	}
	@media (max-width: 640px) {
		.sub {
			white-space: normal;
		}
	}
	.pin.on {
		color: #1ed760;
	}
</style>
