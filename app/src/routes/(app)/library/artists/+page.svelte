<script lang="ts">
	import Browse from "../_Browse.svelte";
</script>

<!-- B8-20 (c48b): the "feat." credits of an artist are folded under its
     primary name, display only (?collapse=1: the API hides the alias rows
     and badges the primary "+N variantes", local_artist_alias.go). Every
     credit stays reachable through the "Aussi sous" chips of the artist
     page; a filtered list (Filtrer…) is never folded. -->
<Browse
	kind="artists"
	title="Artistes"
	extraParams="&collapse=1"
	sortOptions={[
		{ label: "A–Z", value: "name:asc" },
		{ label: "Z–A", value: "name:desc" },
		{ label: "Plus d'albums", value: "albumCount:desc" },
		{ label: "Plus de titres", value: "trackCount:desc" },
		{ label: "Ajoutés récemment", value: "dateAdded:desc" },
	]}
/>
