<script lang="ts">
	import { browser } from "$app/environment";
	import Carousel from "$components/Carousel/Carousel.svelte";
	import Header from "$lib/components/Layouts/Header.svelte";


	import Icon from "$components/Icon/Icon.svelte";

	export let data;
	const { carousels, page: path } = data;
	$: browser && console.log(data);

	// Moods & genres grid (desktop): flags the wrapper when the row can still
	// scroll right, which drives the right-edge fade + the arrow button (audit
	// 1.2 / TOP 10 #9). Mobile stacks the grid vertically, nothing to flag.
	function moodsEdge(node: HTMLElement) {
		const parent = node.parentElement;
		const update = () => {
			const canScroll = node.scrollWidth - node.clientWidth > 2;
			const atEnd = node.scrollLeft + node.clientWidth >= node.scrollWidth - 2;
			parent?.classList.toggle("moods-scrollable", canScroll);
			parent?.classList.toggle("moods-at-end", !canScroll || atEnd);
		};
		node.addEventListener("scroll", update, { passive: true });
		window.addEventListener("resize", update);
		const raf = requestAnimationFrame(update);
		return {
			destroy() {
				cancelAnimationFrame(raf);
				node.removeEventListener("scroll", update);
				window.removeEventListener("resize", update);
			},
		};
	}
	function scrollMoods(e: MouseEvent) {
		const box = (e.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(".box");
		box?.scrollBy({ left: box.clientWidth * 0.8, behavior: "smooth" });
	}
</script>

<Header
	title="Trending"
	url={path}
	desc="The latest trending songs and releases"
/>
<main data-testid="trending">
	{#each carousels as carousel (carousel)}
		{#if carousel.items}
			<Carousel
				isBrowseEndpoint={false}
				header={carousel.header}
				items={carousel.items}
				type="trending"
				kind="isPlaylist"
			/>
		{:else if carousel.categories}
			<div class="breakout">
				<div class="header resp-content-width">
					<span class="h2">{carousel.header.title}</span>
					<a
						class="link"
						href="/explore"><small>See All</small></a
					>
				</div>
				<div
					class="box resp-content-width"
					use:moodsEdge
				>
					<div class="scroll">
						{#each carousel.categories as item}
							<a
								style="--color: {item?.color}"
								class="item-box"
								href="/explore/{item?.endpoint?.params}">{item?.text}</a
							>
						{/each}
					</div>
				</div>
				<button
					class="scroll-btn"
					aria-label="Faire défiler"
					title="Faire défiler"
					on:click={scrollMoods}
				>
					<Icon
						name="chevron-right"
						size="1.5em"
					/>
				</button>
			</div>
		{/if}
	{/each}
</main>

<style lang="scss">
	a small {
		$color: rgb(175 175 175);

		/* Same "See All" as the Carousel header (audit v5 TOP 7): normal caps at
		   13px in a 28px box, not 7px-tall petite caps. */
		display: inline-flex;
		align-items: center;
		box-sizing: border-box;
		min-height: 28px;
		padding: 0.25rem 0;
		font-size: max(0.8125rem, 13px);
		font-weight: 700;
		font-variant-caps: normal;
		text-transform: none;
		letter-spacing: 0;
		transition: ease-in color 75ms;
		color: $color;

		&:hover {
			color: lighten($color, 30%);
			text-decoration: underline 0.001rem solid;
			text-underline-offset: 0.001rem;
		}
	}

	.breakout {
		border-radius: 0.8rem;
		-webkit-overflow-scrolling: touch;
		position: relative;
		// Same section rhythm as the Home / trending carousels (Carousel
		// .section: 2.4em under 720px, 1em above): removes the 100px dead band
		// before "Moods & genres" (audit 1.2).
		margin-bottom: 2.4em;

		@media screen and (min-width: 720px) {
			margin-bottom: 1em;
		}
	}

	.box {
		display: flex;
		width: 100%;
		overflow-x: auto;
		padding: 0.8rem;
		contain: content;
		flex-direction: column;
		// Desktop: the grid is a horizontally scrolling column-flow; a
		// right-edge fade says "more to the right" until the end is reached.
		@media screen and (min-width: 720px) {
			scrollbar-width: none;
			&::-webkit-scrollbar {
				display: none;
			}
			:global(.moods-scrollable:not(.moods-at-end)) > & {
				-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 6rem), transparent);
				mask-image: linear-gradient(to right, #000 calc(100% - 6rem), transparent);
			}
		}
		// Mobile: no horizontal clipping, 2 full-width columns, vertical flow.
		@media screen and (max-width: 719px) {
			overflow: visible;
			padding: 0;
		}
	}

	.scroll {
		display: flex;
		flex-flow: column wrap;
		gap: 0.8rem;
		justify-content: space-around;
		//
		max-height: calc(100vh - 1px - calc(100vh - 23em));

		@media screen and (max-width: 719px) {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 0.6rem;
			max-height: none;
		}
	}

	// Same round arrow as the carousels (Carousel/index.scss .right), shown on
	// desktop only while the row can still scroll.
	.scroll-btn {
		display: none;
		position: absolute;
		right: 0;
		top: 50%;
		transform: translate(1.75em, -50%);
		z-index: 1;
		width: 3rem;
		height: 3rem;
		padding: 0;
		border-radius: 50%;
		cursor: pointer;
		align-items: center;
		justify-content: center;
		color: rgb(3, 3, 3);
		background-color: hsla(0, 0%, 95%, 0.715);
		border: rgba(0, 0, 0, 0.171) 0.33px solid;
		box-shadow: 0 0 8px -4px hsl(0deg 0% 0% / 20%), inset 0 0 8px -4px hsl(0deg 0% 0% / 20%);
		transition: background-color 200ms cubic-bezier(0.22, 0.61, 0.36, 1);
		&:hover {
			background-color: rgb(233, 233, 233);
		}
		@media screen and (min-width: 720px) and (max-width: 1000px) {
			transform: translate(0, -50%);
		}
	}
	@media screen and (min-width: 720px) {
		:global(.breakout.moods-scrollable:not(.moods-at-end)) > .scroll-btn {
			display: inline-flex;
		}
	}

	.item-box {
		cursor: pointer;
		background: #2727298a;
		display: flex;
		justify-content: flex-start;
		flex-flow: row nowrap;
		text-overflow: clip;
		width: clamp(12em, 13em, 15em);
		contain: content;
		border-radius: 0.3em;
		font-family: "Commissioner Variable", sans-serif;
		border-left: 0.5rem solid var(--color, red);
		align-items: center;
		height: 3.25em;
		padding: 0 0 0 0.8rem;

		@media screen and (max-width: 719px) {
			width: auto;
			min-width: 0;
			height: auto;
			min-height: 44px;
		}
	}
</style>
