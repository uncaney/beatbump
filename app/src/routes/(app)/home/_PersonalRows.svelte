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
	import { get } from "svelte/store";

	const MAX = 20;

	let resume: any[] = [];
	let forYou: any[] = [];
	let acquired: any[] = [];

	// C1: the saved queue ("Remember Last Track"), resumed where it stopped.
	let saved: ResumeState | null = null;
	$: savedTrack = saved ? saved.mix[saved.position] : null;
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
		remote = await fetchRemoteResume();
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
		resume = buildResumeRow(lastTrack, recent, 10).map(sanitizeCard);
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

{#if resume.length > 0 || savedTrack || remoteTrack}
	<section
		class="home-row"
		data-row="reprendre"
	>
		{#if remote && remoteTrack && $paused}
			<div class="resume-queue">
				<button
					type="button"
					class="btn-reset"
					data-testid="resume-remote"
					disabled={restoringRemote}
					on:click={resumeRemote}
				>
					Reprendre depuis {remote.deviceName} : {remoteTrack.title ?? "morceau"} à {clockLabel(remote.state.currentTime)}
				</button>
			</div>
		{/if}
		{#if savedTrack}
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
		padding: 0.5em 0 0;
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
</style>
