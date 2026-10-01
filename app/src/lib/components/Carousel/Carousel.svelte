<svelte:options immutable={true} />

<script lang="ts">
	import { browser } from "$app/environment";
	import { page } from "$app/stores";
	import Icon from "$components/Icon/Icon.svelte";
	import type { CarouselHeader } from "$lib/types";
	import type { ICarouselTwoRowItem } from "$lib/types/musicCarouselTwoRowItem";
	import type { IListItemRenderer } from "$lib/types/musicListItemRenderer";
	import { onDestroy, onMount } from "svelte";
	import CarouselItem from "./CarouselItem.svelte";
	import observer from "./observer";

	export let header: CarouselHeader;
	export let items: (IListItemRenderer | ICarouselTwoRowItem)[] = [];
	export let type = "";
	export let kind = "normal";
	export let isBrowseEndpoint: boolean;
	export let visitorData = "";
	export let nofollow = false;
	// Optional explicit "see all" link (used by the personal rows on /home).
	export let seeAllHref = "";
	export let seeAllLabel = "See All";
	// Optional card width (any CSS length, e.g. "160px"), for narrow hosts such
	// as the 560px Related panel of the fullscreen player. The card is the
	// thumbnail plus the item's 0.75em padding each side (CarouselItem), so the
	// thumbnail is derived from it; empty = the responsive default.
	export let itemWidth = "";

	let moreOnLeft: boolean, moreOnRight: boolean;

	let clientWidth: number;
	let carousel: HTMLDivElement = undefined;

	let frame: number;
	let startTime: number;

	let hasScrollWidth = false;
	let isScrolling = false;

	const scrollPositions = {
		left: 0,
		width: -1,
		right: 0,
	};
	function scrollHandler(ts: number, context?: (any & "left") | "right") {
		if (!carousel) return;
		if (startTime === undefined) {
			startTime = ts;
		}
		const elapsed = ts - startTime;

		if (elapsed >= 32) {
			if (!hasScrollWidth && scrollPositions.width < 0) {
				hasScrollWidth = true;
				scrollPositions.width = carousel.scrollWidth;
			}

			const scrollLeft = carousel.scrollLeft;

			moreOnLeft = scrollLeft < 15 ? false : true;
			scrollPositions.left = scrollLeft;

			moreOnRight =
				scrollPositions.left < scrollPositions.width - clientWidth - 15
					? true
					: false;
			scrollPositions.right = scrollPositions.width - scrollLeft - 15;

			if (context === "left") {
				carousel.scrollLeft -= Math.ceil(
					(scrollPositions.width / items.length) * 2,
				);
			} else if (context === "right") {
				carousel.scrollLeft += Math.ceil(
					(scrollPositions.width / items.length) * 2,
				);
			}
			if (frame) cancelAnimationFrame(frame);
			frame = undefined;
			startTime = undefined;
			isScrolling = false;
			return;
		} else {
			frame = requestAnimationFrame((ts) => scrollHandler(ts, context));
		}
	}

	function onScroll(context?: any | "left" | "right") {
		if (frame) {
			return;
		}
		if (!carousel) return;
		if (!clientWidth) clientWidth = carousel.clientWidth;
		if (isScrolling) {
			cancelAnimationFrame(frame);
		} else {
			isScrolling = true;
		}

		requestAnimationFrame((ts) => scrollHandler(ts, context));
	}

	onMount(() => {
		if (carousel) {
			onScroll();
		}
	});

	onDestroy(() => {
		if (browser) {
			cancelAnimationFrame(frame);
			carousel = null;
			frame = null;
		}
	});

	const isArtistPage = $page.url.pathname.includes("/artist/");
	const urls = {
		playlist: `/playlist/${header?.browseId}`,
		trending: `/explore/${header?.browseId}${
			header?.params ? `?params=${header.params}` : ""
		}${header?.itct ? `&itct=${encodeURIComponent(header?.itct)}` : ""}`,
        trending2: `/trending/${header?.browseId}${
            header?.params ? `?params=${header.params}` : ""
        }${header?.itct ? `&itct=${encodeURIComponent(header?.itct)}` : ""}`,
		artist: `/artist/${header.browseId}?visitorData=${visitorData}&params=${header?.params}`,
	};

	let href =
            header?.browseId && isArtistPage
			? urls.artist
			: header.browseId?.includes("VLP") || header.title?.includes("Trending")
			? urls.playlist
            : header.browseId?.includes("FEmusic")
			? urls.trending2
            : urls.trending;
</script>

<div class="header resp-content-width">
	{#if header?.subheading}
		<p class="subheading">{header?.subheading}</p>
	{/if}
	<span class="h2">
		{header.title}
	</span>

	{#if seeAllHref}
		<a href={seeAllHref}>
			<small>{seeAllLabel}</small>
		</a>
	{:else if !header.title.includes("Videos") && header.browseId}
		<a href={href}>
			<small>See All</small>
		</a>
	{:else if isArtistPage && header.title.includes("Videos")}
		<a href={urls.playlist}>
			<small>See All</small>
		</a>
	{/if}
</div>
<div class="section">
	<button
		class="left"
		class:showMoreBtn={!moreOnLeft}
		type="button"
		aria-label="Défiler vers la gauche"
		on:click={() => {
			if (!items || scrollPositions.left <= 25) return;
			onScroll("left");
		}}
	>
		<Icon
			name="chevron-left"
			size="1.5em"
		/>
	</button>

	<button
		class="right"
		class:showMoreBtn={!moreOnRight}
		type="button"
		aria-label="Défiler vers la droite"
		on:click={() => {
			if (!items || scrollPositions.right <= 25) return;
			onScroll("right");
		}}
	>
		<Icon
			name="chevron-right"
			size="1.5em"
		/>
	</button>

	<div
		class="scroll"
		class:item-width={!!itemWidth}
		id="scrollItem"
		on:scroll={onScroll}
		bind:this={carousel}
		use:observer={{ items }}
		style:--thumbnail-size={itemWidth ? `calc(${itemWidth} - 1.5em)` : undefined}
		style:--column-width={itemWidth || undefined}
	>
		{#each items as item, index}
			{#if type === "trending"}
				<CarouselItem
					type="trending"
					{kind}
					aspectRatio={item.aspectRatio}
					{item}
					isBrowseEndpoint={!!item.endpoint}
					{nofollow}
					{index}
				/>
			{:else if type === "artist" || type === "home"}
				<CarouselItem
					{type}
					{kind}
					aspectRatio={item.aspectRatio}
					{nofollow}
					isBrowseEndpoint={!!item.endpoint}
					{item}
					{index}
				/>
			{:else if type === "new"}
				<CarouselItem
					type="new"
					aspectRatio={item.aspectRatio}
					{nofollow}
					{item}
					{index}
				/>
			{/if}
		{/each}
	</div>
</div>

<style lang="scss">
	@import "./index.scss";

	// Audit v7 TOP 8: when a host passes `itemWidth` (the ~560px fullscreen
	// Related panel), the card must really take that width. CarouselItem's
	// `article { flex: 0 1 }` collapses each card to its min-content (~139px)
	// even though `--column-width` is set, so the 160px request only reached the
	// thumbnail. Pin the article flex-basis + width to --column-width (this
	// selector outranks CarouselItem's `article`), and reserve a right gutter so
	// the last card clears the scroll arrow. Carousels without itemWidth are
	// untouched (the class is absent).
	.scroll.item-width {
		scroll-padding-inline-end: 40px;
		padding-inline-end: 2.5rem;

		:global(article) {
			flex: 0 0 var(--column-width, 160px);
			width: var(--column-width, 160px);
		}
	}
</style>
