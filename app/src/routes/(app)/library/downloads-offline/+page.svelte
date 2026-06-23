<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import { getOfflineTracks, removeOffline } from "$lib/offline";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let tracks: any[] = [];
	let online = true;

	function refresh() {
		tracks = getOfflineTracks();
	}
	onMount(() => {
		online = navigator.onLine;
		refresh();
		const on = () => (online = true);
		const off = () => (online = false);
		window.addEventListener("online", on);
		window.addEventListener("offline", off);
		return () => {
			window.removeEventListener("online", on);
			window.removeEventListener("offline", off);
		};
	});

	function remove(t: any) {
		removeOffline(t);
		refresh();
	}
</script>

<main>
	<CollectionNav active="downloads-offline" />
	<header class="head">
		<h1>Offline</h1>
		<span
			class="status"
			class:off={!online}>{online ? "● Online" : "● Offline — cached only"}</span
		>
	</header>
	<p class="note">
		Tracks you "Download offline" (track menu → Download offline) are cached in this browser and play
		without a connection.
	</p>

	{#if tracks.length === 0}
		<p class="state">No offline downloads yet.</p>
	{:else}
		<section>
			{#each tracks as t (t.videoId)}
				<div class="row">
					<div class="item"><Listing data={t} /></div>
					<button
						class="rm"
						title="Remove offline copy"
						on:click={() => remove(t)}>✕</button
					>
				</div>
			{/each}
		</section>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 1rem;
		justify-content: space-between;
	}
	.status {
		color: #1ed760;
		font-size: 0.9rem;
	}
	.status.off {
		color: #e0a000;
	}
	.note {
		color: #999;
		font-size: 0.9rem;
		margin: 0.5rem 0 1rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.item {
		flex: 1;
		min-width: 0;
	}
	.rm {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.2);
		color: inherit;
		border-radius: 0.4rem;
		padding: 0.3rem 0.6rem;
		cursor: pointer;
	}
	.state {
		color: #999;
		margin: 1.5rem 0;
	}
</style>
