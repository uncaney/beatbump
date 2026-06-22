<script lang="ts">
	import { APIClient } from "$lib/api";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let genres: { name: string; count: number }[] = [];
	let loading = true;
	let q = "";

	$: filtered = q
		? genres.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()))
		: genres;

	onMount(async () => {
		try {
			const res = await APIClient.fetch("/api/v1/local/genres");
			const data = await res.json();
			genres = Array.isArray(data.genres) ? data.genres : [];
		} catch (err) {
			console.error("genres load failed", err);
		}
		loading = false;
	});
</script>

<main>
	<CollectionNav active="genres" />
	<header class="head">
		<h1>Genres</h1>
		<input
			class="filter"
			type="search"
			placeholder="Filter genres…"
			bind:value={q}
		/>
	</header>

	{#if loading}
		<p class="state">Loading…</p>
	{:else if filtered.length === 0}
		<p class="state">No genres.</p>
	{:else}
		<div class="chips">
			{#each filtered as g}
				<a
					class="chip"
					href={`/library/all-songs?genre=${encodeURIComponent(g.name)}`}
				>
					<span class="name">{g.name}</span>
					<span class="count">{g.count}</span>
				</a>
			{/each}
		</div>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}
	.filter {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 0.4rem;
		color: inherit;
		padding: 0.4rem 0.6rem;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.8rem;
		border-radius: 1rem;
		background: rgba(255, 255, 255, 0.07);
		color: inherit;
		text-decoration: none;
	}
	.chip:hover {
		background: rgba(255, 255, 255, 0.16);
	}
	.chip .count {
		color: #999;
		font-size: 0.85rem;
	}
	.state {
		text-align: center;
		color: #999;
		margin: 2rem 0;
	}
</style>
