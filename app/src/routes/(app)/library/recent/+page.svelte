<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import { getRecent, getTop } from "$lib/me";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let recent: any[] = [];
	let top: any[] = [];
	let loading = true;

	onMount(async () => {
		try {
			const [r, t] = await Promise.all([getRecent(60), getTop(60)]);
			recent = Array.isArray(r.items) ? r.items : [];
			top = Array.isArray(t.items) ? t.items : [];
		} catch (err) {
			console.error("recent load failed", err);
		}
		loading = false;
	});
</script>

<main>
	<CollectionNav active="recent" />
	<h1>Listening</h1>

	<section>
		<h2>Recently played</h2>
		{#if loading}
			<p class="state">Loading…</p>
		{:else if recent.length === 0}
			<p class="state">Nothing played yet.</p>
		{:else}
			<div class="grid">
				{#each recent as item (item.videoId || item.title)}
					<div class="cell"><Listing data={item} /></div>
				{/each}
			</div>
		{/if}
	</section>

	{#if top.length > 0}
		<section>
			<h2>Most played</h2>
			<div class="grid">
				{#each top as item (item.videoId || item.title)}
					<div class="cell"><Listing data={item} /></div>
				{/each}
			</div>
		</section>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	h2 {
		margin: 1.25rem 0 0.5rem;
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
