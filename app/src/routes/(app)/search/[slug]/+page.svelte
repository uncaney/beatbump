<script lang="ts">
	import type { PageData } from "./$types";

	import { page } from "$app/stores";
	import Listing from "$components/Item/Listing.svelte";
	import VirtualList from "$lib/components/SearchList/VirtualList.svelte";
	import type { Item } from "$lib/types";

	import Header from "$lib/components/Layouts/Header.svelte";

	import { afterNavigate, goto } from "$app/navigation";
	import { writable } from "svelte/store";
    import {APIClient} from "$lib/api";

	export let data: PageData;
	$: ({ results, continuation, filter } = data);

	// Query echo + filter chips (audit-ux-v2 1.3 / TOP 10 #7). The `?filter=`
	// values are the ones the backend search endpoint already accepts
	// (backend/api/search.go: all, songs, albums, artists, all_playlists, ...).
	// "Playlists" maps to all_playlists; the sub-filters featured_playlists /
	// community_playlists (reachable from "Show All") highlight that same chip.
	const filterChips: { label: string; value: string }[] = [
		{ label: "Tout", value: "all" },
		{ label: "Titres", value: "songs" },
		{ label: "Albums", value: "albums" },
		{ label: "Artistes", value: "artists" },
		{ label: "Playlists", value: "all_playlists" },
	];
	// SvelteKit params are already decoded; a stray "%" in the query would make
	// decodeURIComponent throw, so decode defensively.
	function safeDecode(s: string) {
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	}
	$: query = safeDecode($page.params.slug ?? "");
	$: activeFilter = (filter || "all").toLowerCase();
	$: restricted = $page.url.searchParams.get("restricted") || "";
	function chipHref(value: string) {
		return (
			`/search/${encodeURIComponent(query)}?filter=${encodeURIComponent(value)}` +
			(restricted ? `&restricted=${encodeURIComponent(restricted)}` : "")
		);
	}
	function isActive(value: string) {
		if (value === "all_playlists") return activeFilter.endsWith("playlists");
		return activeFilter === value;
	}

	const search = writable<Item[]>();
	$: results && filter !== "all" && search.set(results[0].contents);
	let ctoken = continuation?.continuation;
	let itct = continuation?.clickTrackingParams;
	let isLoading = false;
	let hasData = false;

	// export const snapshot = {
	// 	capture() {
	// 		return {
	// 			search: $search,
	// 			ctoken,
	// 			results,
	// 			itct,
	// 			hasData,
	// 			start,
	// 			end,
	// 		};
	// 	},
	// 	restore(snapshot) {
	// 		console.log(snapshot);
	// 		let s: typeof $search | [] = [];

	// 		({ search: s, results, ctoken, itct, hasData, start, end } = snapshot);
	// 		search.set(s);
	// 		if (results) results = [...results];
	// 	},
	// };
	async function paginate() {
		if (isLoading || hasData) return;
		try {
			isLoading = true;
			const response = await APIClient.fetch(
                `/api/v1/search.json?q=` +
					`&filter=` +
					filter +
					`&itct=${itct}${ctoken ? `&ctoken=${ctoken}` : ""}`,
			);
			const newPage = await response.json();
			const res: PageData = await newPage;

			if (res.continuation.continuation) {
				ctoken = res.continuation.continuation;
				itct = res.continuation.clickTrackingParams;
				search.update((u) => [...u, ...(res.results as unknown as Item[])]);
				isLoading = false;
				hasData = newPage.length === 0;
				return hasData;
			}
			return !isLoading;
		} catch (error) {
			hasData = null;
			isLoading = false;
			return {
				error: new Error(error + " Unable to get more!"),
			};
		}
	}
	// $: console.log($search, results, data.response);
	// $: console.log(results);
	afterNavigate(async ({ from, to }) => {
		if (to.url.pathname.includes("/search")) {
			results = data.results;
			filter = data.filter;
			ctoken = data?.continuation?.continuation;
			itct = data?.continuation?.clickTrackingParams;
		}
	});
</script>

<Header
	title="Search"
	desc={`Search results for ${decodeURIComponent($page.params.slug)}`}
	url={$page.url.pathname}
/>

<header class="search-head resp-content-width">
	<h1 class="search-title">Résultats pour « {query} »</h1>
	<nav
		class="filters"
		aria-label="Filtrer les résultats"
	>
		{#each filterChips as c (c.value)}
			<a
				class="chip"
				class:selected={isActive(c.value)}
				aria-current={isActive(c.value) ? "page" : undefined}
				href={chipHref(c.value)}
				on:click|preventDefault={() => goto(chipHref(c.value))}>{c.label}</a
			>
		{/each}
	</nav>
</header>

{#if data.correction && (data.correction.correctedQuery || data.correction.showingResultsFor)}
	<div class="search-correction resp-content-width">
		<span
			>Showing results for
			<strong>{data.correction.correctedQuery || data.correction.showingResultsFor}</strong></span
		>
		{#if data.correction.originalQuery}
			<a
				class="link secondary"
				href={`/search/${encodeURIComponent(data.correction.originalQuery)}?filter=${filter}`}
				>Search instead for {data.correction.originalQuery}</a
			>
		{/if}
	</div>
{/if}

<main
	class="parent"
	class:max-height={filter !== "all"}
>
	{#key data}
		{#each results as result}
			<div
				class="container music-shelf resp-content-width"
				class:max-height={filter !== "all"}
			>
				<span class="h3">{result.header.title}</span>
				{#if filter !== "all"}
					<div
						class="music-shelf-list"
						style:margin-bottom|important={0}
					>
						<VirtualList
							on:endList={() => {
								queueMicrotask(paginate);
							}}
							bind:isLoading
							bind:hasData
							height="calc(100% - 2.75em)"
							items={$search}
							let:item
						>
							<Listing data={item} />
						</VirtualList>
					</div>
				{:else}
					<div class="music-shelf-list">
						{#each result.contents as item}
							<Listing data={item} />
						{/each}
					</div>
					{#if result.contents.length !== 1}
						<div class="show-more">
							<a
								data-testid=""
								href={`${$page.params.slug}?filter=${result.header.title
									.replace(/\s/g, "_")
									.toLowerCase()}`}
								class="link secondary">Show All</a
							>
						</div>
					{/if}
				{/if}
			</div>
		{/each}
	{/key}
</main>

<style lang="scss">
	.h3 {
		font-weight: 600;
	}

	.search-head {
		margin: 0.75em auto 0;
		display: flex;
		flex-direction: column;
		gap: 0.6em;
	}

	.search-title {
		margin: 0;
		font-size: 1.35rem;
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	// Filter chips: same look as the home chips (lib/components/Chips), 44px
	// tall for touch, horizontally scrollable on narrow screens.
	.filters {
		display: flex;
		gap: 0.5em;
		overflow-x: auto;
		padding-bottom: 0.125em;
		scroll-behavior: smooth;
		&::-webkit-scrollbar {
			display: none;
		}
	}

	.chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		flex: 0 0 auto;
		min-height: 2.75rem;
		padding: 0.5em 1em;
		border-radius: 999rem;
		background: rgba(255, 255, 255, 0.1);
		color: #fff;
		font-size: 1rem;
		font-weight: 500;
		text-decoration: none;
		text-transform: none;
		white-space: nowrap;
		&:hover {
			background: rgba(255, 255, 255, 0.18);
		}
		&:focus-visible {
			outline: 2px solid #1ed760;
			outline-offset: 2px;
		}
		&.selected {
			background: #fff;
			color: #131313;
			font-weight: 600;
		}
	}

	.search-correction {
		margin: 0.75em auto 0.25em;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25em 0.75em;
		font-size: 0.95em;
		color: var(--text-secondary);
	}

	.search-correction .link {
		text-transform: none;
	}

	.max-height {
		height: calc(100% - var(--player-bar-height) + var(--top-bar-height));
	}

	.music-shelf {
		margin-bottom: 3.333em;
		margin-top: 0.666em;
		max-height: 100%;
		display: flex;
	}

	.music-shelf-list {
		max-height: 100%;
		height: 100%;
		margin-bottom: 1.333em;
	}

	.link {
		text-transform: uppercase;
	}
</style>
