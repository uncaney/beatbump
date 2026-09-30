<script lang="ts">
	// Offline library: every track played is cached automatically ($lib/offline,
	// service worker). This page lists the cache by album / artist / recency and
	// starts playback from the cached copies only (see $lib/offlineQueue.play),
	// so it works with no connection at all.
	import Icon from "$components/Icon/Icon.svelte";
	import AlbumCard from "$components/Offline/AlbumCard.svelte";
	import OfflineTrackRow from "$components/Offline/OfflineTrackRow.svelte";
	import { getOfflineTracks, removeOffline } from "$lib/offline";
	import {
		formatBytes,
		groupByAlbum,
		groupByArtist,
		mixtape,
		play,
		recentlyCached,
		totalBytes,
		type AlbumGroup,
		type ArtistGroup,
	} from "$lib/offlineQueue";
	import { currentTrack } from "$lib/stores/list";
	import { notify } from "$lib/utils";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	type View = "albums" | "artists" | "recent";

	let tracks: any[] = [];
	let online = true;
	let view: View = "albums";
	let openAlbums: Record<string, boolean> = {};
	let openArtists: Record<string, boolean> = {};
	let starting = false;

	$: albums = groupByAlbum(tracks) as AlbumGroup[];
	$: artists = groupByArtist(tracks) as ArtistGroup[];
	$: recent = recentlyCached(tracks, -1);
	$: size = formatBytes(totalBytes(tracks));
	$: pendingCount = tracks.filter((t) => t?._cached === false).length;
	$: activeId = $currentTrack?.videoId || "";

	function refresh() {
		tracks = getOfflineTracks();
	}

	onMount(() => {
		online = navigator.onLine;
		refresh();
		try {
			const v = localStorage.getItem("ytm-offline-view");
			if (v === "albums" || v === "artists" || v === "recent") view = v;
		} catch {
			/* ignore */
		}
		const on = () => (online = true);
		const off = () => (online = false);
		const storage = (e: StorageEvent) => {
			if (!e.key || e.key === "ytm-offline-tracks") refresh();
		};
		const visible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		window.addEventListener("online", on);
		window.addEventListener("offline", off);
		window.addEventListener("storage", storage);
		document.addEventListener("visibilitychange", visible);
		return () => {
			window.removeEventListener("online", on);
			window.removeEventListener("offline", off);
			window.removeEventListener("storage", storage);
			document.removeEventListener("visibilitychange", visible);
		};
	});

	function setView(v: View) {
		view = v;
		try {
			localStorage.setItem("ytm-offline-view", v);
		} catch {
			/* ignore */
		}
	}

	async function start(items: any[], index = 0, opts: { shuffle?: boolean } = {}) {
		if (starting) return;
		starting = true;
		try {
			const ok = await play(items, index, opts);
			if (!ok) notify("Aucun morceau lisible hors-ligne dans cette sélection.", "error");
		} catch (err) {
			console.error("offline play failed", err);
			notify("Lecture hors-ligne impossible.", "error");
		} finally {
			starting = false;
		}
	}

	function playAll() {
		start(recent, 0);
	}
	function playShuffle() {
		start(recent, 0, { shuffle: true });
	}
	function playMixtape() {
		start(mixtape(tracks, { avoidSameArtistInARow: true }), 0);
	}

	function remove(t: any) {
		removeOffline(t);
		refresh();
	}
</script>

<main>
	<CollectionNav active="downloads-offline" />
	<header class="head">
		<div class="titles">
			<h1>Hors-ligne</h1>
			<p class="stats">
				{#if tracks.length === 0}
					Aucun morceau en cache
				{:else}
					{tracks.length} {tracks.length > 1 ? "morceaux" : "morceau"}
					{#if size}<span class="dot">·</span>{size}{/if}
					{#if albums.length}<span class="dot">·</span>{albums.length} {albums.length > 1 ? "albums" : "album"}{/if}
					{#if pendingCount}<span class="dot">·</span><span class="pending">{pendingCount} en cours</span>{/if}
				{/if}
			</p>
		</div>
		<span
			class="status"
			class:off={!online}>{online ? "● En ligne" : "● Hors-ligne"}</span
		>
	</header>
	<p class="note">
		Chaque morceau que tu écoutes est enregistré ici automatiquement et se joue sans connexion.
	</p>

	{#if tracks.length === 0}
		<p class="state">
			Rien pour l'instant. Lance une écoute : le morceau sera gardé ici et disponible sans réseau.
		</p>
	{:else}
		<div class="actions">
			<button
				class="cta primary"
				type="button"
				disabled={starting}
				on:click={playAll}
			>
				<Icon
					name="play"
					size="1em"
					fill="currentColor"
				/>
				Tout lire
			</button>
			<button
				class="cta"
				type="button"
				disabled={starting}
				on:click={playShuffle}
			>
				<Icon
					name="shuffle"
					size="1em"
				/>
				Aléatoire
			</button>
			<button
				class="cta"
				type="button"
				disabled={starting}
				on:click={playMixtape}
			>
				<Icon
					name="radio"
					size="1em"
				/>
				Mixtape
			</button>
		</div>

		<nav
			class="views"
			aria-label="Vue"
		>
			<button
				type="button"
				class:active={view === "albums"}
				on:click={() => setView("albums")}>Albums</button
			>
			<button
				type="button"
				class:active={view === "artists"}
				on:click={() => setView("artists")}>Artistes</button
			>
			<button
				type="button"
				class:active={view === "recent"}
				on:click={() => setView("recent")}>Récents</button
			>
		</nav>

		{#if view === "albums"}
			<section>
				{#each albums as album (album.key)}
					<AlbumCard
						{album}
						{activeId}
						bind:open={openAlbums[album.key]}
						on:play={(e) => start(e.detail.tracks, e.detail.index, { shuffle: e.detail.shuffle })}
						on:remove={(e) => remove(e.detail)}
					/>
				{/each}
			</section>
		{:else if view === "artists"}
			<section>
				{#each artists as artist (artist.key)}
					{@const open = openArtists[artist.key] ?? artists.length <= 3}
					<div
						class="artist"
						class:active={!!activeId && artist.tracks.some((t) => t.videoId === activeId)}
					>
						<div class="artist-head">
							<button
								class="artist-name"
								type="button"
								aria-expanded={open}
								on:click={() => (openArtists[artist.key] = !open)}
							>
								<span
									class="chev"
									class:open
									aria-hidden="true">›</span
								>
								<span class="name">{artist.name}</span>
								<span class="sub">
									{artist.tracks.length} {artist.tracks.length > 1 ? "pistes" : "piste"}
									{#if artist.albums.length > 1}<span class="dot">·</span>{artist.albums.length} albums{/if}
									{#if formatBytes(artist.bytes)}<span class="dot">·</span>{formatBytes(artist.bytes)}{/if}
								</span>
							</button>
							<div class="artist-actions">
								<button
									class="btn"
									type="button"
									title="Lire l'artiste"
									aria-label="Lire l'artiste"
									on:click={() => start(artist.albums.flatMap((a) => a.tracks), 0)}
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
									title="Artiste en aléatoire"
									aria-label="Artiste en aléatoire"
									on:click={() => start(artist.tracks, 0, { shuffle: true })}
								>
									<Icon
										name="shuffle"
										size="1.1em"
									/>
								</button>
							</div>
						</div>
						{#if open}
							<div class="artist-albums">
								{#each artist.albums as album (album.key)}
									<AlbumCard
										{album}
										{activeId}
										showArtist={false}
										bind:open={openAlbums["a:" + album.key]}
										on:play={(e) => start(e.detail.tracks, e.detail.index, { shuffle: e.detail.shuffle })}
										on:remove={(e) => remove(e.detail)}
									/>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</section>
		{:else}
			<section class="list">
				{#each recent as t, i (t.videoId)}
					<OfflineTrackRow
						track={t}
						active={t.videoId === activeId}
						on:play={() => start(recent, i)}
						on:remove={(e) => remove(e.detail)}
					/>
				{/each}
			</section>
		{/if}
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	.head {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		justify-content: space-between;
	}
	.titles {
		min-width: 0;
	}
	h1 {
		margin-bottom: 0.15rem;
	}
	.stats {
		margin: 0;
		color: #bbb;
		font-size: 0.9rem;
	}
	.pending {
		color: #e0a000;
	}
	.status {
		color: #1ed760;
		font-size: 0.9rem;
		white-space: nowrap;
		margin-top: 0.4rem;
	}
	.status.off {
		color: #e0a000;
	}
	.note {
		color: #999;
		font-size: 0.9rem;
		margin: 0.5rem 0 1rem;
	}
	.dot {
		margin: 0 0.3em;
	}
	.state {
		color: #999;
		margin: 1.5rem 0;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}
	.cta {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.55rem 1rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		min-height: 2.6rem;
		&:hover {
			background: rgba(255, 255, 255, 0.16);
		}
		&:disabled {
			opacity: 0.6;
			cursor: default;
		}
		&.primary {
			background: #1ed760;
			border-color: #1ed760;
			color: #000;
			&:hover {
				background: #22e668;
			}
		}
	}
	.views {
		display: flex;
		gap: 0.4rem;
		margin-bottom: 0.9rem;
		button {
			background: rgba(255, 255, 255, 0.05);
			border: 0;
			color: inherit;
			font: inherit;
			padding: 0.35rem 0.85rem;
			border-radius: 1rem;
			opacity: 0.7;
			cursor: pointer;
			&:hover,
			&.active {
				opacity: 1;
			}
			&.active {
				background: rgba(255, 255, 255, 0.16);
			}
		}
	}
	.artist {
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		padding: 0.35rem 0 0.5rem;
		margin-bottom: 0.4rem;
		&.active .name {
			color: #1ed760;
		}
	}
	.artist-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.artist-name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		background: none;
		border: 0;
		color: inherit;
		font: inherit;
		padding: 0.4rem 0;
		cursor: pointer;
		text-align: left;
		.name {
			font-weight: 600;
			font-size: 1.05rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.sub {
			color: #999;
			font-size: 0.85rem;
			white-space: nowrap;
		}
		.chev {
			display: inline-grid;
			place-items: center;
			align-self: center;
			font-size: 1.3rem;
			line-height: 1;
			color: #999;
			transition: transform 150ms ease;
			&.open {
				transform: rotate(90deg);
			}
		}
	}
	.artist-actions {
		display: flex;
		gap: 0.3rem;
		flex: 0 0 auto;
	}
	.btn {
		width: 2.4rem;
		height: 2.4rem;
		border-radius: 999px;
		display: grid;
		place-items: center;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
		color: inherit;
		cursor: pointer;
		&:hover {
			background: rgba(255, 255, 255, 0.16);
		}
	}
	.artist-albums {
		padding-left: 0.5rem;
		margin-top: 0.3rem;
	}
	@media (max-width: 640px) {
		.head {
			flex-direction: column;
			gap: 0.25rem;
		}
		.status {
			margin-top: 0;
		}
		.artist-name {
			flex-wrap: wrap;
			.sub {
				white-space: normal;
			}
		}
		.artist-albums {
			padding-left: 0;
		}
	}
</style>
