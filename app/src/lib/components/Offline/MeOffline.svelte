<script lang="ts">
	// "Hors connexion" state of the me/* pages (audit v4 H2): Saved, server
	// playlists, Recents, For You and Account read the profile from the server,
	// which the SW never caches (G16). One EmptyState pointing to the offline
	// library, which works without any connection.
	import EmptyState from "$components/EmptyState/EmptyState.svelte";

	export let text = "Tes morceaux en cache restent disponibles dans Hors-ligne.";
</script>

<div
	class="me-offline"
	data-testid="me-offline"
>
	<EmptyState
		icon="download"
		title="Hors connexion : cette page a besoin du serveur"
		{text}
		cta="Ouvrir Hors-ligne"
		href="/library/downloads-offline"
	/>
</div>
