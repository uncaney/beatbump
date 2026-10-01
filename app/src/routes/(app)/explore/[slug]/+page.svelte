<script lang="ts">
	import CarouselItem from "$components/Carousel/CarouselItem.svelte";
	import Carousel from "$lib/components/Carousel/Carousel.svelte";
	import { Grid } from "$lib/components/Grid";
	import Header from "$lib/components/Layouts/Header.svelte";

	export let data;
</script>

{#if data.notFound}
	<Header
		title="Catégorie introuvable"
		url={data.path}
		desc="Cette catégorie n'existe pas ou n'est plus proposée."
	/>
	<main>
		<div class="header">
			<h1>Catégorie introuvable</h1>
		</div>
		<p class="not-found" data-testid="explore-not-found">
			Cette catégorie n'existe pas ou n'est plus proposée.
			<a href="/explore">Retour à Explorer</a>
		</p>
	</main>
{:else}
<Header
	title="{data.response.header} Playlists"
	url={data.path}
	desc="Find the perfect playlist that'll match your mood, or fit any occasion."
/>
<main>
	<div class="header">
		<h1>{data.response.header}</h1>
	</div>
	{#each data.response.carousels as item}
			<!-- {@debug section} -->
			<Carousel
				header={item.header}
				items={item.items}
				type="home"
				isBrowseEndpoint={false}
			/>
	{/each}
    <!--{#each data.response.grids as item}
            <Grid
                heading={item.header.title}
                items={item.items}
                let:item
                let:index
            >
                <CarouselItem
                    {index}
                    aspectRatio={item.aspectRatio}
                    {item}
                    kind="isPlaylist"
                    type="home"
                    isBrowseEndpoint={true}
                    slot="item"
                />
            </Grid>
    {/each}-->
</main>
{/if}

<style lang="scss">
	.not-found {
		color: var(--text-secondary);
	}
	.not-found a {
		margin-left: 0.25em;
		text-decoration: underline;
	}
</style>
