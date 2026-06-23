<script lang="ts">
	import { currentTrack } from "$lib/stores/list";
	import { AudioPlayer } from "$lib/player";
	import { APIClient } from "$lib/api";

	const { currentTimeStore } = AudioPlayer;

	let lyrics: any = null;
	let loading = false;
	let lastKey = "";

	async function load(t: any) {
		if (!t || !t.title) {
			lyrics = null;
			return;
		}
		const key = t.videoId || t.title;
		if (key === lastKey) return;
		lastKey = key;
		loading = true;
		lyrics = null;
		const artist = t?.artistInfo?.artist?.[0]?.text || t?.subtitle?.[0]?.text || "";
		const album = (t?.album && t.album.title) || "";
		const p = new URLSearchParams({ title: t.title, artist });
		if (album) p.set("album", album);
		if (t.videoId) p.set("videoId", t.videoId);
		try {
			lyrics = await (await APIClient.fetch("/api/v1/lyrics?" + p.toString())).json();
		} catch (e) {
			lyrics = { found: false };
		}
		loading = false;
	}
	$: load($currentTrack);

	$: lines = lyrics?.synced
		? lyrics.synced
				.split("\n")
				.map((l: string) => {
					const m = l.match(/^\[(\d+):(\d+)(?:[.:](\d+))?\]\s?(.*)$/);
					return m ? { t: +m[1] * 60 + +m[2], text: m[4] } : null;
				})
				.filter((x: any) => x)
		: null;

	$: active = lines
		? (() => {
				let i = -1;
				for (let k = 0; k < lines.length; k++) {
					if (lines[k].t <= $currentTimeStore) i = k;
					else break;
				}
				return i;
		  })()
		: -1;
</script>

<main>
	{#if $currentTrack}
		<header>
			<h1>{$currentTrack.title}</h1>
			<span class="sub">{$currentTrack?.artistInfo?.artist?.[0]?.text || ""}</span>
		</header>
	{/if}

	{#if loading}
		<p class="state">Loading lyrics…</p>
	{:else if lyrics?.found}
		{#if lines}
			<div class="synced">
				{#each lines as ln, i}
					<p
						class="line"
						class:active={i === active}
					>
						{ln.text || "♪"}
					</p>
				{/each}
			</div>
		{:else}
			<pre class="plain">{lyrics.plain}</pre>
		{/if}
		<small class="src">via {lyrics.source}</small>
	{:else if $currentTrack}
		<p class="state">No lyrics found for this track.</p>
	{:else}
		<p class="state">Play a track to see its lyrics.</p>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 6rem;
		max-width: 44rem;
		margin: 0 auto;
		text-align: center;
	}
	header {
		margin-bottom: 1.5rem;
	}
	.sub {
		color: #999;
	}
	.synced .line {
		font-size: 1.35rem;
		line-height: 2;
		color: #888;
		transition: color 0.2s, transform 0.2s;
		margin: 0;
	}
	.synced .line.active {
		color: #fff;
		font-weight: 700;
		transform: scale(1.04);
	}
	.plain {
		white-space: pre-wrap;
		font-family: inherit;
		font-size: 1.15rem;
		line-height: 1.9;
		text-align: center;
	}
	.src {
		display: block;
		margin-top: 2rem;
		color: #777;
	}
	.state {
		color: #999;
		margin-top: 3rem;
		font-size: 1.1rem;
	}
</style>
