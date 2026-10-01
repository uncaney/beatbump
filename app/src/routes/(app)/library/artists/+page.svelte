<script lang="ts">
	import Browse from "../_Browse.svelte";
</script>

<Browse
	kind="artists"
	title="Artistes"
	sortOptions={[
		{ label: "A–Z", value: "name:asc" },
		{ label: "Z–A", value: "name:desc" },
		{ label: "Plus d'albums", value: "albumCount:desc" },
		{ label: "Plus de titres", value: "trackCount:desc" },
		{ label: "Ajoutés récemment", value: "dateAdded:desc" },
	]}
/>
