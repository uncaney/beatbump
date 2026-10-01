<script lang="ts">
	// Lyrics of the current track (idea P7).
	// - synced lines are buttons: click = seek to the line's timestamp
	// - the active line is kept centred; auto-scroll pauses while the user
	//   scrolls (wheel / touch / keyboard) and resumes FOLLOW_RESUME_MS after
	//   the last user scroll (or at once with the "Reprendre le suivi" pill)
	// - A- / A+ : three sizes, persisted in localStorage `ytm-lyrics-font`
	// - the service worker already replays /api/v1/lyrics offline (network-
	//   first `ytm-api` cache); on top, the last LYRICS_CACHE_MAX found lyrics
	//   are kept in localStorage `ytm-lyrics-cache` keyed by videoId so the page
	//   works offline even without a controlling SW (first load, purged cache).
	import { currentTrack } from "$lib/stores/list";
	import { AudioPlayer } from "$lib/player";
	import { APIClient } from "$lib/api";
	import EmptyState from "$components/EmptyState/EmptyState.svelte";
	import { onDestroy, onMount, tick } from "svelte";
	import { fullscreenStore } from "$lib/components/Player/channel";

	const { currentTimeStore } = AudioPlayer;
	const FOLLOW_RESUME_MS = 4000;
	const FONT_KEY = "ytm-lyrics-font";
	const CACHE_KEY = "ytm-lyrics-cache";
	const LYRICS_CACHE_MAX = 50;
	const SIZES = ["s", "m", "l"] as const;
	type Size = (typeof SIZES)[number];

	let lyrics: any = null;
	let loading = false;
	let lastKey = "";
	let fromCache = false;
	let online = true;

	// ---- offline cache (bounded, found lyrics only) ----
	type CacheEntry = { id: string; lyrics: any; at: number };
	function readCache(): CacheEntry[] {
		try {
			const raw = localStorage.getItem(CACHE_KEY);
			const l = raw ? JSON.parse(raw) : [];
			return Array.isArray(l) ? l.filter((e) => e && typeof e.id === "string" && e.lyrics) : [];
		} catch {
			return [];
		}
	}
	function cacheGet(id: string): any {
		if (!id) return null;
		return readCache().find((e) => e.id === id)?.lyrics ?? null;
	}
	function cachePut(id: string, data: any) {
		if (!id || !data?.found) return;
		try {
			const slim = { found: true, synced: data.synced || "", plain: data.plain || "", source: data.source || "" };
			const list = readCache().filter((e) => e.id !== id);
			list.unshift({ id, lyrics: slim, at: Date.now() });
			localStorage.setItem(CACHE_KEY, JSON.stringify(list.slice(0, LYRICS_CACHE_MAX)));
		} catch {
			/* quota / private mode: ignore */
		}
	}

	async function load(t: any) {
		if (!t || !t.title) {
			lyrics = null;
			lastKey = "";
			return;
		}
		const key = t.videoId || t.title;
		if (key === lastKey) return;
		lastKey = key;
		fromCache = false;
		followPaused = false;
		const cached = cacheGet(t.videoId);
		if (cached) {
			lyrics = cached;
			fromCache = true;
			loading = false;
			return;
		}
		loading = true;
		lyrics = null;
		const artist = t?.artistInfo?.artist?.[0]?.text || t?.subtitle?.[0]?.text || "";
		const album = (t?.album && (t.album.title || t.album.text)) || "";
		const p = new URLSearchParams({ title: t.title, artist });
		if (album) p.set("album", album);
		if (t.videoId) p.set("videoId", t.videoId);
		try {
			const res = await (await APIClient.fetch("/api/v1/lyrics?" + p.toString())).json();
			if (key !== lastKey) return; // track changed meanwhile
			lyrics = res && typeof res === "object" ? res : { found: false };
			if (lyrics.found) cachePut(t.videoId, lyrics);
		} catch (e) {
			if (key !== lastKey) return;
			lyrics = { found: false };
		}
		loading = false;
	}
	$: load($currentTrack);

	$: lines = lyrics?.synced
		? (lyrics.synced
				.split("\n")
				.map((l: string) => {
					const m = l.match(/^\[(\d+):(\d+)(?:[.:](\d+))?\]\s?(.*)$/);
					if (!m) return null;
					const frac = m[3] ? Number("0." + m[3]) : 0;
					return { t: +m[1] * 60 + +m[2] + frac, text: m[4] };
				})
				.filter((x: any) => x) as { t: number; text: string }[])
		: null;
	$: hasSynced = !!(lines && lines.length);

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

	// ---- seek ----
	function seekTo(sec: number) {
		try {
			AudioPlayer.seek(sec);
		} catch (e) {
			console.error("lyrics seek failed", e);
		}
		resumeFollow();
	}
	function mmss(sec: number): string {
		const s = Math.max(0, Math.floor(sec));
		return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
	}

	// ---- follow (auto-scroll) ----
	let followPaused = false;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;
	let lineEls: HTMLButtonElement[] = [];
	let lastScrolledTo = -1;

	function userScrolled() {
		followPaused = true;
		if (resumeTimer) clearTimeout(resumeTimer);
		resumeTimer = setTimeout(resumeFollow, FOLLOW_RESUME_MS);
	}
	function resumeFollow() {
		if (resumeTimer) clearTimeout(resumeTimer);
		resumeTimer = undefined;
		followPaused = false;
		lastScrolledTo = -1;
		scrollToActive();
	}
	function onKeyScroll(e: KeyboardEvent) {
		if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) userScrolled();
	}
	function scrollToActive() {
		if (followPaused || active < 0 || active === lastScrolledTo) return;
		const el = lineEls[active];
		if (!el || typeof el.scrollIntoView !== "function") return;
		lastScrolledTo = active;
		try {
			el.scrollIntoView({ block: "center", behavior: "smooth" });
		} catch {
			el.scrollIntoView();
		}
	}
	$: if (active >= 0 && lines) tick().then(scrollToActive);

	// ---- font size ----
	let size: Size = "m";
	function setSize(s: Size) {
		size = s;
		try {
			localStorage.setItem(FONT_KEY, s);
		} catch {
			/* ignore */
		}
	}
	function step(delta: 1 | -1) {
		const i = SIZES.indexOf(size) + delta;
		if (i >= 0 && i < SIZES.length) setSize(SIZES[i]);
	}

	onMount(() => {
		// Safety net (audit UX v4 TOP 1): the fullscreen player never stays over the lyrics.
		fullscreenStore.set("closed");
		try {
			const s = localStorage.getItem(FONT_KEY);
			if (s === "s" || s === "m" || s === "l") size = s;
		} catch {
			/* ignore */
		}
		online = navigator.onLine;
		const on = () => (online = true);
		const off = () => (online = false);
		window.addEventListener("online", on);
		window.addEventListener("offline", off);
		window.addEventListener("wheel", userScrolled, { passive: true });
		window.addEventListener("touchmove", userScrolled, { passive: true });
		window.addEventListener("keydown", onKeyScroll);
		return () => {
			window.removeEventListener("online", on);
			window.removeEventListener("offline", off);
			window.removeEventListener("wheel", userScrolled);
			window.removeEventListener("touchmove", userScrolled);
			window.removeEventListener("keydown", onKeyScroll);
		};
	});
	onDestroy(() => {
		if (resumeTimer) clearTimeout(resumeTimer);
	});
</script>

<main
	class="size-{size}"
	data-lyrics-size={size}
>
	{#if $currentTrack}
		<header>
			<h1>{$currentTrack.title}</h1>
			<span class="sub">{$currentTrack?.artistInfo?.artist?.[0]?.text || $currentTrack?.subtitle?.[0]?.text || ""}</span>
		</header>
		<div
			class="toolbar"
			role="toolbar"
			aria-label="Affichage des paroles"
		>
			<span
				class="mode"
				id="lyrics-mode"
				data-synced={hasSynced}
			>
				{#if loading}
					Chargement…
				{:else if !lyrics?.found}
					Pas de paroles
				{:else if hasSynced}
					Paroles synchronisées
				{:else}
					Paroles brutes
				{/if}
				{#if fromCache && lyrics?.found}<span class="dot">·</span>hors-ligne{/if}
			</span>
			<div
				class="font"
				role="group"
				aria-label="Taille du texte"
			>
				<button
					class="fbtn"
					id="lyrics-font-minus"
					type="button"
					aria-label="Réduire la taille du texte"
					title="Réduire la taille du texte"
					disabled={size === "s"}
					on:click={() => step(-1)}>A-</button
				>
				<button
					class="fbtn"
					id="lyrics-font-plus"
					type="button"
					aria-label="Agrandir la taille du texte"
					title="Agrandir la taille du texte"
					disabled={size === "l"}
					on:click={() => step(1)}>A+</button
				>
			</div>
		</div>
	{/if}

	{#if loading}
		<p class="state">Chargement des paroles…</p>
	{:else if lyrics?.found}
		{#if hasSynced}
			<div
				class="synced"
				id="lyrics-synced"
			>
				{#each lines ?? [] as ln, i}
					<button
						class="line"
						class:active={i === active}
						class:past={i < active}
						type="button"
						data-lyrics-line={i}
						data-t={ln.t}
						aria-label="Aller à {mmss(ln.t)}"
						aria-current={i === active ? "true" : undefined}
						bind:this={lineEls[i]}
						on:click={() => seekTo(ln.t)}
					>
						{ln.text || "♪"}
					</button>
				{/each}
			</div>
			{#if followPaused}
				<button
					class="follow"
					id="lyrics-follow"
					type="button"
					on:click={resumeFollow}>Reprendre le suivi</button
				>
			{/if}
		{:else}
			<pre
				class="plain"
				id="lyrics-plain">{lyrics.plain}</pre>
		{/if}
		{#if lyrics.source}<small class="src">via {lyrics.source}</small>{/if}
	{:else if $currentTrack}
		<p class="state">
			{#if !online}
				Paroles indisponibles hors connexion : elles n'ont pas encore été consultées pour ce morceau.
			{:else}
				Pas de paroles trouvées pour ce morceau.
			{/if}
		</p>
	{:else}
		<EmptyState
			icon="play"
			title="Lance un morceau pour voir ses paroles"
			text="Les paroles du morceau en cours s'affichent ici, synchronisées quand elles existent."
			cta="Explorer"
			href="/home"
		/>
	{/if}
</main>

<style lang="scss">
	$text: var(--color-dark, #fafafa);
	$muted: #b3b3b3;
	$accent: #1ed760;

	main {
		min-height: 100%;
		padding-bottom: 6rem;
		max-width: 44rem;
		margin: 0 auto;
		text-align: center;
		--lyrics-size: 1.35rem;
		--lyrics-plain: 1.15rem;
		&.size-s {
			--lyrics-size: 1.1rem;
			--lyrics-plain: 1rem;
		}
		&.size-l {
			--lyrics-size: 1.7rem;
			--lyrics-plain: 1.4rem;
		}
	}
	header {
		margin-bottom: 0.75rem;
	}
	.sub {
		color: #999;
	}
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin: 0 0 1.25rem;
		padding: 0 0.25rem;
	}
	.mode {
		color: $muted;
		font-size: 0.85rem;
		text-align: left;
	}
	.dot {
		margin: 0 0.3em;
	}
	.font {
		display: flex;
		gap: 0.3rem;
	}
	// Overrides of the global %button-base (dark text !important, capitalize…).
	.fbtn,
	.follow,
	.line {
		font: inherit;
		text-transform: none;
		box-shadow: none !important;
		color: $text !important;
		cursor: pointer;
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
		}
	}
	.fbtn {
		// 12px root on phones: 2.75rem is 33px, keep a 44px target (audit UX v4 3.7).
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		padding: 0 0.6rem;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 1rem;
		font-weight: 600;
		line-height: 1;
		background: rgba(255, 255, 255, 0.08) !important;
		border: 1px solid rgba(255, 255, 255, 0.15) !important;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.16) !important;
			border-color: rgba(255, 255, 255, 0.3) !important;
			color: $text !important;
		}
		&:disabled {
			opacity: 0.45;
			cursor: not-allowed;
			background: rgba(255, 255, 255, 0.06) !important;
			border-color: rgba(255, 255, 255, 0.12) !important;
		}
	}
	.synced {
		display: flex;
		flex-direction: column;
		align-items: stretch;
	}
	.line {
		display: block;
		width: 100%;
		min-height: max(2.75rem, 44px);
		margin: 0;
		padding: 0.35rem 0.75rem;
		border: 0 !important;
		border-radius: 0.5rem;
		background: transparent !important;
		font-size: var(--lyrics-size);
		line-height: 1.5;
		font-weight: 500;
		text-align: center;
		white-space: normal;
		overflow-wrap: anywhere;
		color: #8a8a8a !important;
		transition: color 0.2s, transform 0.2s, background 0.15s;
		&:hover,
		&:focus,
		&:focus-within {
			background: rgba(255, 255, 255, 0.07) !important;
			border-color: transparent !important;
			color: #d4d4d4 !important;
		}
		&:active {
			background: rgba(255, 255, 255, 0.12) !important;
			color: $text !important;
		}
		&.past {
			color: #a8a8a8 !important;
		}
		&.active,
		&.active:focus,
		&.active:active {
			color: #fff !important;
			font-weight: 700;
			transform: scale(1.04);
		}
	}
	.follow {
		position: fixed;
		left: 50%;
		bottom: 7rem;
		transform: translateX(-50%);
		z-index: 20;
		min-height: 2.75rem;
		padding: 0.5rem 1.1rem;
		border-radius: 999px;
		border: 1px solid rgba(30, 215, 96, 0.6) !important;
		background: #161616 !important;
		font-size: 0.95rem;
		font-weight: 600;
		white-space: nowrap;
		&:hover,
		&:focus,
		&:active {
			background: #222 !important;
			border-color: $accent !important;
			color: $text !important;
		}
	}
	.plain {
		white-space: pre-wrap;
		font-family: inherit;
		font-size: var(--lyrics-plain);
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
