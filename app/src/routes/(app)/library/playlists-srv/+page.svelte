<script lang="ts">
	import MeOffline from "$components/Offline/MeOffline.svelte";
	import { getPlaylists, createPlaylist, addToPlaylist } from "$lib/me";
	import { meLoadOffline } from "$lib/offline";
	import { queue } from "$lib/stores/list";
	import { formatCountFr } from "$lib/utils/formatFr";
	import { onMount } from "svelte";
	import EmptyState from "$components/EmptyState/EmptyState.svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let playlists: any[] = [];
	let loading = true;
	let busy = false;
	// H2: server playlists live in the profile, unreachable offline.
	let offline = false;

	async function load() {
		loading = true;
		let r: any = null;
		let err: unknown = undefined;
		try {
			r = await getPlaylists();
		} catch (e) {
			err = e;
			console.error("playlists load failed", e);
		}
		offline = meLoadOffline([r], err);
		if (offline) playlists = [];
		else if (!err) playlists = Array.isArray(r?.playlists) ? r.playlists : [];
		loading = false;
	}
	onMount(() => {
		void load();
		const on = () => {
			if (offline) void load();
		};
		window.addEventListener("online", on);
		return () => window.removeEventListener("online", on);
	});

	async function newPlaylist() {
		if (busy) return;
		busy = true;
		try {
			await createPlaylist("Nouvelle playlist");
			await load();
		} finally {
			busy = false;
		}
	}

	async function saveQueue() {
		if (busy) return;
		const items = $queue || [];
		if (!items.length) return;
		busy = true;
		try {
			const pl = await createPlaylist("File enregistrée");
			for (const it of items) {
				// eslint-disable-next-line no-await-in-loop
				await addToPlaylist(pl.id, it);
			}
			await load();
		} finally {
			busy = false;
		}
	}
</script>

<main class="resp-content-width">
	<CollectionNav active="my-playlists" />
	<header class="head">
		<h1>Mes playlists</h1>
		<a
			class="back-link"
			href="/library"
			data-testid="playlists-local-link">‹ Playlists de cet appareil</a
		>
		<div class="actions">
			<button
				type="button"
				class="btn-primary"
				data-testid="playlists-srv-new"
				on:click={newPlaylist}
				disabled={busy || offline}
				title={offline ? "Hors connexion" : undefined}>Nouvelle playlist</button
			>
			<button
				type="button"
				class="btn-secondary"
				data-testid="playlists-srv-save-queue"
				on:click={saveQueue}
				disabled={busy || offline || !($queue && $queue.length)}
				title={offline ? "Hors connexion" : "Enregistrer la file de lecture actuelle comme playlist"}
				>Enregistrer la file{$queue && $queue.length ? ` (${$queue.length})` : ""}</button
			>
		</div>
	</header>

	{#if loading}
		<p class="state">Chargement…</p>
	{:else if offline}
		<MeOffline text="Tes playlists reviendront avec le réseau ; tes morceaux en cache restent dans Hors-ligne." />
	{:else if playlists.length === 0}
		<!-- U12-1: one pictogram, one sentence, one action (same block as Écoutes / Favoris). -->
		<EmptyState
			testid="empty-state"
			icon="list"
			title="Pas encore de playlist sur le serveur"
			text="Crée-en une avec « Nouvelle playlist », ou enregistre ta file de lecture : elle te suivra sur tes appareils."
			href="/library"
			cta="Voir les playlists de cet appareil"
		/>
	{:else}
		<div class="list">
			{#each playlists as p (p.id)}
				<a
					class="pl-item"
					href={`/library/playlists-srv/${p.id}`}
				>
					<span class="name">{p.name}</span>
					<span class="count">{formatCountFr(p.count, "titre")}</span>
				</a>
			{/each}
		</div>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	/* F9: the two playlist systems share one chip; this is the way back. */
	.back-link {
		flex-basis: 100%;
		order: 1;
		color: #bbb;
		text-decoration: none;
		font-size: var(--text-secondary-size);
		min-height: max(2.75rem, 44px);
		display: inline-flex;
		align-items: center;
	}
	.back-link:hover {
		color: inherit;
		text-decoration: underline;
	}
	/* U12-1: colours, casing and the 44 px floor come from .btn-primary / .btn-secondary. */
	.actions {
		flex-wrap: wrap;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.pl-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		min-height: max(2.75rem, 44px);
		box-sizing: border-box;
		padding: 0.7rem 0.9rem;
		border-radius: 0.4rem;
		background: rgba(255, 255, 255, 0.05);
		color: inherit;
		text-decoration: none;
	}
	.pl-item:hover {
		background: rgba(255, 255, 255, 0.12);
	}
	.pl-item .count {
		color: #b3b3b3;
		font-size: var(--text-secondary-size);
		flex-shrink: 0;
	}
	.state {
		color: #999;
		margin: 1rem 0;
	}
</style>
