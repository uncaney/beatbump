<script lang="ts">
	// Tab bar linking the self-hosted collection browse pages + the IDB library.
	export let active = "";
	const tabs = [
		{ key: "for-you", label: "For You", href: "/library/for-you" },
		{ key: "playlists", label: "Playlists", href: "/library" },
		{ key: "artists", label: "Artists", href: "/library/artists" },
		{ key: "albums", label: "Albums", href: "/library/albums" },
		{ key: "songs", label: "Songs", href: "/library/all-songs" },
		{ key: "genres", label: "Genres", href: "/library/genres" },
		{ key: "saved", label: "Saved", href: "/library/saved" },
		{ key: "my-playlists", label: "My Playlists", href: "/library/playlists-srv" },
		{ key: "recent", label: "Listening", href: "/library/recent" },
		{ key: "downloads-offline", label: "Hors-ligne", href: "/library/downloads-offline" },
		{ key: "account", label: "Account", href: "/library/account" },
	];
</script>

<nav class="collnav">
	{#each tabs as t}
		<a
			href={t.href}
			class:active={t.key === active}>{t.label}</a
		>
	{/each}
</nav>

<style lang="scss">
	.collnav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 1.25rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		padding-bottom: 0.6rem;
	}
	a {
		color: inherit;
		text-decoration: none;
		padding: 0.35rem 0.75rem;
		border-radius: 1rem;
		font-weight: 500;
		opacity: 0.7;
		background: rgba(255, 255, 255, 0.05);
	}
	a:hover {
		opacity: 1;
	}
	a.active {
		opacity: 1;
		background: rgba(255, 255, 255, 0.16);
	}
</style>
