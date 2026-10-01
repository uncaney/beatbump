<script lang="ts">
	// Personal rows at the top of /home: Reprendre (H1), Pour toi (H2),
	// Récemment acquis (H3), Nouveautés de tes artistes (EQ3), Redécouvrir
	// (D3), Jamais écouté (D2). Client-only: every row loads after mount, in
	// parallel, renders nothing while loading and stays hidden when its source
	// is empty or fails, so the YouTube rows below never wait on it.
	// c30a F1 + F2: arrangeHomeRows ($lib/homeRows) shows a card in one row
	// only and paints at most 4 rows above the first YouTube row; the others
	// fold behind "Plus pour toi" ([data-testid=home-more-rows]).
	import { onMount } from "svelte";
	import { APIClient } from "$lib/api";
	import Carousel from "$lib/components/Carousel/Carousel.svelte";
	import {
		ALBUM_ROW_MIN,
		HOME_MORE_ROWS_KEY,
		arrangeHomeRows,
		buildForYouRow,
		buildRediscoverRow,
		buildResumeRow,
		capItems,
		isoWeekKey,
		readLastTrack,
		readMoreRowsOpen,
		sanitizeCard,
		shouldShowWeekCard,
		WEEK_CARD_DISMISS_KEY,
	} from "$lib/homeRows";
	import { peekHomeCache, clearHomeCache, writeHomeCache } from "$lib/homeCache";
	import { getMix, getRecent, getStatsSummary, getTopBy, isAnonymousProfile, whoami, PROFILE_CHANNEL_NAME } from "$lib/me";
	import { settings } from "$lib/stores";
	import { readResumeState, resumePlayback, type ResumeState } from "$lib/stores/resumeState";
	import { clockLabel, fetchRemoteResume, restoreRemoteResume, wireProfileChannel } from "$lib/stores/nowPlayingSync";
	import { AudioPlayer } from "$lib/player";
	import list from "$lib/stores/list";
	import { get } from "svelte/store";

	const MAX = 20;
	// F1: Récemment acquis is the lowest-priority row of the dedupe (the newest
	// albums mostly belong to Nouveautés / Jamais écouté too), so it is fetched
	// twice as long as it shows and capped to MAX after the dedupe.
	const ACQUIRED_FETCH = 2 * MAX;

	let resume: any[] = [];
	let forYou: any[] = [];
	let acquired: any[] = [];
	// D2: up to 10 local albums (dateAdded desc) none of whose tracks appear
	// in the profile's play history (GET me/never-played, server-side set
	// difference). Hidden for an anonymous profile and when empty, same as
	// the other personal rows; no localStorage cache (AP1 covers reprendre/
	// pour-toi/recemment-acquis only).
	let neverPlayed: any[] = [];
	// c29b D3: tracks played >= 3 times more than 60 days ago and not once
	// in the last 30 days (GET me/stats/rediscover). Hidden for an anonymous
	// profile and under 6 results (buildRediscoverRow), so a fresh profile
	// never sees it.
	let rediscover: any[] = [];
	// c29b EQ3: local albums added in the last 30 days by a followed artist
	// or one of the profile's top 20 artists (GET me/new-in-library). Local
	// only, nothing is acquired. Hidden when empty.
	let newInLibrary: any[] = [];

	// ST1: a compact weekly recap card in the Reprendre area, Mondays only
	// (local time), until dismissed for that ISO week. Hidden when the
	// profile has no plays in the window (anonymous included: me/stats
	// answers an empty summary for it).
	interface WeekCard {
		minutes: number;
		topArtist: string;
		newAlbums: number;
	}
	let weekCard: WeekCard | null = null;

	async function loadWeekCard() {
		weekCard = null;
		try {
			const dismissed = storageOrUndefined()?.getItem(WEEK_CARD_DISMISS_KEY) ?? null;
			if (!shouldShowWeekCard(new Date(), dismissed)) return;
			const [summary, top] = await Promise.all([getStatsSummary(7), getTopBy("artists", 7, 1)]);
			if (!summary || !(summary.plays > 0)) return;
			weekCard = {
				minutes: Math.round(summary.minutes),
				topArtist: top?.rows?.[0]?.title ?? "",
				// me/stats/summary carries distinctAlbums (ST1); not in the
				// StatsSummary type yet elsewhere in the app, read defensively.
				newAlbums: Number((summary as unknown as { distinctAlbums?: number })?.distinctAlbums) || 0,
			};
		} catch {
			weekCard = null;
		}
	}

	function dismissWeekCard() {
		try {
			storageOrUndefined()?.setItem(WEEK_CARD_DISMISS_KEY, isoWeekKey(new Date()));
		} catch {
			/* no-op: worst case it shows again this session */
		}
		weekCard = null;
	}

	// AP1 "instant home": which source painted each row right now, for the
	// subtle opacity cue while a cached row is shown before the live answer
	// replaces it in place (never a layout jump: the row stays mounted,
	// {#if x.length > 0} never flips off between the cache and live paints).
	type RowSource = "empty" | "cache" | "live";
	let resumeSource: RowSource = "empty";
	let forYouSource: RowSource = "empty";
	let acquiredSource: RowSource = "empty";

	function storageOrUndefined(): Storage | undefined {
		try {
			return typeof localStorage === "undefined" ? undefined : localStorage;
		} catch {
			return undefined;
		}
	}

	/** Best-effort snapshot of the 3 rows into the shared localStorage cache. */
	async function persistHomeCache() {
		try {
			const w = await whoami();
			if (!w?.id) return;
			writeHomeCache(storageOrUndefined(), w.id, { reprendre: resume, pourToi: forYou, recemmentAcquis: acquired });
		} catch {
			/* best-effort: offline whoami, private mode, quota, ... */
		}
	}

	/**
	 * AP1: paint the 3 rows instantly from the cache (any profile's: the
	 * profile id isn't known synchronously), then drop that optimistic paint
	 * if `whoami()` turns out to belong to a different profile - the live
	 * loads already in flight fill the rows for the right profile moments
	 * later either way.
	 */
	function paintFromCache() {
		const snap = peekHomeCache(storageOrUndefined());
		if (!snap) return;
		if (snap.rows.reprendre.length) {
			resume = snap.rows.reprendre;
			resumeSource = "cache";
		}
		if (snap.rows.pourToi.length) {
			forYou = snap.rows.pourToi;
			forYouSource = "cache";
		}
		if (snap.rows.recemmentAcquis.length) {
			acquired = snap.rows.recemmentAcquis;
			acquiredSource = "cache";
		}
		void validateCacheProfile(snap.profileId);
	}

	async function validateCacheProfile(cachedProfileId: string) {
		try {
			const w = await whoami();
			if (w?.id === cachedProfileId) return;
		} catch {
			return; // offline/failed whoami: keep the optimistic paint, nothing better to show
		}
		if (resumeSource === "cache") {
			resume = [];
			resumeSource = "empty";
		}
		if (forYouSource === "cache") {
			forYou = [];
			forYouSource = "empty";
		}
		if (acquiredSource === "cache") {
			acquired = [];
			acquiredSource = "empty";
		}
	}

	/** L13/L14-style: a login/logout (this tab or another) invalidates the cache and this profile's rows. */
	function onProfileChanged() {
		clearHomeCache(storageOrUndefined());
		resume = [];
		forYou = [];
		acquired = [];
		resumeSource = "empty";
		forYouSource = "empty";
		acquiredSource = "empty";
		neverPlayed = [];
		rediscover = [];
		newInLibrary = [];
		weekCard = null;
		void loadResume();
		void loadForYou();
		void loadAcquired();
		void loadNeverPlayed();
		void loadRediscover();
		void loadNewInLibrary();
		void loadWeekCard();
	}

	// C1: the saved queue ("Remember Last Track"), resumed where it stopped.
	let saved: ResumeState | null = null;
	$: savedTrack = saved ? saved.mix[saved.position] : null;
	// Audit v8 TOP 5 / 3.1: the pill showed while the very same queue was
	// already loaded, even playing ("Reprendre la file : Aerodynamic (1/50)"
	// next to a mini-bar playing 2/50 of that file). The saved state IS the
	// session's own queue (resumeState writes it every 5 s), so compare it to
	// the live session: same length, same first and last videoId = same queue.
	// Shown only while paused and when the saved queue is not the loaded one;
	// `$paused` drops it the moment playback starts, without a navigation.
	function isCurrentQueue(s: ResumeState | null, mix: unknown[] | null | undefined): boolean {
		if (!s || !Array.isArray(mix) || !mix.length || mix.length !== s.mix.length) return false;
		const id = (row: unknown) => (row && typeof row === "object" ? (row as { videoId?: unknown }).videoId : undefined);
		return id(mix[0]) === id(s.mix[0]) && id(mix[mix.length - 1]) === id(s.mix[s.mix.length - 1]);
	}
	$: showSavedPill = !!savedTrack && $paused && !isCurrentQueue(saved, $list?.mix);
	const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
	let resuming = false;
	async function resumeQueue() {
		if (resuming) return;
		resuming = true;
		try {
			await resumePlayback();
		} finally {
			resuming = false;
		}
	}

	// C2: the profile's state from ANOTHER device, newer than ours by > 2 min.
	// J3: hidden while something plays here (this device is the live one).
	let remote: Awaited<ReturnType<typeof fetchRemoteResume>> = null;
	$: remoteTrack = remote ? remote.state.mix[remote.state.position] : null;
	const paused = AudioPlayer.paused;
	let restoringRemote = false;
	async function resumeRemote() {
		if (!remote || restoringRemote) return;
		restoringRemote = true;
		const offer = remote;
		try {
			// J2: a failed restoration toasts and keeps the card for a retry.
			if (!(await restoreRemoteResume(offer))) return;
			remote = null;
			try {
				if (get(settings)?.playback?.["Remember Last Track"] === true) saved = readResumeState(localStorage);
			} catch {
				/* keep the previous button */
			}
		} finally {
			restoringRemote = false;
		}
	}
	async function loadRemote() {
		// K12: fetchRemoteResume short-circuits for an anonymous profile (memoised
		// whoami, no me/nowplaying GET); nothing to offer then.
		remote = await fetchRemoteResume();
	}

	// Audit v7 TOP 10 (finishing lot): a restored queue loses the year run of a
	// card subtitle but keeps the trailing " • " separator, so the resume cards
	// read "Daft Punk • One More Time •". sanitizeCard keeps it (its trim is
	// non-empty), so drop any trailing separator-only run here, always leaving at
	// least one run. Items are not mutated.
	function stripTrailingSeparator<T extends { subtitle?: any[] }>(item: T): T {
		if (!Array.isArray(item?.subtitle)) return item;
		const sub = item.subtitle.slice();
		while (sub.length > 1 && typeof sub[sub.length - 1]?.text === "string" && /^[\s•·|]+$/.test(sub[sub.length - 1].text)) {
			sub.pop();
		}
		return sub.length === item.subtitle.length ? item : { ...item, subtitle: sub };
	}

	async function loadResume() {
		let recent: any[] = [];
		try {
			const r = await getRecent(30);
			recent = Array.isArray(r?.items) ? r.items : [];
		} catch {
			recent = [];
		}
		let lastTrack = null;
		try {
			lastTrack = readLastTrack(localStorage);
		} catch {
			lastTrack = null;
		}
		resume = buildResumeRow(lastTrack, recent, 10).map(sanitizeCard).map(stripTrailingSeparator);
		resumeSource = resume.length > 0 ? "live" : "empty";
		void persistHomeCache();
	}

	async function loadForYou() {
		try {
			const r = await getMix();
			// me/mix may return items without thumbnails / artistInfo (audit v3
			// 1.1): those rendered a "?" cover and an "undefined" artist line.
			forYou = buildForYouRow(r?.items, MAX);
		} catch {
			forYou = [];
		}
		forYouSource = forYou.length > 0 ? "live" : "empty";
		void persistHomeCache();
	}

	async function loadAcquired() {
		try {
			const res = await APIClient.fetch(`/api/v1/local/albums?sort=dateAdded:desc&limit=${ACQUIRED_FETCH}`);
			if (!res.ok) return;
			const r = await res.json();
			acquired = capItems(r?.items, ACQUIRED_FETCH).map(sanitizeCard);
		} catch {
			acquired = [];
		}
		acquiredSource = acquired.length > 0 ? "live" : "empty";
		void persistHomeCache();
	}

	const NEVER_PLAYED_MAX = 10;
	async function loadNeverPlayed() {
		try {
			if (await isAnonymousProfile()) {
				neverPlayed = [];
				return;
			}
			const res = await APIClient.fetch(`/api/v1/me/never-played?limit=${NEVER_PLAYED_MAX}`);
			if (!res.ok) {
				neverPlayed = [];
				return;
			}
			const r = await res.json();
			neverPlayed = capItems(r?.items, NEVER_PLAYED_MAX).map(sanitizeCard);
		} catch {
			neverPlayed = [];
		}
	}

	const REDISCOVER_MAX = 12;
	async function loadRediscover() {
		try {
			if (await isAnonymousProfile()) {
				rediscover = [];
				return;
			}
			const res = await APIClient.fetch(`/api/v1/me/stats/rediscover?limit=${REDISCOVER_MAX}`);
			if (!res.ok) {
				rediscover = [];
				return;
			}
			const r = await res.json();
			rediscover = buildRediscoverRow(r?.items, REDISCOVER_MAX).map(stripTrailingSeparator);
		} catch {
			rediscover = [];
		}
	}

	const NEW_IN_LIBRARY_MAX = 12;
	async function loadNewInLibrary() {
		try {
			const res = await APIClient.fetch(`/api/v1/me/new-in-library?days=30&limit=${NEW_IN_LIBRARY_MAX}`);
			if (!res.ok) {
				newInLibrary = [];
				return;
			}
			const r = await res.json();
			newInLibrary = capItems(r?.items, NEW_IN_LIBRARY_MAX).map(sanitizeCard);
		} catch {
			newInLibrary = [];
		}
	}

	// ---- c30a F1 + F2: one card once, at most 4 personal rows above YouTube ----
	// The Reprendre section also carries the pills and the week card, so it
	// keeps its slot even with no card to show (keepEmpty).
	$: reprendreHasExtras = showSavedPill || (!!remote && !!remoteTrack && $paused) || !!weekCard;
	$: arranged = arrangeHomeRows([
		{ key: "reprendre", items: resume, keepEmpty: reprendreHasExtras },
		{ key: "pour-toi", items: forYou },
		{ key: "recemment-acquis", items: acquired, max: MAX, minAfterDedupe: ALBUM_ROW_MIN },
		{ key: "nouveautes-artistes", items: newInLibrary, minAfterDedupe: ALBUM_ROW_MIN },
		{ key: "redecouvrir", items: rediscover },
		{ key: "jamais-ecoute", items: neverPlayed, minAfterDedupe: ALBUM_ROW_MIN },
	]);
	$: visibleKeys = new Set(arranged.visible.map((r) => r.key));
	$: rowItems = Object.fromEntries([...arranged.visible, ...arranged.more].map((r) => [r.key, r.items])) as Record<string, any[]>;
	$: discoveryVisible = arranged.visible.filter((r) => r.key in DISCOVERY_ROWS);
	$: moreRows = arranged.more.filter((r) => r.key in DISCOVERY_ROWS);
	$: moreCards = moreRows.reduce((n, r) => n + r.items.length, 0);

	// The four discovery rows share one template; their copy, link and
	// test ids live here. "Voir tout" lands on the list that shows the SAME
	// thing as the row (F5 + BI4): the albums page with the row's filter and
	// sort, the dedicated Redécouvrir list, the albums page newest first.
	interface DiscoveryRow {
		title: string;
		subheading: string;
		seeAllHref: string;
		testid: string;
		isBrowseEndpoint: boolean;
	}
	const DISCOVERY_ROWS: Record<string, DiscoveryRow> = {
		"recemment-acquis": {
			title: "Récemment acquis",
			subheading: "Derniers albums ajoutés à la bibliothèque",
			seeAllHref: "/library/albums?sort=dateAdded:desc",
			testid: "row-recently-added",
			isBrowseEndpoint: true,
		},
		"nouveautes-artistes": {
			title: "Nouveautés de tes artistes",
			subheading: "Albums ajoutés ces 30 derniers jours par les artistes que tu suis ou écoutes le plus",
			seeAllHref: "/library/albums?filter=added-30d&sort=dateAdded:desc",
			testid: "row-new-in-library",
			isBrowseEndpoint: true,
		},
		redecouvrir: {
			title: "Redécouvrir",
			subheading: "Des morceaux que tu aimais et que tu n'as plus écoutés depuis un mois",
			seeAllHref: "/library/rediscover",
			testid: "row-rediscover",
			isBrowseEndpoint: false,
		},
		"jamais-ecoute": {
			title: "Jamais écouté",
			subheading: "Des albums de ta bibliothèque que tu n'as jamais lancés",
			seeAllHref: "/library/albums?filter=never-played&sort=dateAdded:desc",
			testid: "row-never-played",
			isBrowseEndpoint: true,
		},
	};

	// F2: the folded rows ("Plus pour toi") stay as the viewer left them.
	let moreOpen = false;
	function toggleMore() {
		moreOpen = !moreOpen;
		try {
			storageOrUndefined()?.setItem(HOME_MORE_ROWS_KEY, moreOpen ? "1" : "0");
		} catch {
			/* no storage: this load only */
		}
	}

	// AP1 opacity cue per row key (true while the row shows its cached paint).
	$: cacheRows = {
		reprendre: resumeSource === "cache",
		"pour-toi": forYouSource === "cache",
		"recemment-acquis": acquiredSource === "cache",
	} as Record<string, boolean>;

	onMount(() => {
		try {
			saved = get(settings)?.playback?.["Remember Last Track"] === true ? readResumeState(localStorage) : null;
		} catch {
			saved = null;
		}
		moreOpen = readMoreRowsOpen(storageOrUndefined());
		paintFromCache();
		void loadResume();
		void loadRemote();
		void loadForYou();
		void loadAcquired();
		void loadNeverPlayed();
		void loadRediscover();
		void loadNewInLibrary();
		void loadWeekCard();
		let unwireProfile: (() => void) | undefined;
		if (typeof BroadcastChannel !== "undefined") {
			const channel = new BroadcastChannel(PROFILE_CHANNEL_NAME);
			unwireProfile = wireProfileChannel(channel, onProfileChanged);
		}
		return () => {
			unwireProfile?.();
		};
	});
</script>

{#if visibleKeys.has("reprendre")}
	<section
		class="home-row"
		data-row="reprendre"
	>
		{#if weekCard}
			<div
				class="week-card"
				data-testid="week-card"
			>
				<div class="week-card-body">
					<p class="week-card-title">Ta semaine</p>
					<p class="week-card-stats">
						{weekCard.minutes} min écoutées{#if weekCard.topArtist} · artiste n°1 : {weekCard.topArtist}{/if}{#if weekCard.newAlbums > 0}
							· {weekCard.newAlbums} nouveaux albums{/if}
					</p>
				</div>
				<a
					class="btn-reset btn-secondary week-card-link"
					href="/library/stats">Voir mes stats</a
				>
				<button
					type="button"
					class="btn-reset week-card-dismiss"
					aria-label="Fermer la carte Ta semaine"
					on:click={dismissWeekCard}
				>
					✕
				</button>
			</div>
		{/if}
		{#if remote && remoteTrack && $paused}
			<div class="resume-queue">
				<button
					type="button"
					class="btn-reset btn-secondary resume-remote"
					data-testid="resume-remote"
					disabled={restoringRemote}
					on:click={resumeRemote}
				>
					<svg
						class="rr-device"
						viewBox="0 0 24 24"
						width="18"
						height="18"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<rect x="2" y="4" width="14" height="10" rx="1.5" />
						<path d="M2 18h14" />
						<rect x="17" y="9" width="5" height="11" rx="1" />
					</svg>
					<span class="rr-text"
						>Reprendre depuis {remote.deviceName} : {remoteTrack.title ?? "morceau"} à {clockLabel(remote.state.currentTime)}</span
					>
				</button>
			</div>
		{/if}
		{#if showSavedPill && savedTrack}
			<div class="resume-queue">
				<button
					type="button"
					class="btn-reset btn-primary"
					data-testid="resume-queue"
					disabled={resuming}
					on:click={resumeQueue}
				>
					Reprendre la file : {savedTrack.title ?? "morceau"}{saved && saved.currentTime > 0
						? ` · ${clock(saved.currentTime)}`
						: ""}{saved && saved.mix.length > 1 ? ` (${saved.position + 1}/${saved.mix.length})` : ""}
				</button>
			</div>
		{/if}
		{#if rowItems.reprendre?.length > 0}
			<div
				class="row-fade"
				class:is-cache={cacheRows.reprendre}
			>
				<Carousel
					items={rowItems.reprendre}
					header={{ title: "Reprendre", subheading: "Là où tu t'es arrêté" }}
					type="trending"
					isBrowseEndpoint={false}
				/>
			</div>
		{/if}
	</section>
{/if}

{#if visibleKeys.has("pour-toi")}
	<section
		class="home-row"
		data-row="pour-toi"
	>
		<div
			class="row-fade"
			class:is-cache={cacheRows["pour-toi"]}
		>
			<Carousel
				items={rowItems["pour-toi"]}
				header={{ title: "Pour toi", subheading: "D'après ta bibliothèque" }}
				type="trending"
				isBrowseEndpoint={false}
				seeAllHref="/library/for-you"
				seeAllLabel="Voir tout"
			/>
		</div>
	</section>
{/if}

<!-- F1 + F2: the discovery rows that won a slot above the first YouTube row.
     testid on a box-bearing wrapper: .home-row is display: contents, which a
     visibility check reads as an empty box. -->
{#each discoveryVisible as row (row.key)}
	<section
		class="home-row"
		data-row={row.key}
	>
		<div
			class="row-fade"
			class:is-cache={!!cacheRows[row.key]}
			data-testid={DISCOVERY_ROWS[row.key].testid}
		>
			<Carousel
				items={rowItems[row.key]}
				header={{ title: DISCOVERY_ROWS[row.key].title, subheading: DISCOVERY_ROWS[row.key].subheading }}
				type="trending"
				isBrowseEndpoint={DISCOVERY_ROWS[row.key].isBrowseEndpoint}
				seeAllHref={DISCOVERY_ROWS[row.key].seeAllHref}
				seeAllLabel="Voir tout"
			/>
		</div>
	</section>
{/each}

{#if moreRows.length > 0}
	<div class="more-rows">
		<button
			type="button"
			class="btn-reset btn-secondary"
			data-testid="home-more-rows"
			aria-expanded={moreOpen}
			aria-controls="home-more-rows-panel"
			on:click={toggleMore}
		>
			{moreOpen ? "Moins" : "Plus pour toi"} · {moreRows.length} rangée{moreRows.length > 1 ? "s" : ""}, {moreCards} carte{moreCards > 1 ? "s" : ""}
		</button>
	</div>
	{#if moreOpen}
		<div
			id="home-more-rows-panel"
			class="more-rows-panel"
		>
			{#each moreRows as row (row.key)}
				<section
					class="home-row"
					data-row={row.key}
					data-folded="1"
				>
					<div
						class="row-fade"
						class:is-cache={!!cacheRows[row.key]}
						data-testid={DISCOVERY_ROWS[row.key].testid}
					>
						<Carousel
							items={rowItems[row.key]}
							header={{ title: DISCOVERY_ROWS[row.key].title, subheading: DISCOVERY_ROWS[row.key].subheading }}
							type="trending"
							isBrowseEndpoint={DISCOVERY_ROWS[row.key].isBrowseEndpoint}
							seeAllHref={DISCOVERY_ROWS[row.key].seeAllHref}
							seeAllLabel="Voir tout"
						/>
					</div>
				</section>
			{/each}
		</div>
	{/if}
{/if}

<style>
	.home-row {
		display: contents;
	}
	/* F2: the fold. Same 1rem gutter as the row headers; the panel is
	   display: contents so the folded rows flow like the visible ones. */
	.more-rows {
		padding: 0.25em 1rem 0.5em;
	}
	.more-rows-panel {
		display: contents;
	}
	/* AP1: the row painted from the localStorage cache dims very slightly
	   until the live answer replaces it in place (opacity only - the row
	   itself never remounts, so there is no layout jump). */
	.row-fade {
		transition: opacity 220ms ease;
	}
	.row-fade.is-cache {
		opacity: 0.93;
	}
	/* ST1: the compact weekly recap. Same 1rem gutter as .resume-queue;
	   colours/radius/44px tap target come from .btn-secondary and
	   .btn-reset (global/redesign/modules/_button.scss) - only the card
	   layout itself lives here. */
	.week-card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin: 0.5em 1rem 0;
		padding: 0.75rem 1rem;
		border-radius: 0.9rem;
		background: hsl(0deg 0% 100% / 6%);
	}
	.week-card-body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.week-card-title {
		font-weight: 600;
		margin: 0 0 0.15em;
	}
	.week-card-stats {
		margin: 0;
		opacity: 0.85;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.week-card-link {
		flex: 0 0 auto;
		white-space: nowrap;
	}
	.week-card-dismiss {
		flex: 0 0 auto;
		width: 2.75rem;
		height: 2.75rem;
		opacity: 0.7;
	}
	.resume-queue {
		/* Audit v7 TOP 6: the pill sat at x=0 on mobile while the row cards and
		   headers start at a 16px gutter. Match it (1rem) so the button reads as
		   part of the "Reprendre" row, not floating against the edge. */
		padding: 0.5em 1rem 0;
	}
	/* Colours, 44px floor and plain case come from the button system
	   (.btn-primary for the local queue, global/redesign/modules/_button.scss);
	   only the long-label ellipsis and the busy cursor live here. */
	.resume-queue button {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.resume-queue button:disabled {
		cursor: progress;
	}
	/* Audit v7 TOP 9: the remote-resume card is "another device", not the local
	   queue. Set it apart from the white local pill: a secondary translucent
	   card, left-aligned, led by a device glyph so it reads as a cross-device
	   hand-off. Keeps [data-testid=resume-remote] and the full sentence text. */
	.resume-queue button.resume-remote {
		/* .btn-secondary colours; card radius and sentence weight are its own. */
		justify-content: flex-start;
		gap: 0.5rem;
		border-radius: 0.9rem;
		font-weight: 500;
	}
	.resume-remote .rr-device {
		flex: 0 0 auto;
		opacity: 0.85;
	}
	.resume-remote .rr-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
</style>
