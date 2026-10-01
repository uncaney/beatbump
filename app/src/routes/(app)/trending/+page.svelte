<script lang="ts">
	import { browser } from "$app/environment";
	import Carousel from "$components/Carousel/Carousel.svelte";
	import Header from "$lib/components/Layouts/Header.svelte";


	import Icon from "$components/Icon/Icon.svelte";
	import { playTracks } from "$components/PlayAllBar/PlayAllBar.svelte";
	import { APIClient } from "$lib/api";
	import { localGenreLinks, type LocalGenreLink } from "$lib/localGenres";
	import { notify } from "$lib/utils";
	import { onMount } from "svelte";

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
	// c29b EQ2 "Dans ta bibliothèque": up to 12 local genres (the same
	// local/genres answer /library/genres renders) as links to the all-songs
	// genre view. Client-only, after mount, hidden until loaded and when the
	// library has no genre; the YouTube rows above never wait on it.
	let localGenres: LocalGenreLink[] = [];
	onMount(async () => {
		try {
			const res = await APIClient.fetch("/api/v1/local/genres");
			if (res.ok) localGenres = localGenreLinks(await res.json());
		} catch {
			localGenres = [];
		}
	});

	// F6: the chips keep linking to the genre LIST; one play button next to
	// the section title starts a Mix of the first (biggest) genre: 40 sampled
	// tracks from local/mix, or, when that genre spans too few albums for a
	// mix (L8-6), its first 200 tracks like "Lire" on /library/genres.
	let genreBusy = false;
	async function playFirstGenre() {
		const g = localGenres[0];
		if (!g || genreBusy) return;
		genreBusy = true;
		try {
			const name = encodeURIComponent(g.name);
			let items: any[] = [];
			const mix = await APIClient.fetch(`/api/v1/local/mix?genre=${name}`);
			if (mix.ok) {
				const d = await mix.json();
				items = Array.isArray(d?.items) ? d.items : [];
			}
			if (!items.length) {
				const songs = await APIClient.fetch(`/api/v1/local/songs?genre=${name}&limit=200`);
				if (songs.ok) {
					const d = await songs.json();
					items = Array.isArray(d?.items) ? d.items : [];
				}
			}
			const n = await playTracks(items, { context: { kind: "genre", title: g.name, href: "/library/mixes" } });
			if (!n) notify(`Aucun morceau lisible pour « ${g.name} »`, "error");
		} catch (err) {
			console.error("explore-genre-play: failed", err);
			notify("Lecture impossible pour l'instant", "error");
		} finally {
			genreBusy = false;
		}
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
	{#if localGenres.length > 0}
		<section
			class="local-genres breakout"
			data-testid="explore-local-genres"
		>
			<div class="header resp-content-width">
				<span class="h2">Dans ta bibliothèque</span>
				<button
					type="button"
					class="btn-reset btn-secondary genre-play"
					data-testid="explore-genre-play"
					disabled={genreBusy}
					title={`Lancer un mix ${localGenres[0]?.name ?? ""}`}
					aria-label={`Lancer un mix ${localGenres[0]?.name ?? ""}`}
					on:click={playFirstGenre}
				>
					<Icon
						name="play"
						size="1em"
					/>
					<span>Mix {localGenres[0]?.name ?? ""}</span>
				</button>
				<a
					class="link"
					href="/library/genres"><small>Tous les genres</small></a
				>
			</div>
			<ul class="genre-list resp-content-width">
				{#each localGenres as g (g.name)}
					<li>
						<a
							class="genre-chip"
							href={g.href}
							data-genre={g.name}
						>
							<span class="genre-name">{g.name}</span>
							{#if g.count > 0}<span class="genre-count">{g.count}</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</main>

<style lang="scss">
	/* U12-10: the anchor itself is the 44 px hit box ("See All" was 39x28);
	   negative block margins keep the header row's 28 px rhythm. */
	a.link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-height: max(2.75rem, 44px);
		min-width: max(2.75rem, 44px);
		margin-block: calc((28px - max(2.75rem, 44px)) / 2);
		padding-inline: 0.25rem;
		vertical-align: middle;
	}
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

	// F6: "Mix <genre>" play button between the title and "Tous les genres".
	.genre-play {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		margin-inline: auto 0.75rem;
		white-space: nowrap;
		&:disabled {
			cursor: progress;
		}
	}

	// c29b EQ2: library genre chips, same section rhythm as the moods grid.
	.genre-list {
		list-style: none;
		margin: 0;
		padding: 0.8rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;

		@media screen and (max-width: 719px) {
			padding: 0;
		}
	}
	.genre-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: max(2.75rem, 44px);
		padding: 0.4rem 0.9rem;
		border-radius: 1.4rem;
		background: #2727298a;
		border-left: 0.5rem solid hsl(150deg 50% 50%);
		color: inherit;
		text-decoration: none;
		font-family: "Commissioner Variable", sans-serif;
		transition: background-color 120ms ease;

		&:hover {
			background: #3a3a3cb0;
		}
	}
	.genre-count {
		color: #b3b3b3;
		font-size: var(--text-secondary-size);
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
