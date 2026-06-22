<script lang="ts">
	import Browse from "../_Browse.svelte";
</script>

<Browse
	kind="albums"
	title="Albums"
	sortOptions={[
		{ label: "Recently added", value: "dateAdded:desc" },
		{ label: "Album A–Z", value: "album:asc" },
		{ label: "Artist A–Z", value: "albumArtist:asc" },
		{ label: "Newest year", value: "year:desc" },
		{ label: "Oldest year", value: "year:asc" },
		{ label: "Most tracks", value: "trackCount:desc" },
	]}
/>
