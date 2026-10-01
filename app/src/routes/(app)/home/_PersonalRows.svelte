<script lang="ts">
	// Personal rows at the top of /home: Reprendre (H1), Pour toi (H2),
	// Récemment acquis (H3). Client-only: every row loads after mount, in
	// parallel, renders nothing while loading and stays hidden when its source
	// is empty or fails, so the YouTube rows below never wait on it.
	import { onMount } from "svelte";
	import { APIClient } from "$lib/api";
	import Carousel from "$lib/components/Carousel/Carousel.svelte";
	import { buildForYouRow, buildResumeRow, capItems, readLastTrack, sanitizeCard } from "$lib/homeRows";
	import { getMix, getRecent } from "$lib/me";
	import { settings } from "$lib/stores";
	import { readResumeState, resumePlayback, type ResumeState } from "$lib/stores/resumeState";
	import { clockLabel, fetchRemoteResume, restoreRemoteResume } from "$lib/stores/nowPlayingSync";
	import { AudioPlayer } from "$lib/player";
	import list from "$lib/stores/list";
	import { get } from "svelte/store";

	const MAX = 20;

	let resume: any[] = [];
	let forYou: any[] = [];
	let acquired: any[] = [];

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
	}

	async function loadAcquired() {
		try {
			const res = await APIClient.fetch(`/api/v1/local/albums?sort=dateAdded:desc&limit=${MAX}`);
			if (!res.ok) return;
			const r = await res.json();
			acquired = capItems(r?.items, MAX).map(sanitizeCard);
		} catch {
			acquired = [];
		}
	}

	onMount(() => {
		try {
			saved = get(settings)?.playback?.["Remember Last Track"] === true ? readResumeState(localStorage) : null;
		} catch {
			saved = null;
		}
		void loadResume();
		void loadRemote();
		void loadForYou();
		void loadAcquired();
	});
</script>

{#if resume.length > 0 || showSavedPill || remoteTrack}
	<section
		class="home-row"
		data-row="reprendre"
	>
		{#if remote && remoteTrack && $paused}
			<div class="resume-queue">
				<button
					type="button"
					class="btn-reset resume-remote"
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
					class="btn-reset"
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
		{#if resume.length > 0}
		<Carousel
			items={resume}
			header={{ title: "Reprendre", subheading: "Là où tu t'es arrêté" }}
			type="trending"
			isBrowseEndpoint={false}
		/>
		{/if}
	</section>
{/if}

{#if forYou.length > 0}
	<section
		class="home-row"
		data-row="pour-toi"
	>
		<Carousel
			items={forYou}
			header={{ title: "Pour toi", subheading: "D'après ta bibliothèque" }}
			type="trending"
			isBrowseEndpoint={false}
			seeAllHref="/library/for-you"
			seeAllLabel="Voir tout"
		/>
	</section>
{/if}

{#if acquired.length > 0}
	<section
		class="home-row"
		data-row="recemment-acquis"
	>
		<Carousel
			items={acquired}
			header={{ title: "Récemment acquis", subheading: "Derniers albums ajoutés à la bibliothèque" }}
			type="trending"
			isBrowseEndpoint={true}
			seeAllHref="/library/albums"
			seeAllLabel="Voir tout"
		/>
	</section>
{/if}

<style>
	.home-row {
		display: contents;
	}
	.resume-queue {
		/* Audit v7 TOP 6: the pill sat at x=0 on mobile while the row cards and
		   headers start at a 16px gutter. Match it (1rem) so the button reads as
		   part of the "Reprendre" row, not floating against the edge. */
		padding: 0.5em 1rem 0;
	}
	/* btn-reset: the pill keeps its own white colour (it was black-on-dark under
	   the global button rule), plain case, and a 44px touch target on phones. */
	.resume-queue button {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
		min-height: max(2.75rem, 44px);
		padding: 0.55em 1.1em;
		border-radius: 999px;
		border: 1px solid #fff;
		background: #fff;
		color: #0f0f0f;
		font-weight: 600;
		text-transform: none;
		cursor: pointer;
	}
	.resume-queue button:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	/* Audit v7 TOP 9: the remote-resume card is "another device", not the local
	   queue. Set it apart from the white local pill: a secondary translucent
	   card, left-aligned, led by a device glyph so it reads as a cross-device
	   hand-off. Keeps [data-testid=resume-remote] and the full sentence text. */
	.resume-queue button.resume-remote {
		justify-content: flex-start;
		gap: 0.5rem;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.28);
		border-radius: 0.9rem;
		color: #fff;
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
