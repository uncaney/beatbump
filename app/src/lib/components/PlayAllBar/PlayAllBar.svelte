<script
	context="module"
	lang="ts"
>
	// X1 "Lecture en un geste": "Lire tout" / "Aléatoire" over any list of
	// track rows (Favoris, playlist serveur, artiste local, journée d'écoute).
	// The queue is a "local" mix of the rows as they are (setMix(items,
	// "local"), the same path as the favourites and IDB playlist pages): no
	// continuation fetch, next/previous stay inside the list. Rows without a
	// videoId (albums, artists, playlists) are skipped.

	/* eslint-disable @typescript-eslint/no-explicit-any */
	import type { PlaybackContextInput } from "$lib/stores/list/playbackContext";

	export function playableTracks(items: any[] | null | undefined): any[] {
		if (!Array.isArray(items)) return [];
		const seen = new Set<string>();
		const out: any[] = [];
		for (const it of items) {
			const id = it && typeof it.videoId === "string" ? it.videoId : "";
			if (!id || seen.has(id)) continue;
			seen.add(id);
			out.push(it);
		}
		return out;
	}

	function shuffled<T>(list: T[]): T[] {
		const a = list.slice();
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	}

	/**
	 * Replace the queue with `items` (playable rows only) and start the first
	 * one, or a random order with `shuffle`. `context` (I8) names the source
	 * shown by the player ("Favoris", "Playlist : X", "Artiste : Y"). Returns
	 * the queue length (0 when nothing is playable; nothing is thrown).
	 */
	export async function playTracks(
		items: any[] | null | undefined,
		opts: { shuffle?: boolean; context?: PlaybackContextInput | null } = {},
	): Promise<number> {
		let list = playableTracks(items);
		if (!list.length) return 0;
		if (opts.shuffle) list = shuffled(list);
		list = list.map((it) => ({ ...it, IS_LOCAL: true }));
		const [{ default: SessionListService }, { getSrc }] = await Promise.all([
			import("$lib/stores/list"),
			import("$lib/player"),
		]);
		await SessionListService.setMix(list, "local", opts.context ?? null);
		await SessionListService.updatePosition(0);
		await getSrc(list[0].videoId, list[0].playlistId, undefined, true);
		return list.length;
	}
</script>

<script lang="ts">
	import { page } from "$app/stores";
	import Icon from "$components/Icon/Icon.svelte";
	import { playAllContextFor } from "$lib/stores/list/playbackContext";

	/** Rows to play (non-playable rows are ignored). */
	export let tracks: any[] = [];
	/** Count shown next to the buttons; defaults to the playable rows. */
	export let total: number | undefined = undefined;
	/** Optional loader for the full list (local artist: every title, not the preview). */
	export let loadAll: (() => Promise<any[]>) | undefined = undefined;
	/**
	 * I8: source shown by the player. Default: derived from the page
	 * (Favoris, playlist, artist) with the page heading as the title.
	 */
	export let context: PlaybackContextInput | null | undefined = undefined;
	let klass = "";
	export { klass as class };

	let busy = false;
	let bar: HTMLElement | undefined;

	function pageHeading(): string {
		const root = bar?.closest(".fix-width, main") ?? null;
		const el = root?.querySelector("h1, .name") ?? null;
		return el?.textContent?.trim() ?? "";
	}

	$: playable = playableTracks(tracks);
	$: count = typeof total === "number" && total > 0 ? total : playable.length;
	$: label = `${count} titre${count > 1 ? "s" : ""}`;

	async function start(shuffle: boolean) {
		if (busy) return;
		busy = true;
		try {
			let list = tracks;
			if (loadAll) {
				try {
					const all = await loadAll();
					if (Array.isArray(all) && all.length) list = all;
				} catch (err) {
					console.error("play-all: full list failed, playing the preview", err);
				}
			}
			const ctx = context !== undefined ? context : playAllContextFor($page.url.pathname, pageHeading());
			await playTracks(list, { shuffle, context: ctx });
		} finally {
			busy = false;
		}
	}
</script>

{#if count > 0}
	<div
		class="play-all-bar {klass}"
		data-testid="play-all-bar"
		bind:this={bar}
	>
		<button
			type="button"
			class="pab-btn primary"
			data-testid="play-all"
			disabled={busy}
			on:click={() => start(false)}
		>
			<Icon
				name="play"
				size="1.1em"
			/>
			<span>Lire tout</span>
		</button>
		<button
			type="button"
			class="pab-btn"
			data-testid="play-shuffle"
			disabled={busy}
			on:click={() => start(true)}
		>
			<Icon
				name="shuffle"
				size="1.1em"
			/>
			<span>Aléatoire</span>
		</button>
		<span
			class="pab-count"
			data-testid="play-all-count">{label}</span
		>
		<slot />
	</div>
{/if}

<style lang="scss">
	.play-all-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin: 0.5rem 0 1rem;
	}
	.pab-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 2.5rem;
		padding: 0.45rem 1rem;
		border-radius: 2rem;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.pab-btn.primary {
		background: #fff;
		color: #000;
		border-color: #fff;
	}
	.pab-btn:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.pab-count {
		color: #999;
		font-size: 0.9em;
	}
</style>
