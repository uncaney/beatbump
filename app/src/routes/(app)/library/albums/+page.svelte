<script lang="ts">
	import Browse from "../_Browse.svelte";
</script>

<Browse
	kind="albums"
	title="Albums"
	sortOptions={[
		{ label: "Ajoutés récemment", value: "dateAdded:desc" },
		{ label: "Album A–Z", value: "album:asc" },
		{ label: "Artiste A–Z", value: "albumArtist:asc" },
		{ label: "Année, plus récentes", value: "year:desc" },
		{ label: "Année, plus anciennes", value: "year:asc" },
		{ label: "Plus de titres", value: "trackCount:desc" },
	]}
/>
