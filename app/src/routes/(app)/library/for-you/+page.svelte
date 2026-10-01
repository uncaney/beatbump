<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import MeOffline from "$components/Offline/MeOffline.svelte";
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
			items = Array.isArray(r?.items) ? r.items : [];
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

<main>
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
	}
	.sub {
		color: #999;
		margin-left: 0.5rem;
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
