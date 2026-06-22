<script lang="ts">
	import Browse from "../_Browse.svelte";
</script>

<Browse
	kind="artists"
	title="Artists"
	sortOptions={[
		{ label: "A–Z", value: "name:asc" },
		{ label: "Z–A", value: "name:desc" },
		{ label: "Most albums", value: "albumCount:desc" },
		{ label: "Most tracks", value: "trackCount:desc" },
		{ label: "Recently added", value: "dateAdded:desc" },
	]}
/>
