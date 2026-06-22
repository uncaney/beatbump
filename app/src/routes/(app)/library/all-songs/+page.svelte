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
		title="Songs"
		{subtitle}
		extraParams={extra}
		sortOptions={[
			{ label: "Recently added", value: "dateAdded:desc" },
			{ label: "Title A–Z", value: "title:asc" },
			{ label: "Artist A–Z", value: "artist:asc" },
			{ label: "Album A–Z", value: "album:asc" },
			{ label: "Longest", value: "durationSec:desc" },
			{ label: "Newest year", value: "year:desc" },
		]}
	/>
{/key}
