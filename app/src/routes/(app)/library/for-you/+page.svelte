<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import { getMix } from "$lib/me";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let items: any[] = [];
	let seeds = 0;
	let loading = true;

	async function load() {
		loading = true;
		try {
			const r = await getMix();
			items = Array.isArray(r.items) ? r.items : [];
			seeds = r.seeds || 0;
		} catch (err) {
			console.error("mix load failed", err);
		}
		loading = false;
	}
	onMount(load);
</script>

<main>
	<CollectionNav active="for-you" />
	<header class="head">
		<div>
			<h1>Made for you</h1>
			<span class="sub"
				>{seeds > 0
					? `From your ${seeds} favourite seed${seeds === 1 ? "" : "s"}`
					: "Fresh from your library"}</span
			>
		</div>
		<button
			class="btn"
			on:click={load}
			disabled={loading}>Refresh</button
		>
	</header>

	{#if loading}
		<p class="state">Building your mix…</p>
	{:else if items.length === 0}
		<p class="state">Play a few tracks and your mix will appear here.</p>
	{:else}
		<div class="grid">
			{#each items as item (item.videoId || item.title)}
				<div class="cell"><Listing data={item} /></div>
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
	.btn:disabled {
		opacity: 0.5;
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
		margin: 1.5rem 0;
	}
	@media screen and (max-width: 37em) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
