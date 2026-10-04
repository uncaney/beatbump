<script lang="ts">
	import Icon from "$lib/components/Icon/Icon.svelte";
	import Listing from "$lib/components/Item/Listing.svelte";
	import { AudioPlayer } from "$lib/player";
	import list from "$lib/stores/list";

	import { SITE_ORIGIN_URL } from "$stores/url";
	import type { PageData } from "./$types";

	export let data: PageData;
	const { videoId, playlist, thumbnails = [], title, related, error, startAt } = data;
	// L10-2: the shared start time is applied once, on the first loadedmetadata of
	// this track (the player's resume seek; ignored when t >= duration - 2).
	let startApplied = false;
	function startListening() {
		if (startAt && !startApplied) {
			startApplied = true;
			AudioPlayer.primeResume(startAt, 0, true, videoId);
		}
		list.initAutoMixSession({
			videoId,
			playlistId: playlist ?? related?.currentMixId,
		});
	}
	// Largest thumbnail, if any: an unplayable track has none (F13).
	const cover = thumbnails.length ? thumbnails[thumbnails.length - 1] : undefined;
	const pageTitle = error ? "Morceau indisponible" : title;

	// $: console.log({ videoId, playlist, thumbnails, title, related, data });
</script>

<svelte:head>
	<meta
		property="og:title"
		content={pageTitle}
	/>
	<meta
		property="og:type"
		content="music.song"
	/>
	<meta
		property="og:description"
		content={`Écouter ${title} sur Musique`}
	/>
	<meta
		property="og:site_name"
		content="Musique"
	/>
	{#if cover?.url}
		<meta
			property="og:image"
			content={cover.url}
		/>
	{/if}

	<meta
		property="og:url"
		content={`${$SITE_ORIGIN_URL}/listen?id=${videoId}${
			playlist ? `&list=${playlist}` : ""
		}`}
	/>
	<title>{pageTitle} | Musique</title>
</svelte:head>
<main>
	{#if error}
		<header class="unavailable">
			<div class="body">
				<span class="title h4">Morceau indisponible{error.reason ? ` : ${error.reason}` : ""}</span>
				<p class="hint">Ce lien pointe vers un morceau qui ne peut pas être lu ici.</p>
				<a
					class="back"
					href="/home">Retour à l'accueil</a
				>
			</div>
		</header>
	{:else}
	<header>
		<div class="image-container">
			<img
				src={cover?.url}
				width={cover?.width}
				height={cover?.height}
				alt={`Thumbnail for ${title}`}
			/>
		</div>
		<div class="body">
			<span class="title h4">{title}</span>
			<button
				data-start-at={startAt ?? 0}
				on:click={startListening}
				><Icon
					name="play"
					size="1.25em"
					color="black"
				/><span class="text">Start Listening</span></button
			>
		</div>
	</header>
	<section class="related">
		<span class="h2">Related Tracks</span>
		<div class="results">
			{#each related?.results ?? [] as result}
				<Listing data={result} />
			{/each}
		</div>
	</section>
	{/if}
	<div class="modal">
		<div class="modal-header" />
		<div class="container" />
	</div>
</main>

<style lang="scss">
	header.unavailable {
		grid-template: "body" auto / 1fr;
	}
	.hint {
		margin: 0;
		opacity: 0.8;
	}
	a.back {
		text-decoration: underline;
	}

	.related {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}

	.body {
		grid-area: body;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		align-self: center;
		gap: 1.25rem;
	}

	button {
		grid-area: button;
	}

	header {
		display: grid;
		grid-template: "img body" 1fr / 0.5fr 1fr;
		gap: 1rem;
		margin-bottom: 0.8rem;
		background-color: hsl(209deg 20% 27% / 19%);
		border-color: #1b1b1b;
		border-radius: 0.8em;
		border-width: 1px;
		margin: 1em;
		padding: 0.8em;
		// transition: all 0.23s cubic-bezier(0.39, 0.575, 0.565, 1);transition
		@media screen and (min-width: 640px) {
			grid-template-areas:
				"img body"
				"img .";
			grid-template-rows: 1fr 1fr;
		}
	}

	.container {
		place-items: center;
	}

	.image-container {
		max-width: 100%;
		height: auto;
		max-height: 20rem;
		grid-area: img;
	}

	img {
		max-width: inherit;
		max-height: inherit;
		width: 100%;
		height: auto;
		object-fit: cover;
	}
</style>
