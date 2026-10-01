<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import MeOffline from "$components/Offline/MeOffline.svelte";
	import PlayAllBar from "$components/PlayAllBar/PlayAllBar.svelte";
	import { spreadArtists } from "$lib/homeRows";
	import { getMix } from "$lib/me";
	import { meLoadOffline } from "$lib/offline";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let items: any[] = [];
	let seeds = 0;
	let loading = true;
	// H2: the mix is built server-side from the profile, unreachable offline.
	let offline = false;

	async function load() {
		loading = true;
		let r: any = null;
		let err: unknown = undefined;
		try {
			r = await getMix();
		} catch (e) {
			err = e;
			console.error("mix load failed", e);
		}
		offline = meLoadOffline([r], err);
		if (offline) {
			items = [];
			seeds = 0;
		} else if (!err) {
			// UX4: the server mix came in artist runs (4 Killers then 4 System of
			// a Down); interleave so no artist plays twice in a row while another
			// is left (homeRows.spreadArtists, same artist identity as diversify).
			items = spreadArtists(Array.isArray(r?.items) ? r.items : []);
			seeds = r?.seeds || 0;
		}
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
</script>

<main class="resp-content-width">
	<CollectionNav active="for-you" />
	<header class="head">
		<div>
			<!-- F4: one word per concept. "Pour toi" = a personal selection built
			     from your favourites and plays (a Mix is a slice of the library,
			     a Radio is endless from a seed, a Mixtape is offline). -->
			<h1>Pour toi</h1>
			<span class="sub"
				>{seeds > 0
					? `Une sélection tirée de tes ${seeds} favori${seeds === 1 ? "" : "s"} et de tes écoutes`
					: "Une sélection tirée de ta bibliothèque"}</span
			>
		</div>
		<button
			class="btn btn-reset btn-secondary"
			data-testid="for-you-refresh"
			on:click={load}
			disabled={loading || offline}
			title={offline ? "Hors connexion" : "Nouvelle sélection"}>Rafraîchir</button
		>
	</header>

	{#if loading}
		<p class="state">Préparation de ta sélection…</p>
	{:else if offline}
		<MeOffline text="Ta sélection se construit sur le serveur : elle revient avec le réseau. Tes morceaux en cache restent dans Hors-ligne." />
	{:else if items.length === 0}
		<p class="state">Écoute quelques morceaux et ta sélection apparaîtra ici.</p>
	{:else}
		<!-- UX4: "Tout lire" / "Aléatoire" over the selection, in its order. -->
		<PlayAllBar
			tracks={items}
			context={{ kind: "queue", title: "Pour toi", href: "/library/for-you" }}
		/>
		<div class="grid">
			{#each items as item (item.videoId || item.title)}
				<div class="cell"><Listing data={item} /></div>
			{/each}
		</div>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
		// UX1: the title block shrinks so "Rafraîchir" stays inside the gutter.
		> div {
			min-width: 0;
		}
	}
	// U12-16: the subtitle sat 6 px right of the h1 and "40 titres"; one
	// left edge for the whole head.
	.sub {
		display: block;
		color: #999;
	}
	.btn {
		white-space: nowrap;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 0.25rem 1rem;
	}
	.cell {
		min-width: 0;
	}
	.state {
		color: #999;
		margin: 1.5rem 0;
	}
	@media screen and (max-width: 37em) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
