<script lang="ts">
	// c29b D1 "Mixes": decade and genre mixes built from the owned library.
	// Cards come from GET /api/v1/local/mixes (decades with >= 15 albums,
	// genres with >= 200 tracks); a tap loads 40 sampled tracks from
	// GET /api/v1/local/mix?decade=|genre= into the queue through the shared
	// PlayAllBar.playTracks, context "Décennie : Années 1990" / "Genre : Rock".
	// The page shows nothing but its empty state when the library has no
	// slice big enough for a mix.
	import { APIClient } from "$lib/api";
	import { playTracks } from "$components/PlayAllBar/PlayAllBar.svelte";
	import { mixCardsFrom, type MixCard } from "$lib/mixes";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let cards: MixCard[] = [];
	let loading = true;
	/** Key of the card currently loading its queue (disables that card only). */
	let busyKey = "";
	/** Key of the last card whose mix came back too small ("too_small"). */
	let tooSmallKey = "";

	$: decades = cards.filter((c) => c.kind === "decade");
	$: genres = cards.filter((c) => c.kind === "genre");

	onMount(async () => {
		try {
			const res = await APIClient.fetch("/api/v1/local/mixes");
			if (res.ok) cards = mixCardsFrom(await res.json());
		} catch (err) {
			console.error("mixes load failed", err);
		}
		loading = false;
	});

	async function playMix(card: MixCard) {
		if (busyKey) return;
		busyKey = card.key;
		tooSmallKey = "";
		try {
			const res = await APIClient.fetch(`/api/v1/local/mix?${card.query}`);
			if (!res.ok) return;
			const data = await res.json();
			const items = Array.isArray(data?.items) ? data.items : [];
			if (!items.length) {
				tooSmallKey = card.key;
				return;
			}
			await playTracks(items, {
				context: { kind: card.kind === "decade" ? "decade" : "genre", title: card.title, href: "/library/mixes" },
			});
		} catch (err) {
			console.error("mix play failed", err);
		} finally {
			busyKey = "";
		}
	}
</script>

<main>
	<CollectionNav active="mixes" />
	<header class="head">
		<h1>Mixes</h1>
		<span class="sub">40 titres tirés de ta bibliothèque, par décennie ou par genre</span>
	</header>

	{#if loading}
		<p class="state">Chargement…</p>
	{:else if cards.length === 0}
		<p
			class="state"
			data-testid="mixes-empty"
		>
			Pas encore assez d'albums pour un mix : il en faut 15 d'une même décennie, ou 200 titres d'un même genre.
		</p>
	{:else}
		{#if decades.length > 0}
			<section
				class="group"
				data-testid="mixes-decades"
			>
				<h2>Décennies</h2>
				<div class="grid">
					{#each decades as card (card.key)}
						<button
							type="button"
							class="btn-reset mix-card is-decade"
							data-testid="mix-card"
							data-mix={card.key}
							disabled={busyKey === card.key}
							aria-label={`Lire le mix ${card.title}`}
							on:click={() => playMix(card)}
						>
							<span class="mix-title">{card.title}</span>
							<span class="mix-sub">{tooSmallKey === card.key ? "Pas assez d'albums" : card.subtitle}</span>
						</button>
					{/each}
				</div>
			</section>
		{/if}
		{#if genres.length > 0}
			<section
				class="group"
				data-testid="mixes-genres"
			>
				<h2>Genres</h2>
				<div class="grid">
					{#each genres as card (card.key)}
						<button
							type="button"
							class="btn-reset mix-card is-genre"
							data-testid="mix-card"
							data-mix={card.key}
							disabled={busyKey === card.key}
							aria-label={`Lire le mix ${card.title}`}
							on:click={() => playMix(card)}
						>
							<span class="mix-title">{card.title}</span>
							<span class="mix-sub">{tooSmallKey === card.key ? "Pas assez d'albums" : card.subtitle}</span>
						</button>
					{/each}
				</div>
			</section>
		{/if}
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
		gap: 0.25rem 1rem;
		align-items: baseline;
		margin-bottom: 1rem;
	}
	.sub {
		color: #999;
	}
	.group {
		margin-bottom: 1.75rem;
	}
	h2 {
		font-size: 1.1em;
		margin: 0 0 0.6rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
		gap: 0.6rem;
	}
	/* Tap target: 44px floor on phones (root 12px), cards grow with content. */
	.mix-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: flex-end;
		gap: 0.2rem;
		min-height: max(5.5rem, 44px);
		padding: 0.8rem 0.9rem;
		border-radius: 0.8rem;
		text-align: left;
		color: inherit;
		background: linear-gradient(160deg, hsl(0deg 0% 100% / 12%), hsl(0deg 0% 100% / 5%));
		border-left: 0.35rem solid hsl(210deg 70% 60%);
		cursor: pointer;
		transition: background 120ms ease;
	}
	.mix-card.is-genre {
		border-left-color: hsl(330deg 60% 60%);
	}
	.mix-card:hover {
		background: linear-gradient(160deg, hsl(0deg 0% 100% / 20%), hsl(0deg 0% 100% / 9%));
	}
	.mix-card:disabled {
		cursor: progress;
		opacity: 0.7;
	}
	.mix-title {
		font-weight: 600;
		font-size: 1.05em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}
	.mix-sub {
		color: #aaa;
		font-size: 0.85em;
	}
	.state {
		text-align: center;
		color: #999;
		margin: 2rem 0;
	}
</style>
