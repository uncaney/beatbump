<script lang="ts">
	import { page } from "$app/stores";
	import Listing from "$components/Item/Listing.svelte";
	import PlayAllBar from "$components/PlayAllBar/PlayAllBar.svelte";
	import { getPlaylist, deletePlaylist } from "$lib/me";
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	import CollectionNav from "../../_CollectionNav.svelte";

	let pl: any = null;
	let tracks: any[] = [];
	let loading = true;

	onMount(async () => {
		try {
			const r = await getPlaylist($page.params.id);
			pl = r.playlist;
			tracks = Array.isArray(r.tracks) ? r.tracks : [];
		} catch (err) {
			console.error("playlist load failed", err);
		}
		loading = false;
	});

	async function remove() {
		await deletePlaylist($page.params.id);
		goto("/library/playlists-srv");
	}
</script>

<main>
	<CollectionNav active="my-playlists" />
	{#if loading}
		<p class="state">Loading…</p>
	{:else if !pl}
		<p class="state">Playlist not found.</p>
	{:else}
		<header class="head">
			<div>
				<h1>{pl.name}</h1>
				<span class="sub">{tracks.length} tracks</span>
			</div>
			<button
				class="btn"
				on:click={remove}>Delete</button
			>
		</header>
		{#if tracks.length === 0}
			<p class="state">No tracks in this playlist.</p>
		{:else}
			<PlayAllBar {tracks} />
			<section>
				{#each tracks as item (item.videoId || item.title)}
					<Listing data={item} />
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
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.sub {
		color: #999;
		margin-left: 0.5rem;
	}
	.btn {
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 0.4rem;
		color: inherit;
		padding: 0.4rem 0.9rem;
		cursor: pointer;
	}
	.state {
		color: #999;
		margin: 1rem 0;
	}
</style>
