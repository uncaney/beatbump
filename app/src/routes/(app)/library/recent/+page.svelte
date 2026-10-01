<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import MeOffline from "$components/Offline/MeOffline.svelte";
	import { getRecent, getTop } from "$lib/me";
	import { meLoadOffline } from "$lib/offline";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let recent: any[] = [];
	let top: any[] = [];
	let loading = true;
	// H2: the play history lives in the profile, unreachable offline.
	let offline = false;

	async function load() {
		loading = true;
		let r: any = null;
		let t: any = null;
		let err: unknown = undefined;
		try {
			[r, t] = await Promise.all([getRecent(60), getTop(60)]);
		} catch (e) {
			err = e;
			console.error("recent load failed", e);
		}
		offline = meLoadOffline([r, t], err);
		if (offline) {
			recent = [];
			top = [];
		} else if (!err) {
			recent = Array.isArray(r?.items) ? r.items : [];
			top = Array.isArray(t?.items) ? t.items : [];
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
	<CollectionNav active="recent" />
	<h1>Listening</h1>

	<section>
		<h2>Recently played</h2>
		{#if loading}
			<p class="state">Loading…</p>
		{:else if offline}
			<MeOffline text="Ton historique reviendra avec le réseau ; tes morceaux en cache restent dans Hors-ligne." />
		{:else if recent.length === 0}
			<p class="state">Nothing played yet.</p>
		{:else}
			<div class="grid">
				{#each recent as item (item.videoId || item.title)}
					<div class="cell"><Listing data={item} /></div>
				{/each}
			</div>
		{/if}
	</section>

	{#if top.length > 0}
		<section>
			<h2>Most played</h2>
			<div class="grid">
				{#each top as item (item.videoId || item.title)}
					<div class="cell"><Listing data={item} /></div>
				{/each}
			</div>
		</section>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	h2 {
		margin: 1.25rem 0 0.5rem;
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
		margin: 1rem 0;
	}
	@media screen and (max-width: 37em) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
