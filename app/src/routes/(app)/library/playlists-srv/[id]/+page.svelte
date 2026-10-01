<script lang="ts">
	import { page } from "$app/stores";
	import Listing from "$components/Item/Listing.svelte";
	import PlayAllBar from "$components/PlayAllBar/PlayAllBar.svelte";
	import KeepOfflineButton from "$lib/components/ListItem/KeepOfflineButton.svelte";
	import Icon from "$components/Icon/Icon.svelte";
	import { getPlaylist, deletePlaylist, removeFromPlaylist } from "$lib/me";
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	import CollectionNav from "../../_CollectionNav.svelte";

	let pl: any = null;
	let tracks: any[] = [];
	let loading = true;
	/** videoId of the row mid-removal (disables only that row's button). */
	let removingRef = "";

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

	// BI1: per-track removal (DELETE me/playlists/:id/items?ref=…, already
	// wired in $lib/me as removeFromPlaylist, never called from the UI).
	async function removeTrack(item: any) {
		const ref = item?.videoId || item?.lid || "";
		if (!ref || removingRef) return;
		removingRef = ref;
		try {
			await removeFromPlaylist($page.params.id, item);
			tracks = tracks.filter((t) => (t.videoId || t.lid) !== ref);
		} catch (err) {
			console.error("remove from playlist failed", err);
		} finally {
			removingRef = "";
		}
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
			<div class="actions">
				{#if tracks.length}
					<KeepOfflineButton {tracks} />
				{/if}
				<button
					class="btn"
					on:click={remove}>Delete</button
				>
			</div>
		</header>
		{#if tracks.length === 0}
			<p class="state">No tracks in this playlist.</p>
		{:else}
			<!-- J16: the context comes from the page data, not from the DOM heading. -->
			<PlayAllBar
				{tracks}
				context={{ kind: "playlist", title: String(pl?.name ?? ""), href: $page.url.pathname }}
			/>
			<section>
				{#each tracks as item (item.videoId || item.title)}
					<div class="track-row">
						<Listing data={item} />
						<button
							type="button"
							class="btn-reset btn-secondary remove-track"
							aria-label="Retirer de la playlist"
							disabled={removingRef === (item.videoId || item.lid)}
							on:click={() => removeTrack(item)}
						>
							<Icon
								name="trash"
								size="1em"
							/>
						</button>
					</div>
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
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
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
	.track-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.track-row :global(.listing),
	.track-row > :global(*:first-child) {
		flex: 1 1 auto;
		min-width: 0;
	}
	.remove-track {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		padding: 0;
	}
	.remove-track:disabled {
		cursor: progress;
	}
</style>
