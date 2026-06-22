<script lang="ts">
	import { getPlaylists, createPlaylist, addToPlaylist } from "$lib/me";
	import { queue } from "$lib/stores/list";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let playlists: any[] = [];
	let loading = true;
	let busy = false;

	async function load() {
		loading = true;
		try {
			const r = await getPlaylists();
			playlists = Array.isArray(r.playlists) ? r.playlists : [];
		} catch (err) {
			console.error("playlists load failed", err);
		}
		loading = false;
	}
	onMount(load);

	async function newPlaylist() {
		if (busy) return;
		busy = true;
		try {
			await createPlaylist("New Playlist");
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
			const pl = await createPlaylist("Saved queue");
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

<main>
	<CollectionNav active="my-playlists" />
	<header class="head">
		<h1>My Playlists</h1>
		<div class="actions">
			<button
				class="btn"
				on:click={newPlaylist}
				disabled={busy}>New playlist</button
			>
			<button
				class="btn"
				on:click={saveQueue}
				disabled={busy || !($queue && $queue.length)}
				title="Save the current play queue as a playlist"
				>Save current queue{$queue && $queue.length ? ` (${$queue.length})` : ""}</button
			>
		</div>
	</header>

	{#if loading}
		<p class="state">Loading…</p>
	{:else if playlists.length === 0}
		<p class="state">No server playlists yet.</p>
	{:else}
		<div class="list">
			{#each playlists as p (p.id)}
				<a
					class="pl-item"
					href={`/library/playlists-srv/${p.id}`}
				>
					<span class="name">{p.name}</span>
					<span class="count">{p.count} {p.count === 1 ? "track" : "tracks"}</span>
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
	.btn {
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 0.4rem;
		color: inherit;
		padding: 0.45rem 0.9rem;
		cursor: pointer;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
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
		color: #999;
		font-size: 0.9rem;
	}
	.state {
		color: #999;
		margin: 1rem 0;
	}
</style>
