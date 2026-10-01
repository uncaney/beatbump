<script lang="ts">
	import { goto } from "$app/navigation";
	import Icon from "$lib/components/Icon/Icon.svelte";
	import { queryParams } from "$lib/utils";
	import { debounce } from "$lib/utils/sync";
	import { settings } from "$stores/settings";
	import { createEventDispatcher, onDestroy, onMount } from "svelte";
	import { fullscreenStore } from "../Player/channel";
	import { searchFilter } from "./options";
	import { APIClient } from "$lib/api";
	import { browser } from "$app/environment";
	import SessionListService from "$lib/stores/list";
	import { isLocalTrackId } from "$lib/stores/list/sessionList";
	import { buildResumeRow, readLastTrack } from "$lib/homeRows";
	import { getRecent } from "$lib/me";
	import { getOfflineTracks } from "$lib/offline";
	import { entityHref } from "$lib/local";
	import type { Item } from "$lib/types";

	export let type: "inline";
	export let query = "";
	export let filter = searchFilter[0].params;

	const dispatch = createEventDispatcher();
	let results: Array<{ query: string; id: string }> = [];
	let listbox: HTMLUListElement | null = null;
	let recentSearches: string[] = [];
	let showRecentSearches = false;

	// Local-first suggestions (R1): the owned library (Meili, typo tolerant) is
	// queried from the first letter and rendered ABOVE the YouTube suggestions.
	const LOCAL_SONGS_MAX = 5;
	const LOCAL_ARTISTS_MAX = 3;
	const LOCAL_DEBOUNCE_MS = 150;
	let localSongs: Item[] = [];
	let localArtists: Item[] = [];
	let localTimer: ReturnType<typeof setTimeout> | null = null;
	let localAbort: AbortController | null = null;
	let localSeq = 0;
	// YouTube suggestions get the same guard (audit v3 G12): a slow "da"
	// response must not overwrite the "daft" one that arrived first, nor
	// reopen the list after the box was emptied / submitted / closed.
	let ytAbort: AbortController | null = null;
	let ytSeq = 0;

	$: localRows = [
		...localSongs.slice(0, LOCAL_SONGS_MAX),
		...localArtists.slice(0, LOCAL_ARTISTS_MAX),
	];
	$: hasLocal = localRows.length > 0;

	// "Reprendre" (audit v3 3.3): with an empty box the overlay also lists the
	// last RESUME_MAX played local tracks (lastTrack + me/stats/recent, the
	// offline cache as fallback), as playable rows under the recent searches.
	// Loaded 150 ms after mount; typing before that cancels the load.
	const RESUME_MAX = 5;
	const RESUME_DEBOUNCE_MS = 150;
	let resumeRows: Item[] = [];
	let resumeTimer: ReturnType<typeof setTimeout> | null = null;

	// The local block shows the resume rows while the box is empty, the
	// library hits (songs then artists) once the user types.
	$: localBlock = showRecentSearches ? resumeRows : localRows;

	// "Tendances" (audit v4 TOP 7 / 3.3): a fresh profile has neither resume
	// rows nor recent searches, so the empty overlay used to show nothing.
	// Fallback: TRENDING_MAX items of /api/v1/trending (cached 5 min server
	// side), the "Trending" songs carousel first, any non-empty one otherwise;
	// the recently added local songs if trending fails (YouTube down/offline).
	const TRENDING_MAX = 6;
	let trendingRows: Item[] = [];
	let trendingRequested = false;
	let destroyed = false;
	$: showTrending =
		showRecentSearches &&
		resumeRows.length === 0 &&
		recentSearches.length === 0 &&
		trendingRows.length > 0;

	onMount(() => {
		if (browser) {
			const stored = localStorage.getItem("recentSearches");
			if (stored) {
				recentSearches = JSON.parse(stored);
			}
			showRecentSearches = true;
			scheduleResume();
		}
	});

	onDestroy(() => {
		destroyed = true;
		cancelLocal();
		cancelResume();
	});

	function cancelResume() {
		if (resumeTimer) {
			clearTimeout(resumeTimer);
			resumeTimer = null;
		}
	}

	function scheduleResume() {
		cancelResume();
		resumeTimer = setTimeout(() => {
			resumeTimer = null;
			void loadResume();
		}, RESUME_DEBOUNCE_MS);
	}

	async function loadResume() {
		let last: Item | null = null;
		try {
			last = readLastTrack(localStorage) as Item | null;
		} catch {
			last = null;
		}
		let recent: any[] = [];
		try {
			const r = await getRecent(RESUME_MAX * 4);
			recent = Array.isArray(r?.items) ? r.items : [];
		} catch {
			recent = [];
		}
		if (recent.length === 0) {
			// Offline / fresh profile: the cached tracks, most recent first.
			try {
				recent = getOfflineTracks()
					.slice()
					.sort((a: any, b: any) => (b?._at ?? 0) - (a?._at ?? 0));
			} catch {
				recent = [];
			}
		}
		resumeRows = buildResumeRow(last, recent, RESUME_MAX * 4)
			.filter((it) => isLocalTrackId(it?.videoId))
			.slice(0, RESUME_MAX) as Item[];
		if (resumeRows.length === 0 && recentSearches.length === 0) {
			void loadTrending();
		}
	}

	async function loadTrending() {
		if (trendingRequested || destroyed) return;
		trendingRequested = true;
		let rows: Item[] = [];
		try {
			const res = await APIClient.fetch(`/api/v1/trending`);
			if (res.ok) {
				const data = await res.json();
				const carousels: any[] = Array.isArray(data?.carousels)
					? data.carousels
					: [];
				const withItems = carousels.filter(
					(c) => Array.isArray(c?.items) && c.items.length > 0,
				);
				const pick =
					withItems.find((c) => /trending|tendance/i.test(c?.header?.title ?? "")) ??
					withItems[0];
				rows = (pick?.items ?? [])
					.filter((it: any) => it?.title && (it?.videoId || it?.endpoint?.browseId))
					.slice(0, TRENDING_MAX);
			}
		} catch {
			rows = [];
		}
		if (rows.length === 0) {
			try {
				const res = await APIClient.fetch(
					`/api/v1/local/songs?limit=${TRENDING_MAX}&sort=dateAdded:desc`,
				);
				const data = res.ok ? await res.json() : { items: [] };
				rows = Array.isArray(data?.items) ? data.items.slice(0, TRENDING_MAX) : [];
			} catch {
				rows = [];
			}
		}
		if (destroyed) return;
		trendingRows = rows;
	}

	/** A trending song plays (local lid = local mix), an album/playlist opens. */
	async function activateTrending(item: Item) {
		const vid = item?.videoId;
		if (vid) {
			if (isLocalTrackId(vid)) {
				await playLocalSong(item);
				return;
			}
			closeOverlay();
			await SessionListService.initAutoMixSession({
				videoId: vid,
				playlistId: (item as any)?.playlistId,
				clickedItem: item,
			});
			return;
		}
		const ep = (item as any)?.endpoint;
		if (!ep?.browseId) return;
		closeOverlay();
		goto(entityHref(ep.browseId, ep.pageType));
	}

	function trendingSubtitle(item: Item): string {
		const sub = Array.isArray(item?.subtitle) ? item.subtitle : [];
		return (
			item?.artistInfo?.artist?.[0]?.text ??
			sub
				.map((s: any) => s?.text ?? "")
				.join("")
				.trim()
		);
	}

	function addToRecentSearches(searchQuery: string) {
		if (!browser) return;

		recentSearches = [
			searchQuery,
			...recentSearches.filter((s) => s !== searchQuery),
		].slice(0, 5);
		localStorage.setItem("recentSearches", JSON.stringify(recentSearches));
	}

	async function handleSubmit() {
		if (!query.length) return;
		cancelLocal();
		addToRecentSearches(query);
		dispatch("submitted", { submitted: true, filter, query });
		fullscreenStore.set("closed");
		const params = queryParams({
			filter,
			restricted: $settings.search.Restricted,
		});
		let url = `/search/${encodeURIComponent(query)}?${params}`;
		goto(url);
	}

	/** Cancels the pending debounce and any in-flight local fetch. */
	function cancelLocal() {
		if (localTimer) {
			clearTimeout(localTimer);
			localTimer = null;
		}
		if (localAbort) {
			localAbort.abort();
			localAbort = null;
		}
		localSeq++;
		cancelYt();
	}

	/** Drops the in-flight YouTube suggestions request, if any. */
	function cancelYt() {
		if (ytAbort) {
			ytAbort.abort();
			ytAbort = null;
		}
		ytSeq++;
	}

	/** Debounced (150 ms) local lookup; a newer keystroke cancels the older one. */
	function scheduleLocal() {
		cancelLocal();
		const q = query.trim();
		if (!q) {
			localSongs = [];
			localArtists = [];
			return;
		}
		showRecentSearches = false;
		cancelResume();
		localTimer = setTimeout(() => {
			localTimer = null;
			fetchLocal(q);
		}, LOCAL_DEBOUNCE_MS);
	}

	async function fetchLocal(q: string) {
		const controller = new AbortController();
		localAbort = controller;
		const seq = ++localSeq;
		const enc = encodeURIComponent(q);
		try {
			const [songsRes, artistsRes] = await Promise.all([
				APIClient.fetch(`/api/v1/local/songs?q=${enc}&limit=${LOCAL_SONGS_MAX}`, {
					signal: controller.signal,
				}),
				APIClient.fetch(
					`/api/v1/local/artists?q=${enc}&limit=${LOCAL_ARTISTS_MAX}`,
					{ signal: controller.signal },
				),
			]);
			const [songs, artists] = await Promise.all([
				songsRes.ok ? songsRes.json() : { items: [] },
				artistsRes.ok ? artistsRes.json() : { items: [] },
			]);
			// A newer keystroke (or a submit) superseded this lookup: drop it.
			if (seq !== localSeq) return;
			localSongs = Array.isArray(songs?.items) ? songs.items : [];
			localArtists = Array.isArray(artists?.items) ? artists.items : [];
		} catch (e) {
			if ((e as Error)?.name === "AbortError") return;
			if (seq !== localSeq) return;
			localSongs = [];
			localArtists = [];
		} finally {
			if (localAbort === controller) localAbort = null;
		}
	}

	function localArtistName(item: Item): string {
		return (
			item?.artistInfo?.artist?.[0]?.text ?? item?.subtitle?.[0]?.text ?? ""
		);
	}

	function localArtistBrowseId(item: Item): string {
		return (item as any)?.endpoint?.browseId ?? (item as any)?.browseId ?? "";
	}

	/** Closes the overlay (Nav listens to `submitted`) without navigating. */
	function closeOverlay() {
		cancelLocal();
		dispatch("submitted", { submitted: false, filter, query });
	}

	/**
	 * Plays an owned track straight from the overlay: one-item "local" mix
	 * (next/previous stay local, no continuation fetch), no /search navigation.
	 */
	async function playLocalSong(item: Item) {
		const lid = item?.videoId;
		if (!lid) return;
		closeOverlay();
		await SessionListService.initAutoMixSession({
			videoId: lid,
			clickedItem: item,
			mode: "local",
			localItems: [item],
		});
	}

	function openLocalArtist(item: Item) {
		const id = localArtistBrowseId(item);
		if (!id) return;
		closeOverlay();
		goto(`/artist/${id}`);
	}

	function activateLocal(item: Item, kind: "song" | "artist") {
		if (kind === "artist") openLocalArtist(item);
		else playLocalSong(item);
	}

	/** Group headers are not selectable: walk past them. */
	function skipHeaders(
		el: Element | null | undefined,
		dir: "next" | "prev",
	): HTMLElement | null {
		let cur = (el ?? null) as HTMLElement | null;
		while (cur && cur.classList.contains("group-header")) {
			cur = (
				dir === "next" ? cur.nextElementSibling : cur.previousElementSibling
			) as HTMLElement | null;
		}
		return cur;
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (!listbox) return;
		const target = event.target as HTMLLIElement;

		if (event.key === "ArrowDown") {
			if (
				target.nextElementSibling?.parentElement !== listbox &&
				target.id !== "searchBox"
			)
				return;

			const next = skipHeaders(
				target.nextElementSibling?.parentElement === listbox
					? (target.nextElementSibling as HTMLElement)
					: (listbox.querySelector("li") as HTMLLIElement),
				"next",
			);
			if (!next) return;

			next.tabIndex = 0;
			target.tabIndex = -1;
			next.focus();
		}
		if (event.key === "ArrowUp") {
			if (
				target.previousElementSibling?.parentElement !== listbox &&
				target.id !== "searchBox" &&
				target.parentElement?.previousElementSibling?.classList.contains(
					"nav-item",
				) !== true
			)
				return;

			const input =
				target.parentElement?.previousElementSibling?.classList.contains(
					"nav-item",
				) === true
					? (target.parentElement?.previousElementSibling?.querySelector<HTMLInputElement>(
							"input",
					  ) as HTMLInputElement)
					: null;

			const next =
				target.previousElementSibling?.parentElement === listbox
					? skipHeaders(target.previousElementSibling as HTMLElement, "prev") ??
					  input
					: input ?? (listbox.querySelector("li") as HTMLLIElement);
			if (!next) return;

			next.tabIndex = 0;
			target.tabIndex = -1;
			next.focus();
		}

		return false;
	}
	const typeahead = debounce(async () => {
		cancelYt();
		if (!query) {
			results = [];
			showRecentSearches = true;
			return;
		}
		showRecentSearches = false;
		const controller = new AbortController();
		ytAbort = controller;
		const seq = ytSeq;
		try {
			const response = await APIClient.fetch(
				`/api/v1/get_search_suggestions.json?q=` + encodeURIComponent(query),
				{ signal: controller.signal },
			);
			const data = await response.json();
			// A newer keystroke (or a submit / close) superseded this lookup.
			if (seq !== ytSeq) return;
			results = Array.isArray(data) ? data : [];
		} catch (e) {
			if ((e as Error)?.name === "AbortError") return;
			if (seq !== ytSeq) return;
			results = [];
		} finally {
			if (ytAbort === controller) ytAbort = null;
		}
	}, 250);
</script>

<!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
<form
	aria-expanded="true"
	aria-owns="suggestions"
	role="listbox"
	class={type}
	on:keydown={handleKeyDown}
	on:submit|preventDefault={handleSubmit}
>
	<div class="nav-item search-field">
		<div
			role="textbox"
			class="input search-input-wrapper"
		>
			<!-- svelte-ignore a11y-interactive-supports-focus -->
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<div
				role="button"
				aria-label="search button"
				class="searchBtn"
				on:click={handleSubmit}
			>
				<Icon
					name="search"
					size="1rem"
				/>
			</div>
			<!-- svelte-ignore a11y-autofocus -->
			<input
				aria-placeholder="Search"
				id="searchBox"
				autocomplete="off"
				aria-autocomplete="list"
				autofocus={type === "inline" ? true : false}
				autocorrect="off"
				type="search"
				placeholder="Search"
				on:input={scheduleLocal}
				on:keyup={(e) => {
					if (e.shiftKey && e.ctrlKey && e.repeat) return;
					typeahead();
				}}
				on:focus={() => {
					showRecentSearches = true;
				}}
				bind:value={query}
			/>
		</div>
	</div>
	{#if ((results.length > 0 || hasLocal) && !showRecentSearches) || (showRecentSearches && (recentSearches.length > 0 || resumeRows.length > 0 || showTrending))}
		<ul
			role="listbox"
			id="suggestions"
			bind:this={listbox}
			class="suggestions"
		>
			{#if showRecentSearches && recentSearches.length > 0}
				<li class="recent-searches-header group-header">Recent Searches</li>
				{#each recentSearches as recentQuery}
					<li
						tabindex="0"
						on:click={() => {
							query = recentQuery;
							handleSubmit();
						}}
						on:keydown={(e) => {
							if (e.key === " ") {
								query = recentQuery;
								handleSubmit();
							}
						}}
					>
						<Icon
							name="history"
							size="1rem"
							style="color: var(--text-secondary);"
						/>
						{recentQuery}
					</li>
				{/each}
			{/if}
			{#if localBlock.length > 0}
				<!-- One markup for both local blocks: "Reprendre" (empty box, last
				     played local tracks) and "Dans ta bibliothèque" (typed query). -->
				<li
					class="recent-searches-header group-header"
					data-testid={showRecentSearches ? "resume-header" : "local-suggestions-header"}
					>{showRecentSearches ? "Reprendre" : "Dans ta bibliothèque"}</li
				>
				{#each localBlock as item, i (item.videoId ?? localArtistBrowseId(item) ?? i)}
					{@const kind = showRecentSearches || i < Math.min(localSongs.length, LOCAL_SONGS_MAX) ? "song" : "artist"}
					<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
					<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
					<li
						tabindex="0"
						class="local-row"
						data-testid="local-suggestion"
						data-kind={kind}
						data-origin={showRecentSearches ? "resume" : "library"}
						data-lid={kind === "song" ? item.videoId : localArtistBrowseId(item)}
						on:click={() => activateLocal(item, kind)}
						on:keydown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								e.stopPropagation();
								activateLocal(item, kind);
							}
						}}
					>
						<Icon
							name={kind === "song" ? "play" : "artist"}
							size="1rem"
							style="color: var(--text-secondary);"
						/>
						<span class="local-text">
							<span class="local-title">{item.title}</span>
							{#if kind === "song" && localArtistName(item)}
								<span class="local-artist">{localArtistName(item)}</span>
							{/if}
						</span>
						<span class="local-badge">{showRecentSearches ? "reprendre" : "bibliothèque"}</span>
					</li>
				{/each}
			{/if}
			{#if showTrending}
				<li
					class="recent-searches-header group-header"
					data-testid="trending-header">Tendances</li
				>
				{#each trendingRows as item, i (item.videoId || item?.endpoint?.browseId || i)}
					<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
					<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
					<li
						tabindex="0"
						class="local-row"
						data-testid="trending-suggestion"
						on:click={() => activateTrending(item)}
						on:keydown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								e.stopPropagation();
								activateTrending(item);
							}
						}}
					>
						<Icon
							name={item.videoId ? "play" : "album"}
							size="1rem"
							style="color: var(--text-secondary);"
						/>
						<span class="local-text">
							<span class="local-title">{item.title}</span>
							{#if trendingSubtitle(item)}
								<span class="local-artist">{trendingSubtitle(item)}</span>
							{/if}
						</span>
						<span class="local-badge">tendance</span>
					</li>
				{/each}
			{/if}
			{#if !showRecentSearches}
				<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
				{#each results as result (result.id)}
					<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
					<li
						tabindex="0"
						on:click={() => {
							query = result.query;
							handleSubmit();
						}}
						on:keydown={(e) => {
							if (e.key === " ") {
								query = result.query;
								handleSubmit();
							}
						}}
					>
						{result.query}
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
	<div class="nav-item filter-field">
		<div
			class="select search-select-wrapper"
			class:inline={type === "inline" ? true : false}
		>
			<select bind:value={filter}>
				{#each searchFilter as option (option.params)}
					<option value={option.params}>{option.label}</option>
				{/each}
			</select>
		</div>
	</div>
</form>

<style lang="scss">
	.nav-item {
		margin: 0 0.4rem;
	}

	.suggestions {
		position: absolute;
		top: 5.5em;
		z-index: 200;
		background: var(--top-bg);
		width: 100%;
		width: clamp(28vw, 35vw, 78vw);

		border-radius: $xs-radius;
		height: auto;
		display: flex;
		flex-direction: column;
		touch-action: none;
		margin: 0 auto;

		&::after {
			position: absolute;
			inset: 0;
			border-radius: inherit;
			content: "";
			width: 100%;
			height: 100%;
			background: rgb(255 255 255 / 0.7%);
			z-index: -1;
			pointer-events: none;
			border: 0.0625rem solid hsl(0deg 0% 66.7% / 21.9%);
		}

		@media only screen and (max-width: 640px) {
			left: 0;
			width: 100%;
			right: 0;
			max-width: 100%;
		}
	}

	form.inline {
		position: absolute;
		height: 5em;
		touch-action: none;
		display: flex;
		justify-content: center;
		top: 0;
		left: 0;
		right: 0;
		width: 100%;

		// Phones (audit v4 TOP 7 bis): the box takes the whole row (>= 300 px
		// at 390 px) and the filter select shrinks to a compact pill on the
		// right, instead of a 190 px box next to a 130 px select.
		@media only screen and (max-width: 640px) {
			box-sizing: border-box;
			justify-content: stretch;
			align-items: center;
			gap: 0.375rem;
			padding-inline: 0.375rem;

			.nav-item {
				margin: 0;
			}

			.search-field {
				flex: 1 1 auto;
				min-width: 0;
			}

			.filter-field {
				flex: 0 0 auto;
			}

			.search-input-wrapper {
				width: 100%;
				min-width: 0;
				max-width: none;
			}

			.search-select-wrapper.inline {
				width: 5.75rem;
				min-width: 0;
				max-width: 5.75rem;

				select {
					padding-right: 1.6em;
					text-overflow: ellipsis;
					overflow: hidden;
				}
			}
		}
	}

	ul {
		padding: 0;
		margin: 0;
		list-style: none;
		background: inherit;

		.recent-searches-header {
			padding: 0.5em;
			font-size: 0.9em;
			color: var(--text-secondary);
			font-weight: 500;
			background: var(--top-bg);
			border-bottom: 1px solid hsl(0deg 0% 66.7% / 21.9%);
		}

		li {
			&:first-child {
				border-radius: $xs-radius $xs-radius 0 0;
			}

			&:last-child {
				border-radius: 0 0 $xs-radius $xs-radius;
			}

			transition: background-color cubic-bezier(0.47, 0, 0.745, 0.715) 80ms;
			padding: 1em 0.8em;
			z-index: 1;
			margin: 0;
			cursor: pointer;
			cursor: pointer;
			font-size: 1.2em;
			background: #0000;
			display: flex;
			align-items: center;
			gap: 0.5em;

			&:hover {
				background: rgb(255 255 255 / 10%);
			}
		}

		li.group-header {
			cursor: default;

			&:hover {
				background: var(--top-bg);
			}
		}

		li.local-row {
			padding-block: 0.7em;

			.local-text {
				display: flex;
				flex-direction: column;
				min-width: 0;
				flex: 1 1 auto;
				line-height: 1.2;
			}

			.local-title {
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.local-artist {
				font-size: 0.75em;
				color: var(--text-secondary);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.local-badge {
				flex: 0 0 auto;
				font-size: 0.6em;
				font-weight: 600;
				letter-spacing: 0.02em;
				text-transform: uppercase;
				padding: 0.2em 0.6em;
				border-radius: 999px;
				color: var(--text-secondary);
				border: 1px solid hsl(0deg 0% 66.7% / 35%);
			}
		}
	}

	.search-input-wrapper {
		height: 3.5em;
		font-size: 1.1em;

		@media only screen and (max-width: 640px) {
			height: 3.8em;
			font-size: 1.2em;
		}
	}

	.search-select-wrapper {
		height: 3.5em;
		font-size: 1.1em;

		select {
			height: 100%;
			font-size: inherit;
		}

		@media only screen and (max-width: 640px) {
			height: 3.8em;
			font-size: 1.2em;
		}
	}
</style>
