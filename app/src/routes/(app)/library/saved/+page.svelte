<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import { getFavorites, getFollows } from "$lib/me";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let items: any[] = [];
	let follows: any[] = [];
	let loading = true;

	async function load() {
		loading = true;
		try {
			const [fav, fol] = await Promise.all([getFavorites(), getFollows()]);
			items = Array.isArray(fav.items) ? fav.items : [];
			follows = Array.isArray(fol.follows) ? fol.follows : [];
		} catch (err) {
			console.error("saved load failed", err);
		}
		loading = false;
	}

	onMount(load);
</script>

<main>
	<CollectionNav active="saved" />
	<h1>Saved</h1>

	{#if follows.length > 0}
		<section class="follows">
			<h2>Following</h2>
			<div class="artist-row">
				{#each follows as f (f.artistId)}
					<a
						class="artist-chip"
						href={`/artist/${f.artistId}`}
					>
						{#if f.thumbnail}<img
								src={f.thumbnail}
								alt={f.name}
								loading="lazy"
							/>{/if}
						<span>{f.name || f.artistId}</span>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<section>
		<h2>Favorites</h2>
		{#if loading}
			<p class="state">Loading…</p>
		{:else if items.length === 0}
			<p class="state">No saved items yet. Use the ♥ in any track's menu.</p>
		{:else}
			<div class="grid">
				{#each items as item (item.videoId || item.endpoint?.browseId || item.browseId || item.title)}
					<div class="cell"><Listing data={item} /></div>
				{/each}
			</div>
		{/if}
	</section>
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	h2 {
		margin: 1.25rem 0 0.5rem;
	}
	.artist-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.artist-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.8rem 0.35rem 0.35rem;
		border-radius: 2rem;
		background: rgba(255, 255, 255, 0.07);
		color: inherit;
		text-decoration: none;
	}
	.artist-chip img {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		object-fit: cover;
	}
	.artist-chip:hover {
		background: rgba(255, 255, 255, 0.16);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 0.25rem 1rem;
	}
	.cell {
		min-width: 0;
	}
	.state {
		color: #999;
		margin: 1rem 0;
	}
	@media screen and (max-width: 37em) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
