<script lang="ts">
	// One album (or an artist's "Singles" bucket): cover, name, artist, count,
	// play / shuffle buttons and a collapsible track list (click a track to play
	// the album from there). Events: play {tracks, index, shuffle}, remove track.
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
	}>();

	let imgBroken = false;
	$: count = album.tracks.length;
	$: size = formatBytes(album.bytes);
	$: isActive = !!activeId && album.tracks.some((t) => t.videoId === activeId);
</script>

<section
	class="album"
	class:active={isActive}
>
	<div class="head">
		<button
			class="cover"
			type="button"
			aria-label={open ? "Replier" : "Déplier"}
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
			on:click={() => (open = !open)}
		>
			<p class="name">{album.name}</p>
			<p class="sub">
				{#if showArtist}{album.artist}<span class="dot">·</span>{/if}
				{count} {count > 1 ? "pistes" : "piste"}{#if size}<span class="dot">·</span>{size}{/if}
			</p>
		</button>
		<div class="actions">
			<button
				class="btn"
				type="button"
				title="Lire"
				aria-label="Lire"
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
				title="Aléatoire"
				aria-label="Aléatoire"
				on:click={() => dispatch("play", { tracks: album.tracks, index: 0, shuffle: true })}
			>
				<Icon
					name="shuffle"
					size="1.1em"
				/>
			</button>
			<button
				class="btn chev"
				class:open
				type="button"
				title={open ? "Replier" : "Déplier"}
				aria-label={open ? "Replier" : "Déplier"}
				on:click={() => (open = !open)}
			>
				<span
					class="chev-glyph"
					aria-hidden="true">›</span
				>
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
				/>
			{/each}
		</div>
	{/if}
</section>

<style lang="scss">
	.album {
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.75rem;
		background: rgba(255, 255, 255, 0.03);
		margin-bottom: 0.6rem;
		overflow: hidden;
		&.active {
			border-color: rgba(30, 215, 96, 0.35);
		}
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem;
	}
	button {
		background: none;
		border: 0;
		color: inherit;
		font: inherit;
		padding: 0;
		cursor: pointer;
		text-align: left;
	}
	.cover {
		flex: 0 0 auto;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 0.5rem;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.06);
		display: grid;
		place-items: center;
		color: #aaa;
		img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
	}
	.info {
		flex: 1;
		min-width: 0;
		p {
			margin: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
	}
	.name {
		font-weight: 600;
	}
	.sub {
		font-size: 0.85rem;
		color: #999;
	}
	.dot {
		margin: 0 0.3em;
	}
	.actions {
		flex: 0 0 auto;
		display: flex;
		gap: 0.3rem;
	}
	.btn {
		width: 2.4rem;
		height: 2.4rem;
		border-radius: 999px;
		display: grid;
		place-items: center;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
		&:hover {
			background: rgba(255, 255, 255, 0.16);
		}
	}
	.chev {
		transition: transform 150ms ease;
		&.open {
			transform: rotate(90deg);
		}
	}
	.chev-glyph {
		font-size: 1.4rem;
		line-height: 1;
		transform: translateY(-1px);
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
		.btn {
			width: 2.2rem;
			height: 2.2rem;
		}
	}
</style>
