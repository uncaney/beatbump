<script lang="ts">
	// c29b D1 "Mixes": decade and genre mixes built from the owned library.
	// Cards come from GET /api/v1/local/mixes (decades with >= 15 albums,
	// genres with >= 200 tracks on >= 15 albums, L8-6); a tap loads 40 sampled
	// tracks from GET /api/v1/local/mix?decade=|genre= into the queue through
	// the shared PlayAllBar.playTracks, context "Décennie : Années 1990" /
	// "Genre : Rock". The page shows nothing but its empty state when the
	// library has no slice big enough for a mix.
	// D7 "Tes artistes": one card per local top artist of the profile
	// (me/stats/top?by=artists, 365 days), playing the EQ1 seeded radio
	// local/related?seed=artist:<id>, context "Radio : <name>"; hidden for a
	// profile without local plays (anonymous included).
	// HL6: every card carries "Garder hors-ligne" [mix-keep] (KeepOfflineButton
	// with a loader: the same endpoint as the tap, so the 40 sampled tracks /
	// the artist radio are downloaded and pinned as a travel pack).
	import { APIClient } from "$lib/api";
	import { playTracks } from "$components/PlayAllBar/PlayAllBar.svelte";
	import KeepOfflineButton from "$lib/components/ListItem/KeepOfflineButton.svelte";
	import { getTopBy } from "$lib/me";
	import { artistCardsFrom, mixCardUrl, mixCardsFrom, type MixCard } from "$lib/mixes";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let cards: MixCard[] = [];
	let artistCards: MixCard[] = [];
	let loading = true;
	/** Key of the card currently loading its queue (disables that card only). */
	let busyKey = "";
	/** Key of the last card whose mix came back too small ("too_small"). */
	let tooSmallKey = "";

	$: decades = cards.filter((c) => c.kind === "decade");
	$: genres = cards.filter((c) => c.kind === "genre");
	$: empty = cards.length === 0 && artistCards.length === 0;

	onMount(async () => {
		const [mixes, top] = await Promise.all([
			APIClient.fetch("/api/v1/local/mixes")
				.then(async (res) => (res.ok ? res.json() : null))
				.catch((err) => {
					console.error("mixes load failed", err);
					return null;
				}),
			getTopBy("artists", 365, 20).catch((err) => {
				console.error("top artists load failed", err);
				return null;
			}),
		]);
		cards = mixCardsFrom(mixes);
		artistCards = artistCardsFrom(top);
		loading = false;
	});

	/** The tracks a card plays / keeps: [] when the slice is too small. */
	async function loadCard(card: MixCard): Promise<any[]> {
		const res = await APIClient.fetch(mixCardUrl(card));
		if (!res.ok) return [];
		const data = await res.json();
		return Array.isArray(data?.items) ? data.items : [];
	}

	async function playMix(card: MixCard) {
		if (busyKey) return;
		busyKey = card.key;
		tooSmallKey = "";
		try {
			const items = await loadCard(card);
			if (!items.length) {
				tooSmallKey = card.key;
				return;
			}
			await playTracks(items, {
				context: { kind: card.kind === "artist" ? "radio" : card.kind, title: card.title, href: "/library/mixes" },
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
		<!-- F4: one word per concept. A Mix is a fixed list of 40 titles sampled
		     from a slice of the library (a Radio is endless from a seed, Pour
		     toi is personal, a Mixtape is offline). -->
		<span class="sub">Un mix = 40 titres tirés de ta bibliothèque, par décennie ou par genre</span>
		<a
			class="genres-link"
			href="/library/genres"
			data-testid="mixes-genres-link">Tous les genres ›</a
		>
	</header>

	{#if loading}
		<p class="state">Chargement…</p>
	{:else if empty}
		<p
			class="state"
			data-testid="mixes-empty"
		>
			Pas encore assez d'albums pour un mix : il en faut 15 d'une même décennie, ou 200 titres d'un même genre sur 15 albums.
		</p>
	{:else}
		{#each [{ id: "mixes-decades", title: "Décennies", list: decades }, { id: "mixes-genres", title: "Genres", list: genres }, { id: "mixes-artists", title: "Tes artistes", list: artistCards }] as sec (sec.id)}
			{#if sec.list.length > 0}
				<section
					class="group"
					data-testid={sec.id}
				>
					<h2>{sec.title}</h2>
					{#if sec.id === "mixes-artists"}
						<p class="group-sub">Une radio à partir de chaque artiste que tu écoutes le plus</p>
					{/if}
					<div class="grid">
						{#each sec.list as card (card.key)}
							<!-- The tile: the card itself (tap = play) and, under it, the
							     HL6 keep button; two buttons side by side, never nested. -->
							<div
								class="mix-tile"
								class:is-decade={card.kind === "decade"}
								class:is-genre={card.kind === "genre"}
								class:is-artist={card.kind === "artist"}
							>
								<button
									type="button"
									class="btn-reset mix-card"
									data-testid="mix-card"
									data-mix={card.key}
									disabled={busyKey === card.key}
									aria-label={card.kind === "artist" ? `Lancer la radio ${card.title}` : `Lire le mix ${card.title}`}
									on:click={() => playMix(card)}
								>
									<span class="mix-title">{card.title}</span>
									<span class="mix-sub">{tooSmallKey === card.key ? "Pas assez d'albums" : card.subtitle}</span>
								</button>
								<div class="mix-keep">
									<KeepOfflineButton
										tracks={[]}
										load={() => loadCard(card)}
										sourceKey={`mix:${card.key}`}
										testid="mix-keep"
									/>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}
		{/each}
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
	.genres-link {
		margin-left: auto;
		color: #bbb;
		text-decoration: none;
		font-size: 0.9rem;
		min-height: max(2.75rem, 44px);
		display: inline-flex;
		align-items: center;
		&:hover {
			color: inherit;
			text-decoration: underline;
		}
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
	.group-sub {
		margin: -0.3rem 0 0.6rem;
		color: #999;
		font-size: 0.9rem;
	}
	/* Tile = card (play) + keep row; the coloured edge is the card kind. */
	.mix-tile {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}
	/* Tap target: 44px floor on phones (root 12px), cards grow with content. */
	.mix-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: flex-end;
		gap: 0.2rem;
		width: 100%;
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
	.is-genre .mix-card {
		border-left-color: hsl(330deg 60% 60%);
	}
	.is-artist .mix-card {
		border-left-color: hsl(150deg 50% 50%);
	}
	.mix-card:hover {
		background: linear-gradient(160deg, hsl(0deg 0% 100% / 20%), hsl(0deg 0% 100% / 9%));
	}
	.mix-card:disabled {
		cursor: progress;
		opacity: 0.7;
	}
	/* HL6: the keep button under the card, full tile width, 44px tall. */
	.mix-keep {
		display: flex;
		:global(.keep-offline) {
			width: 100%;
		}
		:global(.keep-btn) {
			flex: 1 1 auto;
			min-height: max(2.75rem, 44px);
			font-size: 0.9em;
		}
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
