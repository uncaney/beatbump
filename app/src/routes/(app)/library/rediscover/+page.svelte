<script lang="ts">
	// c30a F5: the full "Redécouvrir" list behind the home row's "Voir tout".
	// Same source as the row (GET me/stats/rediscover: tracks played >= 3
	// times more than 60 days ago and not once in the last 30 days, most
	// plays first), up to the API cap of 50, so the first card here is the
	// first card of the row. Profile-bound: anonymous profiles have no
	// history and are invited to say their name; offline, the history is
	// unreachable (MeOffline, like /library/recent).
	import EmptyState from "$components/EmptyState/EmptyState.svelte";
	import Listing from "$components/Item/Listing.svelte";
	import MeOffline from "$components/Offline/MeOffline.svelte";
	import { playTracks } from "$components/PlayAllBar/PlayAllBar.svelte";
	import { APIClient } from "$lib/api";
	import { capItems, sanitizeCard } from "$lib/homeRows";
	import { isAnonymousProfile } from "$lib/me";
	import { meLoadOffline } from "$lib/offline";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	const LIMIT = 50;
	let items: any[] = [];
	let loading = true;
	let offline = false;
	let anonymous = false;
	let playing = false;

	async function load() {
		loading = true;
		let r: any = null;
		let err: unknown = undefined;
		try {
			anonymous = await isAnonymousProfile();
			const res = await APIClient.fetch(`/api/v1/me/stats/rediscover?limit=${LIMIT}`);
			r = await res.json();
		} catch (e) {
			err = e;
			console.error("rediscover load failed", e);
		}
		offline = meLoadOffline([r], err);
		items = offline || err ? [] : capItems(r?.items, LIMIT).map(sanitizeCard);
		loading = false;
	}

	onMount(() => {
		void load();
		const on = () => {
			if (offline) void load();
		};
		window.addEventListener("online", on);
		return () => window.removeEventListener("online", on);
	});

	async function playAll() {
		if (playing || !items.length) return;
		playing = true;
		try {
			await playTracks(items, { context: { kind: "queue", title: "Redécouvrir", href: "/library/rediscover" } });
		} finally {
			playing = false;
		}
	}
</script>

<main
	class="resp-content-width"
	data-testid="rediscover-page"
>
	<CollectionNav active="recent" />
	<header class="head">
		<div>
			<h1>Redécouvrir</h1>
			<span class="sub">Des morceaux que tu aimais et que tu n'as plus écoutés depuis un mois</span>
		</div>
		{#if items.length > 0}
			<button
				type="button"
				class="btn-reset btn-primary"
				data-testid="rediscover-play-all"
				disabled={playing}
				on:click={playAll}>Tout lire ({items.length})</button
			>
		{/if}
	</header>

	{#if loading}
		<p class="state">Chargement…</p>
	{:else if offline}
		<MeOffline text="Ton historique reviendra avec le réseau ; tes morceaux en cache restent dans Hors-ligne." />
	{:else if items.length === 0}
		<!-- UX3: one action out of the empty list (anonymous or new profile). -->
		<div data-testid="rediscover-empty">
			<EmptyState
				testid="empty-state"
				icon="refresh"
				title="Rien à redécouvrir pour l'instant"
				text={anonymous
					? "Dis-moi ton prénom dans Compte pour retrouver tes écoutes : cette liste suit ton historique."
					: "Il faut des morceaux écoutés au moins 3 fois il y a plus de deux mois, et pas depuis un mois."}
				href="/library/albums"
				cta="Explorer la bibliothèque"
			/>
		</div>
	{:else}
		<div class="grid">
			{#each items as item (item.videoId || item.title)}
				<div class="cell"><Listing data={item} /></div>
			{/each}
		</div>
		<p class="state">Fin de la liste ({items.length})</p>
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
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
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
	@media screen and (max-width: 37em) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
