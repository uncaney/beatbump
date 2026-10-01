<script lang="ts">
	import { APIClient } from "$lib/api";
	import Icon from "$components/Icon/Icon.svelte";
	import { playTracks } from "$components/PlayAllBar/PlayAllBar.svelte";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let genres: { name: string; count: number }[] = [];
	let loading = true;
	let q = "";
	/** Name of the genre currently loading its queue (disables its own buttons only). */
	let busyGenre = "";

	$: filtered = q
		? genres.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()))
		: genres;

	onMount(async () => {
		try {
			const res = await APIClient.fetch("/api/v1/local/genres");
			const data = await res.json();
			genres = Array.isArray(data.genres) ? data.genres : [];
		} catch (err) {
			console.error("genres load failed", err);
		}
		loading = false;
	});

	// D4: "Lire" / "Aléatoire" on a genre row load up to 200 of its tracks
	// (local/songs genre filter, backend/api/local_browse.go) into the queue
	// via the shared PlayAllBar.playTracks, context "Genre : <g>" (I8).
	async function playGenre(name: string, shuffle: boolean) {
		if (busyGenre) return;
		busyGenre = name;
		try {
			const res = await APIClient.fetch(
				`/api/v1/local/songs?genre=${encodeURIComponent(name)}&limit=200`,
			);
			const data = await res.json();
			const items = Array.isArray(data.items) ? data.items : [];
			await playTracks(items, {
				shuffle,
				context: { kind: "genre", title: name, href: "/library/genres" },
			});
		} catch (err) {
			console.error("genre play failed", err);
		} finally {
			busyGenre = "";
		}
	}
</script>

<main>
	<CollectionNav active="genres" />
	<header class="head">
		<h1>Genres</h1>
		<input
			class="filter"
			type="search"
			placeholder="Filtrer les genres…"
			aria-label="Filtrer les genres"
			bind:value={q}
		/>
	</header>

	{#if loading}
		<p class="state">Chargement…</p>
	{:else if filtered.length === 0}
		<p class="state">{q ? `Aucun genre ne correspond à « ${q} ».` : "Aucun genre."}</p>
	{:else}
		<div class="chips">
			{#each filtered as g}
				<div class="chip-row">
					<a
						class="chip"
						href={`/library/all-songs?genre=${encodeURIComponent(g.name)}`}
					>
						<span class="name">{g.name}</span>
						<span class="count">{g.count}</span>
					</a>
					<button
						type="button"
						class="btn-reset btn-primary genre-btn"
						data-testid="genre-play"
						disabled={busyGenre === g.name}
						aria-label={`Lire ${g.name}`}
						on:click={() => playGenre(g.name, false)}
					>
						<Icon
							name="play"
							size="1em"
						/>
					</button>
					<button
						type="button"
						class="btn-reset btn-secondary genre-btn"
						data-testid="genre-shuffle"
						disabled={busyGenre === g.name}
						aria-label={`Lecture aléatoire ${g.name}`}
						on:click={() => playGenre(g.name, true)}
					>
						<Icon
							name="shuffle"
							size="1em"
						/>
					</button>
				</div>
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
	.filter {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 0.4rem;
		color: inherit;
		padding: 0.4rem 0.6rem;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.chip-row {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.8rem;
		border-radius: 1rem;
		background: rgba(255, 255, 255, 0.07);
		color: inherit;
		text-decoration: none;
	}
	.chip:hover {
		background: rgba(255, 255, 255, 0.16);
	}
	.chip .count {
		color: #999;
		font-size: 0.85rem;
	}
	// L8-7: scoped `.genre-btn` (0,2,0) beats the button system's
	// `min-height: max(2.75rem, 44px)` (0,1,0): `width/height: 2rem` gave
	// 24px targets at the 12px mobile root. Keep the round icon look with
	// min-* at the 44px floor instead of a fixed box.
	.genre-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		width: max(2.75rem, 44px);
		height: max(2.75rem, 44px);
		border-radius: 50%;
		padding: 0;
	}
	.genre-btn:disabled {
		cursor: progress;
	}
	.state {
		text-align: center;
		color: #999;
		margin: 2rem 0;
	}
</style>
