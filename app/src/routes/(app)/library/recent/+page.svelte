<script lang="ts">
	import Listing from "$components/Item/Listing.svelte";
	import MeOffline from "$components/Offline/MeOffline.svelte";
	import { playTracks } from "$components/PlayAllBar/PlayAllBar.svelte";
	import { APIClient } from "$lib/api";
	import { getTop } from "$lib/me";
	import { meLoadOffline } from "$lib/offline";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";
	import { groupByDay, RECENT_EVENTS_URL, type DayGroup } from "./_byDay";

	let recent: any[] = [];
	// S3: the history split by local day. null = no play time in the answer
	// (older API): the flat list stays.
	let days: DayGroup[] | null = null;
	let top: any[] = [];
	let loading = true;
	// H2: the play history lives in the profile, unreachable offline.
	let offline = false;

	async function load() {
		loading = true;
		let r: any = null;
		let t: any = null;
		let err: unknown = undefined;
		try {
			// I18: the last 200 plays, one row per play (not one per title at
			// its last play): each day lists and replays all of its plays.
			[r, t] = await Promise.all([APIClient.fetch(RECENT_EVENTS_URL).then((x) => x.json()), getTop(60)]);
		} catch (e) {
			err = e;
			console.error("recent load failed", e);
		}
		offline = meLoadOffline([r, t], err);
		if (offline) {
			recent = [];
			top = [];
			days = null;
		} else if (!err) {
			const plays = Array.isArray(r?.items) ? r.items : [];
			top = Array.isArray(t?.items) ? t.items : [];
			days = groupByDay(plays, r?.playedAt);
			// Flat fallback (no play times): one row per title.
			recent = playableUnique(plays);
		}
		loading = false;
	}

	onMount(() => {
		void load();
		const on = () => {
			if (offline) void load();
		};
		window.addEventListener("online", on);
		return () => window.removeEventListener("online", on);
	});

	function playableUnique(list: any[]): any[] {
		const seen = new Set<string>();
		return list.filter((it) => {
			const id = it?.videoId || it?.title;
			if (!id) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		});
	}

	let replaying = "";
	async function replayDay(g: DayGroup) {
		if (replaying) return;
		replaying = g.key;
		try {
			await playTracks(g.replay, { context: { kind: "queue", title: g.label, href: "/library/recent" } });
		} finally {
			replaying = "";
		}
	}
</script>

<main>
	<CollectionNav active="recent" />
	<h1>Listening</h1>

	<section>
		<h2>Recently played</h2>
		{#if loading}
			<p class="state">Loading…</p>
		{:else if offline}
			<MeOffline text="Ton historique reviendra avec le réseau ; tes morceaux en cache restent dans Hors-ligne." />
		{:else if recent.length === 0}
			<p class="state">Nothing played yet.</p>
		{:else if days && days.length > 0}
			{#each days as g (g.key)}
				<section
					class="day"
					data-testid="recent-day"
					data-day={g.key}
				>
					<div class="day-head">
						<h3>{g.label}</h3>
						<span class="day-count">{g.items.length} titre{g.items.length > 1 ? "s" : ""}</span>
						<button
							type="button"
							class="replay"
							data-testid="replay-day"
							disabled={replaying !== ""}
							on:click={() => replayDay(g)}>Rejouer cette journée</button
						>
					</div>
					<div class="grid">
						{#each g.items as item (item.videoId || item.title)}
							<div class="cell"><Listing data={item} /></div>
						{/each}
					</div>
				</section>
			{/each}
		{:else}
			<div class="grid">
				{#each recent as item (item.videoId || item.title)}
					<div class="cell"><Listing data={item} /></div>
				{/each}
			</div>
		{/if}
	</section>

	{#if top.length > 0}
		<section>
			<h2>Most played</h2>
			<div class="grid">
				{#each top as item (item.videoId || item.title)}
					<div class="cell"><Listing data={item} /></div>
				{/each}
			</div>
		</section>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	h2 {
		margin: 1.25rem 0 0.5rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 0.25rem 1rem;
	}
	.cell {
		min-width: 0;
	}
	.day {
		margin-bottom: 1.25rem;
	}
	.day-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin: 0.75rem 0 0.4rem;
	}
	.day-head h3 {
		margin: 0;
		font-size: 1.05rem;
	}
	.day-head h3::first-letter {
		text-transform: uppercase;
	}
	.day-count {
		color: #999;
		font-size: 0.9em;
	}
	.replay {
		margin-left: auto;
		min-height: 2.25rem;
		padding: 0.35rem 0.9rem;
		border-radius: 2rem;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.replay:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.state {
		color: #999;
		margin: 1rem 0;
	}
	@media screen and (max-width: 37em) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
