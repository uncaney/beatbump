<script lang="ts">
	import { APIClient } from "$lib/api";
	import { genreHref, normalizeGenreList } from "$lib/localGenres";
	import Icon from "$components/Icon/Icon.svelte";
	import { playTracks } from "$components/PlayAllBar/PlayAllBar.svelte";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let genres: { name: string; count: number }[] = [];
	let loading = true;
	let q = "";
	/** Name of the genre currently loading its queue (disables its own buttons only). */
	let busyGenre = "";
	// B8-21: a genre with a single album is rare noise in the main list (37
	// of them on the library at hand); folded into a collapsed section at the
	// end instead, open on demand.
	let rareOpen = false;

	$: filtered = q
		? genres.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()))
		: genres;
	$: commonGenres = filtered.filter((g) => g.count > 1);
	$: rareGenres = filtered.filter((g) => g.count <= 1);

	onMount(async () => {
		try {
			const res = await APIClient.fetch("/api/v1/local/genres");
			const data = await res.json();
			// U12-5: tolerant of a raw answer (split ";" / "/", junk dropped, merged).
			genres = normalizeGenreList(data);
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

<main class="resp-content-width">
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
		<!-- U12-5: one row per genre (name + count on the left, play and shuffle
		     aligned on the right), a grid instead of the wrapped zigzag. -->
		<ul
			class="genre-list"
			data-testid="genre-list"
		>
			{#each commonGenres as g (g.name)}
				<li class="chip-row">
					<a
						class="chip"
						href={genreHref(g.name)}
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
				</li>
			{/each}
		</ul>

		{#if rareGenres.length}
			<!-- B8-21: folded by default, 44px tap target, count in the label. -->
			<button
				type="button"
				class="btn-reset rare-toggle"
				data-testid="genres-rare-toggle"
				aria-expanded={rareOpen}
				on:click={() => (rareOpen = !rareOpen)}
			>
				<span
					class="rare-icon"
					class:open={rareOpen}
				>
					<Icon
						name="chevron-right"
						size="1em"
					/>
				</span>
				{`Genres rares (${rareGenres.length})`}
			</button>
			{#if rareOpen}
				<ul
					class="genre-list rare-list"
					data-testid="genre-list-rare"
				>
					{#each rareGenres as g (g.name)}
						<li class="chip-row">
							<a
								class="chip"
								href={genreHref(g.name)}
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
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
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
		max-width: 100%;
	}
	// U12-5: a list of equal rows; on wide screens several columns of the
	// same rows (auto-fill), never a ragged flex-wrap.
	.genre-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
		gap: 0.4rem 1.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	// UX1: a long genre name must not push its row past the 16 px gutter
	// (no horizontal scroll at 390 px): the chip column shrinks, the name
	// ellipsizes; play / shuffle keep their 44 px on the right.
	.chip-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 0.4rem;
		min-height: 48px;
		min-width: 0;
	}
	.chip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
		box-sizing: border-box;
		min-height: max(2.75rem, 44px);
		.name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		padding: 0.4rem 0.9rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
		color: inherit;
		text-decoration: none;
	}
	.chip:hover {
		background: rgba(255, 255, 255, 0.16);
	}
	.chip .count {
		color: #b3b3b3;
		font-size: var(--text-secondary-size);
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
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
	// B8-21: the rare-genres fold toggle, 44px tap target like the other rows.
	.rare-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: max(2.75rem, 44px);
		padding: 0.4rem 0.9rem;
		margin-top: 0.75rem;
		border-radius: 999px;
		color: inherit;
		background: rgba(255, 255, 255, 0.07);
		font-weight: 600;
	}
	.rare-toggle:hover {
		background: rgba(255, 255, 255, 0.16);
	}
	.rare-icon {
		display: inline-flex;
		transition: transform 0.15s ease;
	}
	.rare-icon.open {
		transform: rotate(90deg);
	}
	.rare-list {
		margin-top: 0.75rem;
	}
</style>
