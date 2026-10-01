<script lang="ts">
	// Personal rows at the top of /home: Reprendre (H1), Pour toi (H2),
	// Récemment acquis (H3). Client-only: every row loads after mount, in
	// parallel, renders nothing while loading and stays hidden when its source
	// is empty or fails, so the YouTube rows below never wait on it.
	import { onMount } from "svelte";
	import { get } from "svelte/store";
	import { APIClient } from "$lib/api";
	import Carousel from "$lib/components/Carousel/Carousel.svelte";
	import { buildResumeRow, capItems, diversify, readLastTrack } from "$lib/homeRows";
	import { getMix, getRecent } from "$lib/me";
	import { queue } from "$lib/stores/list";

	const MAX = 20;

	let resume: any[] = [];
	let forYou: any[] = [];
	let acquired: any[] = [];

	async function loadResume() {
		let recent: any[] = [];
		try {
			const r = await getRecent(30);
			recent = Array.isArray(r?.items) ? r.items : [];
		} catch {
			recent = [];
		}
		let lastTrack = null;
		try {
			lastTrack = readLastTrack(localStorage);
		} catch {
			lastTrack = null;
		}
		resume = buildResumeRow(lastTrack, recent, get(queue), 10);
	}

	async function loadForYou() {
		try {
			const r = await getMix();
			forYou = diversify(capItems(r?.items, MAX * 4), MAX);
		} catch {
			forYou = [];
		}
	}

	async function loadAcquired() {
		try {
			const res = await APIClient.fetch(`/api/v1/local/albums?sort=dateAdded:desc&limit=${MAX}`);
			if (!res.ok) return;
			const r = await res.json();
			acquired = capItems(r?.items, MAX);
		} catch {
			acquired = [];
		}
	}

	onMount(() => {
		void loadResume();
		void loadForYou();
		void loadAcquired();
	});
</script>

{#if resume.length > 0}
	<section
		class="home-row"
		data-row="reprendre"
	>
		<Carousel
			items={resume}
			header={{ title: "Reprendre", subheading: "Là où tu t'es arrêté" }}
			type="trending"
			isBrowseEndpoint={false}
		/>
	</section>
{/if}

{#if forYou.length > 0}
	<section
		class="home-row"
		data-row="pour-toi"
	>
		<Carousel
			items={forYou}
			header={{ title: "Pour toi", subheading: "D'après ta bibliothèque" }}
			type="trending"
			isBrowseEndpoint={false}
			seeAllHref="/library/for-you"
			seeAllLabel="Voir tout"
		/>
	</section>
{/if}

{#if acquired.length > 0}
	<section
		class="home-row"
		data-row="recemment-acquis"
	>
		<Carousel
			items={acquired}
			header={{ title: "Récemment acquis", subheading: "Derniers albums ajoutés à la bibliothèque" }}
			type="trending"
			isBrowseEndpoint={true}
			seeAllHref="/library/albums"
			seeAllLabel="Voir tout"
		/>
	</section>
{/if}

<style>
	.home-row {
		display: contents;
	}
</style>
