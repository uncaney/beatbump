<script lang="ts">
	import { page } from "$app/stores";
	import Browse from "../_Browse.svelte";

	// Optional ?genre= / ?artist= filters (e.g. arriving from the Genres page).
	$: genre = $page.url.searchParams.get("genre") || "";
	$: artist = $page.url.searchParams.get("artist") || "";
	$: extra =
		(genre ? `&genre=${encodeURIComponent(genre)}` : "") +
		(artist ? `&artist=${encodeURIComponent(artist)}` : "");
	$: subtitle = genre || artist || "";
</script>

{#key extra}
	<Browse
		kind="songs"
		title="Titres"
		{subtitle}
		extraParams={extra}
		sortOptions={[
			{ label: "Ajoutés récemment", value: "dateAdded:desc" },
			{ label: "Titre A–Z", value: "title:asc" },
			{ label: "Artiste A–Z", value: "artist:asc" },
			{ label: "Album A–Z", value: "album:asc" },
			{ label: "Plus longs", value: "durationSec:desc" },
			{ label: "Année, plus récentes", value: "year:desc" },
		]}
	/>
{/key}
