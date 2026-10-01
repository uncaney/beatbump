<script
	context="module"
	lang="ts"
>
	// X1 "Lecture en un geste": "Lire tout" / "Aléatoire" over any list of
	// track rows (Favoris, playlist serveur, artiste local, journée d'écoute).
	// The queue is the rows as they are, next/previous stay inside the list.
	// I20: a list of library rows only is a "local" mix (C4 library
	// continuation at its end); any YouTube row keeps it a YouTube
	// ("playlist") mix, rows untouched (no IS_LOCAL), so its end continues
	// with the YouTube radio. Rows without a videoId (albums, artists,
	// playlists) are skipped.

	/* eslint-disable @typescript-eslint/no-explicit-any */
	import type { PlaybackContextInput } from "$lib/stores/list/playbackContext";
	import { playAllMixType } from "$lib/stores/list/queueOps";

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
		const type = playAllMixType(list);
		const [{ default: SessionListService }, { getSrc }] = await Promise.all([
			import("$lib/stores/list"),
			import("$lib/player"),
		]);
		await SessionListService.setMix(list, type, opts.context ?? null, { fresh: true });
		await SessionListService.updatePosition(0);
		await getSrc(list[0].videoId, list[0].playlistId, undefined, true);
		return list.length;
	}
</script>

<script lang="ts">
	import { page } from "$app/stores";
	import Icon from "$components/Icon/Icon.svelte";
	import { playAllContextFor } from "$lib/stores/list/playbackContext";
	import { APIClient } from "$lib/api";

	/** Rows to play (non-playable rows are ignored). */
	export let tracks: any[] = [];
	/** Count shown next to the buttons; defaults to the playable rows. */
	export let total: number | undefined = undefined;
	/** Optional loader for the full list (local artist: every title, not the preview). */
	export let loadAll: (() => Promise<any[]>) | undefined = undefined;
	/**
	 * I8: source shown by the player. Pages that know their title pass it
	 * (J16: server playlist, artist); otherwise it is derived from the page
	 * path with the page `h1` as the title.
	 */
	export let context: PlaybackContextInput | null | undefined = undefined;
	let klass = "";
	export { klass as class };

	let busy = false;
	let radioBusy = false;
	let bar: HTMLElement | undefined;

	// EQ1: "Radio" on Favoris (/library/saved, /favorites) and the local
	// artist page (/artist/la-…) builds a targeted queue from local/related
	// (seed=favorites|artist:<id>), context "Radio : <name>". No match (a
	// YouTube artist page, any other route) -> no button.
	function radioSeedFor(pathname: string | null | undefined): string | null {
		const path = typeof pathname === "string" ? pathname : "";
		if (/^\/library\/saved\/?$/.test(path) || /^\/favorites\/?$/.test(path)) return "favorites";
		const m = path.match(/^\/(?:artist|channel)\/(la-[0-9a-f]+)\/?$/);
		if (m) return `artist:${m[1]}`;
		return null;
	}

	function pageHeading(): string {
		// J16: fallback only; `.name` is also a card class and could come first.
		const root = bar?.closest(".fix-width, main") ?? null;
		const el = root?.querySelector("h1") ?? null;
		return el?.textContent?.trim() ?? "";
	}

	$: playable = playableTracks(tracks);
	$: count = typeof total === "number" && total > 0 ? total : playable.length;
	$: label = `${count} titre${count > 1 ? "s" : ""}`;
	$: radioSeed = radioSeedFor($page.url.pathname);

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

	async function startRadio() {
		if (radioBusy || !radioSeed) return;
		radioBusy = true;
		try {
			const res = await APIClient.fetch(`/api/v1/local/related?seed=${encodeURIComponent(radioSeed)}`);
			if (!res.ok) return;
			const data = await res.json();
			const items = Array.isArray(data.items) ? data.items : [];
			const name = typeof data.name === "string" && data.name ? data.name : pageHeading();
			await playTracks(items, {
				context: { kind: "radio", title: name, href: $page.url.pathname },
			});
		} catch (err) {
			console.error("radio-seed: failed", err);
		} finally {
			radioBusy = false;
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
			class="pab-btn btn-reset btn-primary"
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
			class="pab-btn btn-reset btn-secondary"
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
		{#if radioSeed}
			<button
				type="button"
				class="pab-btn btn-reset btn-secondary"
				data-testid="radio-seed"
				disabled={radioBusy}
				on:click={startRadio}
			>
				<Icon
					name="radio"
					size="1.1em"
				/>
				<span>Radio</span>
			</button>
		{/if}
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
	// Shape, colours, 44px floor and plain case come from the button system
	// (global/redesign/modules/_button.scss: .btn-primary "Lire tout",
	// .btn-secondary "Aléatoire"); only the busy state lives here.
	.pab-btn:disabled {
		cursor: progress;
	}
	.pab-count {
		color: #999;
		font-size: 0.9em;
	}
</style>
