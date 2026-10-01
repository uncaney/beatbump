<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import { page } from "$app/stores";
	import { APIClient } from "$lib/api";
	import {
		AZ_LETTERS,
		findLetterIndex,
		initialOf,
		isTitleSort,
		loadSortPrefs,
		saveSortPrefs,
		seekShouldContinue,
	} from "$lib/utils/sortMemory";
	import { onMount, tick } from "svelte";
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
	// BI2: an A-Z seek loads bigger pages (server cap) to reach the letter fast.
	const seekLimit = 200;
	let loading = false;
	let done = false;
	let sentinel: HTMLDivElement;
	let grid: HTMLElement;

	// BI2: sort + filter remembered per route (localStorage ytm-sort:<pathname>).
	$: pathname = $page.url.pathname;
	$: canIndex = (kind === "albums" || kind === "artists") && isTitleSort(kind, sort);
	$: sortDesc = sort.endsWith(":desc");
	let seeking = "";
	let activeLetter = "";

	async function load(reset = false, pageSize = limit) {
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
				`&offset=${offset}&limit=${pageSize}` +
				(q ? `&q=${encodeURIComponent(q)}` : "") +
				extraParams;
			const res = await APIClient.fetch(url);
			const data = await res.json();
			const got = Array.isArray(data.items) ? data.items : [];
			items = reset ? got : [...items, ...got];
			total = data.total ?? items.length;
			offset += got.length;
			done = got.length < pageSize || offset >= total;
		} catch (err) {
			console.error("collection load failed", err);
			done = true;
		}
		loading = false;
	}

	let debounce: ReturnType<typeof setTimeout>;
	function onQuery() {
		clearTimeout(debounce);
		saveSortPrefs(pathname, { sort, q });
		debounce = setTimeout(() => load(true), 250);
	}
	function onSort(e: Event) {
		sort = (e.target as HTMLSelectElement).value;
		saveSortPrefs(pathname, { sort, q });
		activeLetter = "";
		load(true);
	}

	/** Scroll the first loaded row of `letter` into view; false when none is loaded. */
	async function scrollToLetter(letter: string): Promise<boolean> {
		const idx = findLetterIndex(items, letter);
		if (idx < 0) return false;
		await tick();
		const cell = grid?.querySelector<HTMLElement>(`[data-initial="${letter === "#" ? "#" : letter}"]`);
		if (!cell) return false;
		cell.scrollIntoView({ block: "start", behavior: "smooth" });
		activeLetter = letter;
		return true;
	}

	/**
	 * BI2 A-Z index: jump to the first row starting with `letter`. The list is
	 * paginated server side (60 per page, infinite scroll), so when the letter
	 * is not loaded yet the next pages are fetched (200 at a time) until it
	 * shows up or the list went past it, then the row is scrolled into view.
	 */
	async function jumpTo(letter: string) {
		if (seeking) return;
		if (await scrollToLetter(letter)) return;
		seeking = letter;
		try {
			while (!done && seekShouldContinue(items, letter, sortDesc)) {
				if (loading) await new Promise((r) => setTimeout(r, 50));
				else await load(false, seekLimit);
				if (findLetterIndex(items, letter) >= 0) break;
			}
			if (!(await scrollToLetter(letter))) activeLetter = "";
		} finally {
			seeking = "";
		}
	}

	onMount(() => {
		const prefs = loadSortPrefs(
			pathname,
			sortOptions.map((o) => o.value),
			sortOptions[0].value,
		);
		sort = prefs.sort;
		q = prefs.q;
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
					data-testid="browse-sort"
				>
					{#each sortOptions as o}
						<option value={o.value}>{o.label}</option>
					{/each}
				</select>
			</label>
		</div>
	</header>

	{#if canIndex}
		<nav
			class="az-index"
			data-testid="az-index"
			aria-label="Index alphabétique"
			aria-busy={!!seeking}
		>
			{#each AZ_LETTERS as letter}
				<button
					type="button"
					class="btn-reset az-letter"
					class:active={letter === activeLetter}
					class:seeking={letter === seeking}
					aria-label="Aller à {letter === '#' ? 'autres' : letter}"
					aria-current={letter === activeLetter ? "true" : undefined}
					disabled={!!seeking}
					on:click={() => jumpTo(letter)}>{letter}</button
				>
			{/each}
		</nav>
	{/if}

	<section
		class="grid"
		bind:this={grid}
	>
		{#each items as item, i (item.browseId || item.videoId || item.title)}
			<div
				class="cell"
				data-initial={canIndex ? initialOf(item.title) : undefined}
			>
				<Listing data={item} index={i} />
			</div>
		{/each}
	</section>

	{#if seeking}
		<p class="state">Recherche de « {seeking} »…</p>
	{:else if loading}
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
	// BI2: A-Z index. Phones only (the desktop list is a short scroll with a
	// filter box): one sticky row of 44px letter buttons that scrolls
	// sideways, so a tap target never shrinks below the floor.
	.az-index {
		display: none;
	}
	.grid {
		display: grid;
		// 18rem cells: 3 columns in the 1020px content column at 1280px
		// (audit v8 TOP 6: 4 x 255px left ~100px of title, 9/32 clipped).
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		gap: 0.25rem 1rem;
	}
	.cell {
		min-width: 0;
		scroll-margin-top: calc(max(2.75rem, 44px) + 0.75rem);
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
		.az-index {
			display: flex;
			gap: 0.15rem;
			position: sticky;
			top: 0;
			z-index: 5;
			margin: 0 -1rem 0.5rem;
			padding: 0.25rem 1rem;
			overflow-x: auto;
			scrollbar-width: none;
			background: var(--base-bg, #0f0f0f);
			border-bottom: 1px solid rgba(255, 255, 255, 0.08);
			&::-webkit-scrollbar {
				display: none;
			}
		}
		.az-letter {
			flex: none;
			min-width: max(2.75rem, 44px);
			min-height: max(2.75rem, 44px);
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border-radius: 999px;
			font-weight: 600;
			font-size: 1.05rem;
			color: inherit;
			background: transparent;
			border: 1px solid transparent;
			cursor: pointer;
			&.active {
				background: rgba(255, 255, 255, 0.14);
				border-color: rgba(255, 255, 255, 0.25);
			}
			&.seeking {
				opacity: 0.6;
			}
			&:disabled:not(.seeking) {
				opacity: 0.35;
			}
			&:focus-visible {
				outline: 2px solid #fff;
				outline-offset: 2px;
			}
		}
	}
</style>
