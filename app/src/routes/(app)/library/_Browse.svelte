<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import { APIClient } from "$lib/api";
	import { onMount } from "svelte";
	import CollectionNav from "./_CollectionNav.svelte";

	export let kind: "artists" | "albums" | "songs"; // backend endpoint
	export let title: string;
	export let sortOptions: { label: string; value: string }[];
	export let extraParams: string = ""; // e.g. "&genre=Rock"
	export let subtitle: string = "";

	let sort = sortOptions[0].value;
	let q = "";
	let items: any[] = [];
	let total = 0;
	let offset = 0;
	const limit = 60;
	let loading = false;
	let done = false;
	let sentinel: HTMLDivElement;

	async function load(reset = false) {
		if (loading) return;
		loading = true;
		if (reset) {
			offset = 0;
			items = [];
			done = false;
		}
		try {
			const url =
				`/api/v1/local/${kind}?sort=${encodeURIComponent(sort)}` +
				`&offset=${offset}&limit=${limit}` +
				(q ? `&q=${encodeURIComponent(q)}` : "") +
				extraParams;
			const res = await APIClient.fetch(url);
			const data = await res.json();
			const got = Array.isArray(data.items) ? data.items : [];
			items = reset ? got : [...items, ...got];
			total = data.total ?? items.length;
			offset += got.length;
			done = got.length < limit || offset >= total;
		} catch (err) {
			console.error("collection load failed", err);
			done = true;
		}
		loading = false;
	}

	let debounce: ReturnType<typeof setTimeout>;
	function onQuery() {
		clearTimeout(debounce);
		debounce = setTimeout(() => load(true), 250);
	}
	function onSort(e: Event) {
		sort = (e.target as HTMLSelectElement).value;
		load(true);
	}

	onMount(() => {
		load(true);
		const io = new IntersectionObserver((entries) => {
			if (entries[0].isIntersecting && !done && !loading) load();
		});
		if (sentinel) io.observe(sentinel);
		return () => io.disconnect();
	});
</script>

<main class="resp-content-width">
	<CollectionNav active={kind} />
	<header class="head">
		<div>
			<h1>{title}</h1>
			{#if subtitle}<span class="sub">{subtitle}</span>{/if}
			{#if total}<span class="sub">· {total.toLocaleString()} items</span>{/if}
		</div>
		<div class="controls">
			<input
				class="filter"
				type="search"
				placeholder="Filter…"
				bind:value={q}
				on:input={onQuery}
			/>
			<label class="sort">
				<span>Sort</span>
				<select
					bind:value={sort}
					on:change={onSort}
				>
					{#each sortOptions as o}
						<option value={o.value}>{o.label}</option>
					{/each}
				</select>
			</label>
		</div>
	</header>

	<section class="grid">
		{#each items as item, i (item.browseId || item.videoId || item.title)}
			<div class="cell"><Listing data={item} index={i} /></div>
		{/each}
	</section>

	{#if loading}
		<p class="state">Loading…</p>
	{:else if items.length === 0}
		<p class="state">Nothing here yet.</p>
	{:else if done}
		<p class="state">End of list ({items.length})</p>
	{/if}
	<div
		bind:this={sentinel}
		class="sentinel"
	/>
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}
	h1 {
		display: inline;
		margin-right: 0.5rem;
	}
	.sub {
		color: #999;
		font-size: 0.95rem;
	}
	.controls {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}
	.filter {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 0.4rem;
		color: inherit;
		padding: 0.4rem 0.6rem;
		font-size: 0.95rem;
	}
	.sort {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		white-space: nowrap;
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
		text-align: center;
		color: #999;
		margin: 1.5rem 0;
	}
	.sentinel {
		height: 1px;
	}
	@media screen and (max-width: 37em) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
