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

	const dispatch = createEventDispatcher<{ play: any; remove: any }>();

	$: thumb = thumbnailOf(track);
	$: artist = artistName(track);
	$: length = (track?.length && (track.length.text || track.length)) || "";
	$: pending = track?._cached === false;
	let imgBroken = false;
</script>

<div
	class="row"
	class:active
	role="button"
	tabindex="0"
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
		<p class="title">{track?.title || track?.videoId}</p>
		<p class="sub">
			{#if showArtist}{artist}{/if}
			{#if showArtist && length}<span class="dot">·</span>{/if}
			{#if length}{length}{/if}
			{#if pending}<span class="pending">· en cours de cache</span>{/if}
		</p>
	</div>
	<button
		class="rm"
		type="button"
		title="Retirer du cache"
		aria-label="Retirer du cache"
		on:click|stopPropagation={() => dispatch("remove", track)}>✕</button
	>
</div>

<style lang="scss">
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.4rem 0.5rem;
		border-radius: 0.5rem;
		cursor: pointer;
		min-width: 0;
		transition: background 120ms ease;
		&:hover,
		&:focus-visible {
			background: rgba(255, 255, 255, 0.06);
			outline: none;
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
		}
		.num {
			font-variant-numeric: tabular-nums;
			color: #999;
		}
		.playing {
			position: absolute;
			inset: 0;
			display: grid;
			place-items: center;
			background: rgba(0, 0, 0, 0.55);
			color: #1ed760;
		}
	}
	.meta {
		flex: 1;
		min-width: 0;
		p {
			margin: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
	}
	.active .title {
		color: #1ed760;
	}
	.sub {
		font-size: 0.85rem;
		color: #999;
	}
	.dot {
		margin: 0 0.3em;
	}
	.pending {
		color: #e0a000;
	}
	.rm {
		flex: 0 0 auto;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.2);
		color: inherit;
		border-radius: 0.4rem;
		padding: 0.3rem 0.6rem;
		cursor: pointer;
		min-width: 2.25rem;
		min-height: 2.25rem;
	}
</style>
