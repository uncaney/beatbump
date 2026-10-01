<script lang="ts">
	import type { PageData } from "./$types";

	import { page } from "$app/stores";
	import Listing from "$components/Item/Listing.svelte";
	import VirtualList from "$lib/components/SearchList/VirtualList.svelte";
	import type { Item } from "$lib/types";
	import type { MusicShelf } from "$lib/types/musicShelf";

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

	// F1 (audit-features-v2): a filtered search answers with the paginated
	// YouTube shelf PLUS the owned-library shelf ("Your Library", `local: true`,
	// appended last by backend/api/search.go). Only the YouTube shelf feeds the
	// `search` store behind the VirtualList (continuation pages append to it);
	// every local shelf renders its own contents once, as a plain list, above it.
	// With filter=all every shelf already renders its own contents.
	function isLocalShelf(s: MusicShelf | undefined): boolean {
		return !!s && (s.local === true || s.header?.title === "Your Library");
	}
	$: ytShelf = filter !== "all" ? (results ?? []).find((s: MusicShelf) => !isLocalShelf(s)) : undefined;
	$: localShelves = filter !== "all" ? (results ?? []).filter(isLocalShelf) : [];
	const search = writable<Item[]>([]);
	$: filter !== "all" && search.set((ytShelf?.contents ?? []) as unknown as Item[]);

	// Audit v8 TOP 10: with filter=all a YouTube shelf could list an entry
	// twice ("Human After All" x2 in Albums) and the owned-library shelf
	// repeated rows already shown by YouTube. YouTube rows win; the "Song •"
	// rows and the inline suggestions (Search.svelte) are untouched.
	function itemKey(it: any): string {
		return String(it?.videoId || it?.browseId || it?.playlistId || "");
	}
	function dedupeShelves(shelves: MusicShelf[]): MusicShelf[] {
		const yt = new Set<string>();
		const uniq = (contents: any[], taken: Set<string>, collect?: Set<string>) => {
			const seen = new Set<string>();
			return (contents ?? []).filter((it) => {
				const k = itemKey(it);
				if (!k) return true;
				if (taken.has(k) || seen.has(k)) return false;
				seen.add(k);
				collect?.add(k);
				return true;
			});
		};
		const none = new Set<string>();
		const out = shelves.map((s) =>
			isLocalShelf(s) ? s : { ...s, contents: uniq(s.contents as any[], none, yt) },
		);
		return out
			.map((s) => (isLocalShelf(s) ? { ...s, contents: uniq(s.contents as any[], yt) } : s))
			.filter((s) => (s.contents?.length ?? 0) > 0);
	}
	$: allResults = filter === "all" ? dedupeShelves((results ?? []) as MusicShelf[]) : [];
	let ctoken = continuation?.continuation;
	let itct = continuation?.clickTrackingParams;
	let isLoading = false;
	let hasData = false;

	// EQ4: the owned-library shelf under a songs/albums/artists chip is capped
	// at 12 by the backend search shelf (backend/api/search.go, out of lane
	// scope). "Plus de résultats" pages past it straight against the
	// dedicated local/* endpoint (q + offset + limit, already supported) -
	// filter=all is untouched (harness).
	let libraryItems: any[] = [];
	let libraryOffset = 12;
	let libraryLoading = false;
	let libraryExhausted = false;
	function libraryEndpoint(f: string): string | null {
		if (f === "songs" || f === "") return "/api/v1/local/songs";
		if (f === "albums") return "/api/v1/local/albums";
		if (f === "artists") return "/api/v1/local/artists";
		return null;
	}
	async function loadMoreLibrary() {
		const ep = libraryEndpoint(filter);
		if (!ep || libraryLoading || libraryExhausted) return;
		libraryLoading = true;
		try {
			const res = await APIClient.fetch(
				`${ep}?q=${encodeURIComponent(query)}&offset=${libraryOffset}&limit=12`,
			);
			const more = await res.json();
			const items = Array.isArray(more.items) ? more.items : [];
			libraryItems = [...libraryItems, ...items];
			libraryOffset += items.length;
			if (items.length < 12) libraryExhausted = true;
		} catch (err) {
			console.error("library-more: failed", err);
		} finally {
			libraryLoading = false;
		}
	}
	// New shelf (query or chip changed): reset the extra page(s).
	$: {
		query;
		filter;
		libraryItems = [];
		libraryOffset = 12;
		libraryExhausted = false;
	}

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
		{#if filter !== "all"}
			{#each localShelves as shelf}
				<section class="container music-shelf local-shelf resp-content-width">
					<span class="h3">{shelf.header?.title}</span>
					<div class="music-shelf-list local-shelf-list">
						{#each shelf.contents as item}
							<Listing data={item} />
						{/each}
						{#each libraryItems as item}
							<Listing data={item} />
						{/each}
					</div>
					{#if libraryEndpoint(filter) && !libraryExhausted && (shelf.contents?.length ?? 0) + libraryItems.length >= 12}
						<button
							type="button"
							class="btn-reset btn-secondary library-more"
							data-testid="library-more"
							disabled={libraryLoading}
							on:click={loadMoreLibrary}
						>
							{libraryLoading ? "Chargement…" : "Plus de résultats"}
						</button>
					{/if}
				</section>
			{/each}
			{#if ytShelf}
				<div class="container music-shelf yt-shelf resp-content-width">
					<span class="h3">{ytShelf.header?.title}</span>
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
				</div>
			{/if}
		{:else}
			{#each allResults as result}
				<div class="container music-shelf resp-content-width">
					<span class="h3">{result.header.title}</span>
					<div class="music-shelf-list">
						{#each result.contents as item}
							<Listing data={item} />
						{/each}
					</div>
					{#if result.contents.length !== 1 && !isLocalShelf(result)}
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
				</div>
			{/each}
		{/if}
	{/key}
</main>

<style lang="scss">
	.h3 {
		font-weight: 600;
	}

	.search-head {
		// The header sits outside <main>, so it must clear the fixed top bar itself
		// (the global main rule pads by --top-bar-height + 2vh); main then only
		// keeps a small gap so the shelves start right under the chips.
		margin: 0 auto;
		padding-top: calc(var(--top-bar-height) + 1.25vh);
		display: flex;
		flex-direction: column;
		gap: 0.6em;
	}

	main {
		padding-block-start: 0.75em !important;
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
		/* Phones: 2.75rem is 33px with the 12px root size (audit v5 TOP 5). */
		@media screen and (max-width: 719px) {
			min-height: max(2.75rem, 44px);
		}
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

	// Filtered view: the local shelf (<= 12 owned hits) sits above the paginated
	// YouTube shelf, which takes the remaining height so the VirtualList keeps a
	// bounded scroll box for its end-of-list pagination.
	.parent.max-height {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.local-shelf {
		flex: 0 0 auto;
		max-height: 40%;
		margin-bottom: 1em;
		overflow-y: auto;
	}

	.local-shelf-list {
		height: auto;
		margin-bottom: 0;
	}

	.yt-shelf {
		flex: 1 1 auto;
		min-height: 0;
		height: auto;
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

	.library-more {
		margin: 0.5em 0 0;
		align-self: flex-start;
	}
	.library-more:disabled {
		cursor: progress;
	}
</style>
