<script lang="ts">
	// Offline library: every track played is cached automatically ($lib/offline,
	// service worker). This page lists the cache by album / artist / recency and
	// starts playback from the cached copies only (see $lib/offlineQueue.play),
	// so it works with no connection at all.
	//
	// Styling note: the global redesign stylesheet applies `%button-base` to every
	// `button:not(.icon-btn)` with `color: #0f0f0f !important`, `display: inline-flex`,
	// `text-transform: capitalize` and `!important` backgrounds on hover/active/
	// disabled. Every button below therefore carries explicit overrides (with
	// `!important` only where the global rule itself uses it) so labels stay
	// readable on the dark background and titles can stack on mobile.
	import Icon from "$components/Icon/Icon.svelte";
	import EmptyState from "$components/EmptyState/EmptyState.svelte";
	import AlbumCard from "$components/Offline/AlbumCard.svelte";
	import OfflineTrackRow from "$components/Offline/OfflineTrackRow.svelte";
	import MixtapeSheet from "$components/Offline/MixtapeSheet.svelte";
	import {
		cacheTrackOffline,
		downloadForOffline,
		getOfflineTracks,
		isStableAudioUrl,
		listCachedAudio,
		recacheEvicted,
		removeOffline,
		reconcileOfflineList,
		pinOffline,
	} from "$lib/offline";
	import {
		formatBytes,
		groupByAlbum,
		groupByArtist,
		play,
		recentlyCached,
		totalBytes,
		type AlbumGroup,
		type ArtistGroup,
	} from "$lib/offlineQueue";
	import { currentTrack } from "$lib/stores/list";
	import { notify } from "$lib/utils";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	type View = "albums" | "artists" | "recent";

	let tracks: any[] = [];
	let online = true;
	let view: View = "albums";
	let openAlbums: Record<string, boolean> = {};
	let openArtists: Record<string, boolean> = {};
	let starting = false;
	// Mixtape options sheet (idea O3): opened from the Mixtape button; `lastPlayed`
	// comes from the service worker's audio index (`lastAccess` = last time the
	// cached audio was served, i.e. last played on this device): undefined while
	// loading, null when unavailable (option disabled in the sheet).
	let mixtapeOpen = false;
	let lastPlayed: Map<string, number> | null | undefined = undefined;
	let mixtapeBtn: HTMLButtonElement;

	$: albums = groupByAlbum(tracks) as AlbumGroup[];
	$: ready = tracks.filter((t) => t?._cached === true);
	$: artists = groupByArtist(tracks) as ArtistGroup[];
	$: recent = recentlyCached(tracks, -1);
	$: size = formatBytes(totalBytes(tracks));
	// Only entries acknowledged by the service worker (`_cached === true`) are
	// playable offline; `_cached === false` = download still in flight, unless
	// `_evicted` (the SW dropped it: "à retélécharger", not "en cours", G8).
	$: readyCount = tracks.filter((t) => t?._cached === true).length;
	$: evictedCount = tracks.filter((t) => t?._evicted === true).length;
	$: pendingCount = tracks.filter((t) => t?._cached === false && t?._evicted !== true).length;
	// Re-download of the evicted entries (global button): 0 = idle.
	let recaching = 0;
	$: canPlay = readyCount > 0;
	$: canShuffle = readyCount >= 2;
	$: canMixtape = readyCount >= 2;
	$: readyHint =
		readyCount === 0
			? "Aucun morceau prêt pour l'instant"
			: `${readyCount} ${readyCount > 1 ? "morceaux prêts" : "morceau prêt"} sur ${tracks.length}`;
	$: playTitle = canPlay
		? `Lire les ${readyCount} ${readyCount > 1 ? "morceaux prêts" : "morceau prêt"}`
		: "Aucun morceau prêt : la mise en cache est en cours";
	$: shuffleTitle = canShuffle
		? "Lecture aléatoire des morceaux prêts"
		: `Il faut au moins 2 morceaux prêts pour l'aléatoire (${readyHint})`;
	$: mixtapeTitle = canMixtape
		? "Mixtape : enchaîne les morceaux prêts en variant les artistes"
		: `Il faut au moins 2 morceaux prêts pour une mixtape (${readyHint})`;
	$: activeId = $currentTrack?.videoId || "";
	// Header counter (audit v5 3.7): parts joined by " · " (one space each side),
	// rendered on one line so the template adds no stray whitespace.
	$: statParts = [
		{ text: `${tracks.length} ${tracks.length > 1 ? "morceaux" : "morceau"}`, cls: "" },
		{ text: size, cls: "" },
		{ text: albums.length ? `${albums.length} ${albums.length > 1 ? "albums" : "album"}` : "", cls: "" },
		{ text: pendingCount ? `${pendingCount} en cours de mise en cache` : "", cls: "pending" },
		{ text: evictedCount ? `${evictedCount} à retélécharger` : "", cls: "evicted" },
	].filter((p) => p.text);

	function refresh() {
		tracks = getOfflineTracks();
		// Reconcile the localStorage list with what the service worker really holds (lane c1b),
		// then re-read so _cached flags and evicted entries are accurate.
		Promise.resolve(reconcileOfflineList()).then(() => { tracks = getOfflineTracks(); }).catch(() => {});
	}

	onMount(() => {
		online = navigator.onLine;
		refresh();
		try {
			const v = localStorage.getItem("ytm-offline-view");
			if (v === "albums" || v === "artists" || v === "recent") view = v;
		} catch {
			/* ignore */
		}
		const on = () => (online = true);
		const off = () => (online = false);
		const storage = (e: StorageEvent) => {
			if (!e.key || e.key === "ytm-offline-tracks") refresh();
		};
		const visible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		// J11: the SW tells every tab when it evicted entries (playback in
		// another tab may have triggered the LRU): re-list so the rows flip
		// to "à retélécharger" here too.
		const sw = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null;
		const evicted = (e: MessageEvent) => {
			if (e.data && e.data.type === "audio-evicted") refresh();
		};
		window.addEventListener("online", on);
		window.addEventListener("offline", off);
		window.addEventListener("storage", storage);
		document.addEventListener("visibilitychange", visible);
		sw?.addEventListener("message", evicted);
		return () => {
			window.removeEventListener("online", on);
			window.removeEventListener("offline", off);
			window.removeEventListener("storage", storage);
			document.removeEventListener("visibilitychange", visible);
			sw?.removeEventListener("message", evicted);
		};
	});

	function setView(v: View) {
		view = v;
		try {
			localStorage.setItem("ytm-offline-view", v);
		} catch {
			/* ignore */
		}
	}

	async function start(items: any[], index = 0, opts: { shuffle?: boolean } = {}) {
		if (starting) return;
		starting = true;
		try {
			const ok = await play(items, index, opts);
			if (!ok) notify("Aucun morceau lisible hors-ligne dans cette sélection.", "error");
		} catch (err) {
			console.error("offline play failed", err);
			notify("Lecture hors-ligne impossible.", "error");
		} finally {
			starting = false;
		}
	}

	function playAll() {
		if (!canPlay) return notify(playTitle, "error");
		start(recent, 0);
	}
	function playShuffle() {
		if (!canShuffle) return notify(shuffleTitle, "error");
		start(recent, 0, { shuffle: true });
	}
	function openMixtape() {
		if (!canMixtape) return notify(mixtapeTitle, "error");
		if (mixtapeOpen) return closeMixtape();
		mixtapeOpen = true;
		lastPlayed = undefined;
		Promise.resolve(listCachedAudio())
			.then((l) => {
				const map = new Map<string, number>();
				for (const e of (l && Array.isArray(l.entries) ? l.entries : []) as any[]) {
					const at = Number(e?.lastAccess) || Number(e?.at) || 0;
					if (e?.videoId && at > 0) map.set(e.videoId, at);
				}
				lastPlayed = map.size ? map : null;
			})
			.catch(() => (lastPlayed = null));
	}
	function closeMixtape() {
		mixtapeOpen = false;
		mixtapeBtn?.focus();
	}
	function playMixtape(items: any[]) {
		mixtapeOpen = false;
		start(items, 0);
	}

	function remove(t: any) {
		removeOffline(t);
		refresh();
	}

	// One evicted row: re-download it (stable URL) and refresh (G8).
	async function recacheOne(t: any) {
		if (!t || !isStableAudioUrl(t._offlineUrl)) return notify("Ce morceau ne peut pas être retéléchargé d'ici", "error");
		tracks = tracks.map((x) => (x.videoId === t.videoId ? { ...x, _evicted: undefined } : x));
		const r = await cacheTrackOffline(t, t._offlineUrl);
		await refresh();
		if (r.ok) notify("Morceau retéléchargé", "success");
		else notify(r.reason === "quota" ? QUOTA_MSG : "Retéléchargement impossible pour l'instant", "error");
	}

	// Every evicted entry: recacheEvicted() runs them one by one; the header
	// counter says "N en cours" while it runs and the toast gives the tally.
	async function recacheAll() {
		if (recaching) return;
		recaching = evictedCount;
		try {
			const r = await recacheEvicted();
			await refresh();
			if (!r.total) notify("Aucun morceau à retélécharger", "success");
			else if (r.ok === r.total) notify(r.ok > 1 ? `${r.ok} morceaux retéléchargés` : "Morceau retéléchargé", "success");
			else notify(`${r.ok} retéléchargés sur ${r.total}`, "error");
		} finally {
			recaching = 0;
		}
	}

	// Toast when the SW refuses a pin because pinned bytes would exceed the quota (G7).
	const QUOTA_MSG = "Quota atteint, augmente-le dans Réglages";

	// Default size guess for a track not downloaded yet (no `_bytes`, empty cache).
	const EST_TRACK_BYTES = 8 * 1024 * 1024;

	// Download a not-yet-cached track (stable /localf or /aud URL straight to the
	// SW, otherwise through the API URL resolution), then pin it.
	async function downloadThenPin(t: any): Promise<{ status: "ok" | "quota" | "failed"; bytes: number }> {
		const r = isStableAudioUrl(t?._offlineUrl) ? await cacheTrackOffline(t, t._offlineUrl) : await downloadForOffline(t);
		if (!r.ok) return { status: /quota/.test(r.reason || "") ? "quota" : "failed", bytes: 0 };
		const p = await pinOffline(t, true);
		if (p.ok) return { status: "ok", bytes: Number(r.bytes) || 0 };
		return { status: p.reason === "quota" ? "quota" : "failed", bytes: 0 };
	}

	// One toast for a pin batch (H5): "N épinglés · K refusés (quota) · F impossibles".
	function pinSummary(total: number, pinnedCount: number, quotaCount: number, failedCount: number) {
		if (total === 1) {
			if (pinnedCount) return notify("Épinglé hors-ligne : jamais évincé", "success");
			if (quotaCount) return notify(QUOTA_MSG, "error");
			return notify("Impossible d'épingler ce morceau pour l'instant", "error");
		}
		if (pinnedCount === total) return notify(`${pinnedCount} morceaux épinglés hors-ligne`, "success");
		const parts = [`${pinnedCount} ${pinnedCount > 1 ? "épinglés" : "épinglé"} sur ${total}`];
		if (quotaCount) parts.push(`${quotaCount} ${quotaCount > 1 ? "refusés" : "refusé"} : ${QUOTA_MSG.charAt(0).toLowerCase()}${QUOTA_MSG.slice(1)}`);
		if (failedCount) parts.push(`${failedCount} ${failedCount > 1 ? "impossibles" : "impossible"} à télécharger ou épingler`);
		notify(parts.join(" · "), "error");
	}

	// Pin: a track (toggle) or an album ({ tracks, pinned }); pinned entries are
	// never evicted. A track not cached yet is downloaded first, then pinned (G6).
	// H5: the quota is checked BEFORE each download (pinned bytes + the track's
	// estimated size), the batch stops downloading once the quota blocks (no
	// download, hence no eviction, for a pin that would be refused), and the
	// result is ONE final toast (épinglés / refusés quota / impossibles); a
	// progress toast "M en cours de téléchargement" only says downloads started.
	async function pin(d: any) {
		const items: any[] = Array.isArray(d?.tracks) ? d.tracks : [d];
		const album = Array.isArray(d?.tracks);
		const pinned = album ? !!d.pinned : !d?._pinned;
		const total = items.length;
		if (!pinned) {
			let ok = 0;
			for (const t of items) if ((await pinOffline(t, false)).ok) ok++;
			await refresh();
			if (!ok) notify("Impossible de désépingler ce morceau", "error");
			else notify(ok > 1 ? (ok < total ? `${ok} désépinglés sur ${total}` : `${ok} morceaux désépinglés`) : "Désépinglé", "success");
			return;
		}
		let ok = 0;
		let failed = 0;
		let quotaHit = 0;
		const toDownload: any[] = [];
		for (const t of items) {
			const r = await pinOffline(t, true);
			if (r.ok) ok++;
			else if (r.reason === "not_cached") toDownload.push(t);
			else if (r.reason === "quota") quotaHit++;
			else failed++;
		}
		await refresh();
		if (!toDownload.length) return pinSummary(total, ok, quotaHit, failed);
		// The quota already refused a cached track: every download would be
		// refused too (and could evict other tracks for nothing).
		if (quotaHit) return pinSummary(total, ok, quotaHit + toDownload.length, failed);
		const l = await listCachedAudio().catch(() => null);
		const entries = (l && Array.isArray(l.entries) ? l.entries : []) as any[];
		const quota = Number(l?.quota) || 0;
		let pinnedBytes = Number(l?.pinnedBytes) || 0;
		const avg = entries.length ? Math.round(entries.reduce((s, e) => s + (Number(e?.bytes) || 0), 0) / entries.length) : 0;
		const estimate = (t: any) => Number(t?._bytes) || avg || EST_TRACK_BYTES;
		if (quota > 0 && pinnedBytes + estimate(toDownload[0]) > quota) return pinSummary(total, ok, toDownload.length, failed);
		notify(
			(ok ? `${ok} ${ok > 1 ? "épinglés" : "épinglé"} · ` : "") +
				`${toDownload.length} en cours de téléchargement…`,
			"success",
		);
		void (async () => {
			for (let i = 0; i < toDownload.length; i++) {
				const t = toDownload[i];
				if (quota > 0 && pinnedBytes + estimate(t) > quota) {
					quotaHit += toDownload.length - i;
					break;
				}
				const r = await downloadThenPin(t);
				if (r.status === "ok") {
					ok++;
					pinnedBytes += r.bytes || estimate(t);
				} else if (r.status === "quota") {
					quotaHit += toDownload.length - i;
					break;
				} else failed++;
			}
			await refresh();
			pinSummary(total, ok, quotaHit, failed);
		})();
	}
</script>

<main class="resp-content-width">
	<CollectionNav active="downloads-offline" />
	<header class="head">
		<div class="titles">
			<h1>Hors-ligne</h1>
			<!-- No counter on an empty cache (audit v4 3.6): the EmptyState below
			     already says it, "Aucun morceau en cache" was the same message twice. -->
			{#if tracks.length > 0}
				<p class="stats">{#each statParts as part, i}{#if i}{" · "}{/if}<span class={part.cls || undefined}>{part.text}</span>{/each}</p>
			{/if}
		</div>
		<!-- Only the offline state is worth a badge (audit v4 3.6): "● En ligne"
		     was a 10.8px green line under the counter with nothing to act on. -->
		{#if !online}
			<span class="status off">● Hors-ligne</span>
		{/if}
	</header>
	{#if tracks.length === 0}
		<!-- Empty state with one action (audit 2.4): the explanation lives here
		     instead of the .note above so it is not said twice on an empty page. -->
		<EmptyState
			icon="download"
			title="Aucun morceau hors-ligne pour l'instant"
			text="Chaque morceau que tu écoutes est enregistré ici automatiquement et se joue ensuite sans connexion."
			cta="Explorer"
			href="/home"
		/>
	{:else}
		<p class="note">
			Chaque morceau que tu écoutes est enregistré ici automatiquement et se joue sans connexion.
		</p>
		<div
			class="actions"
			role="group"
			aria-label="Lecture hors-ligne"
		>
			<button
				class="btn-primary"
				class:is-disabled={!canPlay}
				type="button"
				title={playTitle}
				aria-disabled={!canPlay || starting}
				aria-describedby={readyCount < tracks.length ? "offline-ready" : undefined}
				disabled={starting}
				on:click={playAll}
			>
				<Icon
					name="play"
					size="1em"
					fill="currentColor"
				/>
				Tout lire
			</button>
			<button
				class="cta btn-reset"
				class:is-disabled={!canShuffle}
				type="button"
				title={shuffleTitle}
				aria-disabled={!canShuffle || starting}
				aria-describedby={readyCount < tracks.length ? "offline-ready" : undefined}
				disabled={starting}
				on:click={playShuffle}
			>
				<Icon
					name="shuffle"
					size="1em"
				/>
				Aléatoire
			</button>
			<div class="mixtape-wrap">
				<button
					class="cta btn-reset"
					class:is-disabled={!canMixtape}
					id="offline-mixtape"
					type="button"
					title={mixtapeTitle}
					aria-disabled={!canMixtape || starting}
					aria-describedby={readyCount < tracks.length ? "offline-ready" : undefined}
					aria-haspopup="dialog"
					aria-expanded={mixtapeOpen}
					aria-controls="mixtape-sheet"
					disabled={starting}
					bind:this={mixtapeBtn}
					on:click={openMixtape}
				>
					<Icon
						name="radio"
						size="1em"
					/>
					Mixtape
				</button>
				{#if mixtapeOpen}
					<MixtapeSheet
						tracks={ready}
						{lastPlayed}
						on:close={closeMixtape}
						on:play={(e) => playMixtape(e.detail.items)}
					/>
				{/if}
			</div>
		</div>
		<!-- "N prêts sur M" only while some tracks are still being cached; when
		     every track is ready the header counter already says it all. -->
		{#if readyCount < tracks.length}
			<p
				class="ready"
				class:none={readyCount === 0}
				id="offline-ready"
				aria-live="polite"
			>
				{#if readyCount === 0 && !evictedCount}
					Aucun morceau prêt pour l'instant : {pendingCount || tracks.length} en cours de mise en cache. Ils
					apparaîtront ici dès qu'ils seront enregistrés.
				{:else}
					{readyHint}{#if pendingCount}<span class="dot">·</span>{pendingCount} en cours de mise en cache{/if}
					{#if evictedCount}<span class="dot">·</span>{evictedCount} à retélécharger (évincés du cache){/if}
					{#if !canShuffle}<span class="dot">·</span>aléatoire et mixtape dès 2 morceaux prêts{/if}
				{/if}
			</p>
		{/if}
		<!-- Evicted entries (F5/G8): the SW dropped them under quota pressure;
		     one button re-downloads them all (recacheEvicted, sequential). -->
		{#if evictedCount || recaching}
			<div class="recache-bar">
				<button
					class="cta btn-reset"
					id="offline-recache"
					type="button"
					aria-busy={!!recaching}
					aria-disabled={!!recaching || !online}
					disabled={!!recaching || !online}
					title={online ? "Retélécharger les morceaux que le cache a évincés" : "Hors connexion : disponible avec le réseau"}
					on:click={recacheAll}
				>
					<Icon
						name="download"
						size="1em"
					/>
					{#if recaching}Retéléchargement de {recaching}…{:else}Retélécharger les évincés ({evictedCount}){/if}
				</button>
			</div>
		{/if}

		<nav
			class="views"
			aria-label="Vue"
		>
			<button
				type="button"
				class:active={view === "albums"}
				aria-pressed={view === "albums"}
				on:click={() => setView("albums")}>Albums</button
			>
			<button
				type="button"
				class:active={view === "artists"}
				aria-pressed={view === "artists"}
				on:click={() => setView("artists")}>Artistes</button
			>
			<button
				type="button"
				class:active={view === "recent"}
				aria-pressed={view === "recent"}
				on:click={() => setView("recent")}>Récents</button
			>
		</nav>

		{#if view === "albums"}
			<section>
				{#each albums as album (album.key)}
					<AlbumCard
						{album}
						{activeId}
						{online}
						bind:open={openAlbums[album.key]}
						on:play={(e) => start(e.detail.tracks, e.detail.index, { shuffle: e.detail.shuffle })}
						on:remove={(e) => remove(e.detail)}
						on:pin={(e) => pin(e.detail)}
						on:recache={(e) => recacheOne(e.detail)}
					/>
				{/each}
			</section>
		{:else if view === "artists"}
			<section>
				{#each artists as artist (artist.key)}
					{@const open = openArtists[artist.key] ?? artists.length <= 3}
					{@const flat = artist.albums.flatMap((a) => a.tracks)}
					{@const soloAlbum = artist.albums.length === 1 && !artist.albums[0].isSingles ? artist.albums[0].name : ""}
					<!-- Audit v5 TOP 6b: one header per artist (count + play / shuffle),
					     the tracks right under it; no album sub-card repeating the
					     play / shuffle buttons and the "N pistes" meta. -->
					<div
						class="artist"
						class:active={!!activeId && artist.tracks.some((t) => t.videoId === activeId)}
					>
						<div class="artist-head">
							<button
								class="artist-name"
								type="button"
								aria-expanded={open}
								title={open ? "Replier l'artiste" : "Déplier l'artiste"}
								on:click={() => (openArtists[artist.key] = !open)}
							>
								<span
									class="chev"
									class:open
									aria-hidden="true">›</span
								>
								<span class="text">
									<span class="name">{artist.name}</span>
									<span class="sub"
										>{[
											soloAlbum,
											`${artist.tracks.length} ${artist.tracks.length > 1 ? "pistes" : "piste"}`,
											artist.albums.length > 1 ? `${artist.albums.length} albums` : "",
											formatBytes(artist.bytes),
										]
											.filter(Boolean)
											.join(" · ")}</span
									>
								</span>
							</button>
							<div class="artist-actions">
								<button
									class="btn"
									type="button"
									title="Lire l'artiste"
									aria-label="Lire l'artiste"
									on:click={() => start(flat, 0)}
								>
									<Icon
										name="play"
										size="1.1em"
										fill="currentColor"
									/>
								</button>
								<button
									class="btn"
									type="button"
									title="Artiste en aléatoire"
									aria-label="Artiste en aléatoire"
									on:click={() => start(artist.tracks, 0, { shuffle: true })}
								>
									<Icon
										name="shuffle"
										size="1.1em"
									/>
								</button>
							</div>
						</div>
						{#if open}
							<div class="artist-albums">
								{#each artist.albums as album (album.key)}
									{#if artist.albums.length > 1}
										<p class="album-label">{album.name}</p>
									{/if}
									{#each album.tracks as t, i (t.videoId)}
										<OfflineTrackRow
											track={t}
											number={album.isSingles ? undefined : i + 1}
											showArtist={false}
											active={t.videoId === activeId}
											{online}
											on:play={() => start(flat, flat.indexOf(t))}
											on:remove={(e) => remove(e.detail)}
											on:pin={(e) => pin(e.detail)}
											on:recache={(e) => recacheOne(e.detail)}
										/>
									{/each}
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</section>
		{:else}
			<section class="list">
				{#each recent as t, i (t.videoId)}
					<OfflineTrackRow
						track={t}
						active={t.videoId === activeId}
						{online}
						on:play={() => start(recent, i)}
						on:remove={(e) => remove(e.detail)}
						on:pin={(e) => pin(e.detail)}
						on:recache={(e) => recacheOne(e.detail)}
					/>
				{/each}
			</section>
		{/if}
	{/if}
</main>

<style lang="scss">
	// Project text colour (light on dark) as defined in global/_css-variables.scss.
	$text: var(--color-dark, #fafafa);
	$muted: #b3b3b3; // ≥ 9:1 on the page background
	$accent: #1ed760;
	$warn: #e0a000;

	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	.head {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		justify-content: space-between;
	}
	.titles {
		min-width: 0;
	}
	h1 {
		margin-bottom: 0.15rem;
	}
	.stats {
		margin: 0;
		color: #bbb;
		font-size: 0.9rem;
	}
	.pending,
	.evicted {
		color: $warn;
	}
	.evicted {
		font-weight: 600;
	}
	.recache-bar {
		margin: 0 0 1rem;
	}
	.status {
		color: $accent;
		font-size: 0.9rem;
		white-space: nowrap;
		margin-top: 0.4rem;
	}
	.status.off {
		color: $warn;
	}
	.note {
		color: #999;
		font-size: 0.9rem;
		margin: 0.5rem 0 1rem;
	}
	.dot {
		margin: 0 0.3em;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	// Anchor for the desktop mixtape popover (MixtapeSheet is absolute inside).
	.mixtape-wrap {
		position: relative;
		display: inline-flex;
	}
	.ready {
		margin: 0 0 1rem;
		font-size: 0.85rem;
		color: $muted;
		&.none {
			color: $warn;
			border: 1px solid rgba(224, 160, 0, 0.35);
			background: rgba(224, 160, 0, 0.08);
			border-radius: 0.5rem;
			padding: 0.5rem 0.75rem;
		}
	}
	// Pill CTA. Overrides the global %button-base (dark text !important,
	// capitalize, 0.15em border, 1.1rem font) so the label is readable.
	.cta {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		padding: 0.55rem 1rem;
		min-height: max(2.75rem, 44px); // px floor: mobile root font is 12px (audit v4 TOP 3)
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.18) !important;
		background: rgba(255, 255, 255, 0.08) !important;
		color: $text !important;
		box-shadow: none !important;
		font: inherit;
		font-size: 1rem;
		font-weight: 600;
		line-height: 1.2;
		text-transform: none;
		white-space: nowrap;
		cursor: pointer;
		// :focus / :focus-within / :active are listed explicitly: the global
		// `button:not(.icon-btn):focus` (0,2,1) would otherwise paint a light
		// grey background under our light text.
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.16) !important;
			border-color: rgba(255, 255, 255, 0.3) !important;
			color: $text !important;
			box-shadow: none !important;
		}
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
		}
		&:disabled,
		&.is-disabled {
			opacity: 0.6;
			cursor: not-allowed;
			background: rgba(255, 255, 255, 0.06) !important;
			border-color: rgba(255, 255, 255, 0.12) !important;
			color: $text !important;
			&:hover,
			&:focus,
			&:focus-within,
			&:active {
				background: rgba(255, 255, 255, 0.06) !important;
				border-color: rgba(255, 255, 255, 0.12) !important;
				color: $text !important;
			}
		}
	}
	// View switcher: label always visible (light text) and 44px tall
	// (px floor, audit v4 TOP 3: 2.75rem alone was 33px on mobile).
	.views {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 0.9rem;
		button {
			display: inline-flex;
			align-items: center;
			min-height: max(2.75rem, 44px);
			padding: 0 0.95rem;
			border: 1px solid transparent !important;
			border-radius: 1.4rem;
			background: rgba(255, 255, 255, 0.06) !important;
			color: #d4d4d4 !important; // ≈ 13:1 on the dark background
			box-shadow: none !important;
			font: inherit;
			font-size: 1rem;
			font-weight: 500;
			line-height: 1.2;
			text-transform: none;
			white-space: nowrap;
			cursor: pointer;
			&:hover,
			&:focus,
			&:focus-within,
			&:active {
				background: rgba(255, 255, 255, 0.12) !important;
				border-color: transparent !important;
				color: $text !important;
			}
			&:focus-visible {
				outline: 2px solid $accent;
				outline-offset: 2px;
			}
			&.active,
			&.active:focus,
			&.active:active {
				background: rgba(255, 255, 255, 0.18) !important;
				border-color: rgba(255, 255, 255, 0.28) !important;
				color: $text !important;
				font-weight: 600;
			}
		}
	}
	.artist {
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		padding: 0.35rem 0 0.5rem;
		margin-bottom: 0.4rem;
		&.active .name {
			color: $accent;
		}
	}
	// Group header: name button + round action buttons. Sized to its container
	// (border-box, width 100%, inline-end padding) and allowed to wrap so the
	// action buttons never cross the viewport edge on 390px screens.
	.artist-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		box-sizing: border-box;
		width: 100%;
		max-width: 100%;
		padding-inline-end: 0.5rem;
	}
	// Artist toggle: chevron + (name / meta). Meta sits beside the name on wide
	// screens and stacks under it on mobile; the name never overlaps the meta.
	.artist-name {
		flex: 1 1 10rem;
		min-width: 0;
		max-width: 100%;
		box-sizing: border-box;
		min-height: max(2.75rem, 44px);
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: none !important;
		border: 0 !important;
		box-shadow: none !important;
		color: $text !important;
		font: inherit;
		font-size: 1rem;
		line-height: 1.3;
		padding: 0.3rem 0;
		text-transform: none;
		white-space: normal;
		cursor: pointer;
		text-align: left;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: none !important;
			border-color: transparent !important;
			color: $text !important;
		}
		&:hover .name {
			text-decoration: underline;
		}
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
			border-radius: 0.4rem;
		}
		.text {
			flex: 1;
			min-width: 0;
			display: flex;
			align-items: baseline;
			gap: 0.5rem;
		}
		.name {
			font-weight: 600;
			font-size: 1.05rem;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.sub {
			color: $muted;
			font-size: 0.85rem;
			white-space: nowrap;
			flex: 0 0 auto;
		}
		.chev {
			display: inline-grid;
			place-items: center;
			flex: 0 0 auto;
			width: 1rem;
			font-size: 1.3rem;
			line-height: 1;
			color: $muted;
			transition: transform 150ms ease;
			&.open {
				transform: rotate(90deg);
			}
		}
	}
	.artist-actions {
		display: flex;
		gap: 0.3rem;
		flex: 0 0 auto;
		margin-left: auto;
	}
	// Round icon button, 44px (px floor, audit v4 TOP 3), light icon
	// (overrides the global dark-text rule).
	.btn {
		flex: 0 0 auto;
		box-sizing: border-box;
		width: auto;
		height: auto;
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		padding: 0;
		border-radius: 999px;
		display: grid;
		place-items: center;
		background: rgba(255, 255, 255, 0.08) !important;
		border: 1px solid rgba(255, 255, 255, 0.15) !important;
		box-shadow: none !important;
		color: $text !important;
		line-height: 1;
		cursor: pointer;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.16) !important;
			border-color: rgba(255, 255, 255, 0.3) !important;
			color: $text !important;
		}
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
		}
	}
	.artist-albums {
		padding-left: 0.5rem;
		margin-top: 0.3rem;
	}
	// Album name between rows when an artist has several albums (plain text,
	// no buttons, no count: the header already gives it).
	.album-label {
		margin: 0.5rem 0 0.15rem 0.5rem;
		color: $muted;
		font-size: 0.85rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (max-width: 640px) {
		.head {
			flex-direction: column;
			gap: 0.25rem;
		}
		.status {
			margin-top: 0;
		}
		.artist-name .text {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.1rem;
		}
		.artist-name .name {
			white-space: normal;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow-wrap: anywhere;
		}
		.artist-name .sub {
			white-space: normal;
		}
		.artist-albums {
			padding-left: 0;
		}
	}
</style>
