<script lang="ts">
	import { page } from "$app/stores";
	import ArtistPageHeader from "$lib/components/ArtistPageHeader/ArtistPageHeader.svelte";
	import Carousel from "$lib/components/Carousel/Carousel.svelte";

	import Header from "$lib/components/Layouts/Header.svelte";
	import ListItem from "$lib/components/ListItem/ListItem.svelte";
	import { isPagePlaying } from "$lib/stores/stores";

	import Description from "$components/ArtistPageHeader/Description";
	import { CTX_ListItem } from "$lib/contexts";
	import type { ArtistPageBody } from "$lib/parsers/artist";
	import { isMobileMQ } from "$stores/window";
	import PlayAllBar from "$components/PlayAllBar/PlayAllBar.svelte";
	import { APIClient } from "$lib/api";
	import type { PageData } from "./$types";

	export let data: PageData;
	// MUST be reactive: navigating artist→artist re-runs load and changes `data`,
	// but `const` destructuring kept showing the FIRST artist clicked.
	$: ({ body, header, visitorData } = data);

	$: carousels = (body?.["carousels"] ?? []) as ArtistPageBody["carousels"];
	$: songs = (body?.["songs"] ?? []) as ArtistPageBody["songs"];

	$: id = $page.params.slug;

	// X1 / A2: a local artist (la-…) lists a preview of its titles; the API
	// adds the total and a seeAll link (/api/v1/local/songs?artist=…&limit=200).
	// "Voir les N titres" loads them in place; "Lire tout" / "Aléatoire" always
	// play every title, not the preview.
	$: localSongs = songs as typeof songs & {
		total?: number;
		seeAll?: { url?: string; title?: string; total?: number; artistTotal?: number; pages?: string[] };
	};
	$: seeAllUrl = localSongs?.seeAll?.url ?? "";
	// I19: the label counts the real total (`artistTotal`); `total` is only
	// what the first seeAll page holds (200).
	$: songsTotal = Math.max(
		Number(localSongs?.seeAll?.artistTotal) || 0,
		Number(localSongs?.total) || 0,
		songs?.items?.length ?? 0,
	);
	let allSongs: any[] | null = null;
	let allSongsFor = "";
	let loadingAll = false;
	// Navigating artist -> artist drops the previous full list.
	$: if (allSongsFor !== seeAllUrl) {
		allSongs = null;
		allSongsFor = seeAllUrl;
	}
	$: shownSongs = allSongs ?? songs?.items ?? [];

	async function fetchAllSongs(): Promise<any[]> {
		if (allSongs) return allSongs;
		const url = seeAllUrl;
		if (!url) return songs?.items ?? [];
		// I19: the seeAll link is one page of `limit`; `pages` (offset URLs
		// from the API) load the rest until `artistTotal`, so "Lire tout" /
		// "Voir les N titres" really covers every title.
		const see = localSongs?.seeAll;
		const seePages = see?.pages;
		const pages: string[] = Array.isArray(seePages) && seePages.length ? seePages : [url];
		const want = Number(see?.artistTotal) || 0;
		const items: any[] = [];
		const seen = new Set<string>();
		for (const pageUrl of pages) {
			if (want && items.length >= want) break;
			const res = await APIClient.fetch(pageUrl);
			if (!res.ok) throw new Error(`local songs ${res.status}`);
			const r = await res.json();
			const got: any[] = Array.isArray(r?.items) ? r.items : [];
			if (!got.length) break;
			for (const it of got) {
				const id = typeof it?.videoId === "string" ? it.videoId : "";
				if (id) {
					if (seen.has(id)) continue;
					seen.add(id);
				}
				items.push(it);
			}
		}
		if (url === seeAllUrl && items.length) allSongs = items;
		return items.length ? items : songs?.items ?? [];
	}

	async function showAllSongs() {
		if (loadingAll) return;
		loadingAll = true;
		try {
			await fetchAllSongs();
		} catch (err) {
			console.error("artist: full title list failed", err);
		} finally {
			loadingAll = false;
		}
	}

	let innerWidth = 640;

	CTX_ListItem.set({ page: "artist", innerWidth });

	//$: console.log(songs);
</script>

<Header
	title={header?.name === undefined ? "Artist" : header?.name}
	desc={header?.name}
	url={$page.url.pathname}
	image={header?.thumbnails && header?.thumbnails[0]?.url}
/>
<svelte:window bind:innerWidth />
{#key id}
<div class="fix-width">
	<!-- Follow is rendered by the header, in the Play Radio / Shuffle row (audit v3 1.6). -->
	<ArtistPageHeader
		description={header?.description}
		{header}
		thumbnail={header?.thumbnails}
		artistId={id}
	/>
	<main>
		<div class="artist-body">
			{#if songs?.items?.length > 0}
				<section class="song-list resp-content-width">
					<div class="header">
						<span class="h2">Songs</span>
                        {#if songs?.header?.browseId }
                            <a
                                style="white-space:pre; display: inline-block;"
                                href={`/playlist/${songs?.header?.browseId}?params=${songs?.header?.params}`}
                            ><small>See All</small></a>
                        {/if}

					</div>
					{#if seeAllUrl}
						<!-- J16: the context comes from the page header, not from the DOM. -->
						<PlayAllBar
							tracks={shownSongs}
							total={songsTotal}
							loadAll={fetchAllSongs}
							context={{ kind: "artist", title: String(header?.name ?? ""), href: $page.url.pathname }}
						/>
					{/if}
					<section class="songs">
						{#each shownSongs as item, idx}
							<ListItem
								{item}
								{idx}
								on:setPageIsPlaying={() => {
									isPagePlaying.add(id);
								}}
							/>
						{/each}
					</section>
					{#if seeAllUrl && !allSongs && songsTotal > (songs?.items?.length ?? 0)}
						<button
							type="button"
							class="see-all-titles"
							data-testid="see-all-titles"
							disabled={loadingAll}
							on:click={showAllSongs}
							>{loadingAll ? "Chargement…" : `Voir les ${songsTotal} titres`}</button
						>
					{/if}
				</section>
			{/if}
			{#each carousels as { items, header }, i}
				{#if i === carousels.length - 1}
					<Carousel
						{visitorData}
						items={items}
						type="artist"
						kind={header?.type}
						isBrowseEndpoint={true}
						{header}
						nofollow
					/>
				{:else}
					<Carousel
						items={items}
						{visitorData}
						type="artist"
						kind={header?.type}
						isBrowseEndpoint={false}
						{header}
						nofollow
					/>
				{/if}
			{/each}
			{#if $isMobileMQ && header?.description}
				<Description
					class="resp-content-width"
					description={header.description}
				/>
			{/if}
		</div>
	</main>
</div>
{/key}

<style lang="scss">
	@import "../../../../lib/components/ArtistPageHeader/index.scss";

	.song-list {
		margin-bottom: 3.3339em;
	}

	.content-wrapper {
		display: flex;
		margin: 0.5rem 0.7rem 0;
		width: auto;
		max-width: 9rem;
	}
	.fix-width {
		position: absolute;
		inset: 0;
	}

	.item-title {
		font-size: $size-1;
		cursor: pointer;
		margin: 0;
		padding: 0;
		width: 100%;
	}

	section {
	}

	.songs {
		margin-bottom: 1rem;
	}

	.see-all-titles {
		min-height: 2.5rem;
		padding: 0.45rem 1rem;
		border-radius: 2rem;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font-weight: 600;
		cursor: pointer;
		&:disabled {
			opacity: 0.6;
			cursor: progress;
		}
	}

	main {
		@include content-spacing($type: "padding");
		// The global `main` rule pads the top by the nav-bar height (+2vh) so
		// content clears the fixed top bar. Here the hero is above <main>, so
		// that padding was ~65px of dead space between Follow and "Songs"
		// (audit 1.5 / 2.1). Scoped selector + !important beats the global one.
		@media screen and (max-width: 719px) {
			padding-block-start: 0.5rem !important;
		}
	}

	.artist-body {
		padding: 1em 0 0;
		// padding-bottom: 2rem;padding-bottom
		@media screen and (max-width: 500px) {
			// padding: 0 1rem;padding
		}
	}
</style>
