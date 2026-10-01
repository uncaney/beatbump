<script lang="ts">
	// One album (or an artist's "Singles" bucket): cover, name, artist, count,
	// play / shuffle buttons and a collapsible track list (click a track to play
	// the album from there). Events: play {tracks, index, shuffle}, remove track.
	//
	// The global stylesheet forces `color: #0f0f0f !important`, `display:
	// inline-flex` and `text-transform: capitalize` on every `button:not(.icon-btn)`;
	// the styles below override those explicitly so the album name and meta stack
	// (name on top, artist/count under it) and stay readable on dark backgrounds.
	import Icon from "$components/Icon/Icon.svelte";
	import type { AlbumGroup } from "$lib/offlineQueue";
	import { formatBytes } from "$lib/offlineQueue";
	import { createEventDispatcher } from "svelte";
	import OfflineTrackRow from "./OfflineTrackRow.svelte";

	export let album: AlbumGroup;
	export let activeId = "";
	export let open = false;
	export let showArtist = true;

	const dispatch = createEventDispatcher<{
		play: { tracks: any[]; index: number; shuffle?: boolean };
		remove: any;
		pin: any;
		recache: any;
	}>();

	let imgBroken = false;
	$: count = album.tracks.length;
	$: allPinned = album.tracks.length > 0 && album.tracks.every((t: any) => !!t._pinned);
	$: size = formatBytes(album.bytes);
	$: isActive = !!activeId && album.tracks.some((t) => t.videoId === activeId);
	$: toggleLabel = open ? "Replier l'album" : "Déplier l'album";
</script>

<section
	class="album"
	class:active={isActive}
>
	<div class="head">
		<button
			class="cover"
			type="button"
			title={toggleLabel}
			aria-label={toggleLabel}
			on:click={() => (open = !open)}
		>
			{#if album.thumbnail && !imgBroken}
				<img
					alt=""
					src={album.thumbnail}
					loading="lazy"
					on:error={() => (imgBroken = true)}
				/>
			{:else}
				<span class="ph"><Icon name="album" size="1.4em" /></span>
			{/if}
		</button>
		<button
			class="info"
			type="button"
			aria-expanded={open}
			title={toggleLabel}
			on:click={() => (open = !open)}
		>
			<span class="text">
				<span
					class="name"
					title={album.name}>{album.name}</span
				>
				<span class="sub">
					{#if showArtist}<span class="artist">{album.artist}</span><span class="dot">·</span>{/if}
					{count} {count > 1 ? "pistes" : "piste"}{#if size}<span class="dot">·</span>{size}{/if}
				</span>
			</span>
			<span
				class="chev"
				class:open
				aria-hidden="true">›</span
			>
		</button>
		<div class="actions">
			<button
				class="btn"
				type="button"
				title="Lire l'album"
				aria-label="Lire l'album"
				on:click={() => dispatch("play", { tracks: album.tracks, index: 0 })}
			>
				<Icon
					name="play"
					size="1.1em"
					fill="currentColor"
				/>
			</button>
			<button
				class="btn"
				type="button"
				title="Album en aléatoire"
				aria-label="Album en aléatoire"
				on:click={() => dispatch("play", { tracks: album.tracks, index: 0, shuffle: true })}
			>
				<Icon
					name="shuffle"
					size="1.1em"
				/>
			</button>
			<button
				type="button"
				class="btn pin"
				class:on={allPinned}
				aria-pressed={allPinned}
				aria-label={allPinned ? "Désépingler l'album" : "Épingler l'album hors-ligne"}
				on:click={() => dispatch("pin", { tracks: album.tracks, pinned: !allPinned })}>
				<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill={allPinned ? "currentColor" : "none"} stroke="currentColor" stroke-width="2"><path d="M16 3l5 5-4 1-5 5 1 5-3 3-4-6-4 4-1-1 4-4-6-4 3-3 5 1 5-5z"/></svg>
			</button>
		</div>
	</div>
	{#if open}
		<div class="tracks">
			{#each album.tracks as t, i (t.videoId)}
				<OfflineTrackRow
					track={t}
					number={album.isSingles ? undefined : i + 1}
					showArtist={album.isSingles ? showArtist : false}
					active={t.videoId === activeId}
					on:play={() => dispatch("play", { tracks: album.tracks, index: i })}
					on:remove={(e) => dispatch("remove", e.detail)}
					on:pin={(e) => dispatch("pin", e.detail)}
					on:recache={(e) => dispatch("recache", e.detail)}
				/>
			{/each}
		</div>
	{/if}
</section>

<style lang="scss">
	$text: var(--color-dark, #fafafa);
	$muted: #b3b3b3;
	$accent: #1ed760;

	.album {
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.75rem;
		background: rgba(255, 255, 255, 0.03);
		margin-bottom: 0.6rem;
		overflow: hidden;
		&.active {
			border-color: rgba(30, 215, 96, 0.35);
		}
		&.active .name {
			color: $accent;
		}
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem;
		min-width: 0;
	}
	// Shared reset for the three buttons: beats the global %button-base
	// (dark text / border / hover backgrounds, all !important there).
	.cover,
	.info,
	.btn {
		color: $text !important;
		box-shadow: none !important;
		font: inherit;
		text-transform: none;
		line-height: 1.3;
		cursor: pointer;
		text-align: left;
		// Global `button:not(.icon-btn):focus/:active` (0,2,1) paints a light
		// grey background !important; keep ours on every interactive state.
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			color: $text !important;
			box-shadow: none !important;
		}
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
		}
	}
	.cover {
		flex: 0 0 auto;
		width: 3.5rem;
		height: 3.5rem;
		padding: 0;
		border: 0 !important;
		border-radius: 0.5rem;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.06) !important;
		display: grid;
		place-items: center;
		color: #aaa !important;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.12) !important;
			border-color: transparent !important;
			color: #aaa !important;
		}
		img {
			width: 100%;
			height: 100%;
			object-fit: cover;
			display: block;
		}
	}
	// Name + meta stacked in a column; the chevron sits at the right end of the
	// same button (it already toggles), so the card keeps only two round buttons
	// and leaves room for the title on a 390px screen.
	.info {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 2.75rem;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0;
		border: 0 !important;
		background: none !important;
		white-space: normal;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: none !important;
			border-color: transparent !important;
		}
		&:hover .name {
			text-decoration: underline;
		}
	}
	.text {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.name {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
		font-weight: 600;
		font-size: 1rem;
	}
	.sub {
		display: block;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.85rem;
		font-weight: 400;
		color: $muted;
	}
	.dot {
		margin: 0 0.3em;
	}
	.chev {
		flex: 0 0 auto;
		width: 1rem;
		display: inline-grid;
		place-items: center;
		font-size: 1.4rem;
		line-height: 1;
		color: $muted;
		transition: transform 150ms ease;
		&.open {
			transform: rotate(90deg);
		}
	}
	.actions {
		flex: 0 0 auto;
		display: flex;
		gap: 0.3rem;
	}
	.btn {
		width: 2.75rem; // 44px touch target
		height: 2.75rem;
		padding: 0;
		border-radius: 999px;
		display: grid;
		place-items: center;
		line-height: 1;
		background: rgba(255, 255, 255, 0.08) !important;
		border: 1px solid rgba(255, 255, 255, 0.15) !important;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.16) !important;
			border-color: rgba(255, 255, 255, 0.3) !important;
		}
	}
	.tracks {
		padding: 0 0.4rem 0.5rem;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}
	@media (max-width: 420px) {
		.head {
			gap: 0.5rem;
			padding: 0.5rem;
		}
		.cover {
			width: 3rem;
			height: 3rem;
		}
		.actions {
			gap: 0.25rem;
		}
	}
	.pin.on {
		color: #1ed760;
	}
</style>
