<script lang="ts">
	// S1 "Ton mois": personal listening stats over 7 / 30 / 365 days, from the
	// profile's play history (plays counted after 30 s, harness excluded).
	import DeviceOnlyBanner from "$components/IdentityPrompt/DeviceOnlyBanner.svelte";
	import Listing from "$components/Item/Listing.svelte";
	import ShareWeek from "$components/ShareWeek/ShareWeek.svelte";
	import { getStatsSummary, getTopBy, type StatsSummary, type TopRow } from "$lib/me";
	import { NNBSP, formatCountFr, formatIntFr } from "$lib/utils/formatFr";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";
	import Clock from "./_Clock.svelte";
	import Streak from "./_Streak.svelte";
	import Year from "./_Year.svelte";

	const periods = [
		{ days: 7, label: "7 jours" },
		{ days: 30, label: "30 jours" },
		{ days: 365, label: "365 jours" },
	];
	let days = 30;
	let loading = true;
	let error = "";
	let summary: StatsSummary | null = null;
	let tracks: TopRow[] = [];
	let artists: TopRow[] = [];
	let albums: TopRow[] = [];
	let _req = 0;

	async function load(d: number) {
		const id = ++_req;
		loading = true;
		error = "";
		try {
			const [s, t, a, b] = await Promise.all([
				getStatsSummary(d),
				getTopBy("tracks", d, 20),
				getTopBy("artists", d, 20),
				getTopBy("albums", d, 20),
			]);
			if (id !== _req) return;
			summary = s;
			tracks = Array.isArray(t.rows) ? t.rows : [];
			artists = Array.isArray(a.rows) ? a.rows : [];
			albums = Array.isArray(b.rows) ? b.rows : [];
		} catch (err) {
			if (id !== _req) return;
			console.error("stats load failed", err);
			error = "Impossible de charger les statistiques.";
		}
		loading = false;
	}

	function pick(d: number) {
		if (d === days) return;
		days = d;
		try {
			localStorage.setItem("ytm-stats-days", String(d));
		} catch {
			/* private mode */
		}
		load(d);
	}

	onMount(() => {
		try {
			const saved = parseInt(localStorage.getItem("ytm-stats-days") || "", 10);
			if (periods.some((p) => p.days === saved)) days = saved;
		} catch {
			/* private mode */
		}
		load(days);
	});

	// c31a: shared French number format; narrow no-break space before units.
	const fmtInt = formatIntFr;
	function fmtMinutes(m: number): string {
		const min = Math.round(m || 0);
		if (min < 60) return `${min}${NNBSP}min`;
		const h = Math.floor(min / 60);
		return `${fmtInt(h)}${NNBSP}h${NNBSP}${String(min % 60).padStart(2, "0")}`;
	}
	const pct = (count: number, max: number) => (max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0);
	const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

	$: hasPlays = !!summary && summary.plays > 0;
	$: maxTrack = tracks[0]?.count ?? 0;
	$: maxArtist = artists[0]?.count ?? 0;
	$: maxAlbum = albums[0]?.count ?? 0;
	$: maxHour = summary ? Math.max(0, ...summary.hours) : 0;
</script>

<svelte:head>
	<title>Ton mois</title>
</svelte:head>

<main class="resp-content-width">
	<CollectionNav active="stats" />
	<header class="head">
		<h1>Ton mois</h1>
		<div
			class="periods"
			role="tablist"
			aria-label="Période"
		>
			{#each periods as p}
				<button
					type="button"
					role="tab"
					aria-selected={p.days === days}
					class:active={p.days === days}
					data-testid="stats-period-{p.days}"
					on:click={() => pick(p.days)}>{p.label}</button
				>
			{/each}
		</div>
		<a
			class="btn-secondary export"
			data-testid="export-csv"
			href="/api/v1/me/stats/export.csv"
			download="ecoutes.csv"
			title="Tout l'historique d'écoute (10 000 dernières écoutes), format CSV">Exporter en CSV</a
		>
		<ShareWeek />
	</header>
	<!-- 39A: anonymous: these stats live on this device only (one line; the
	     name prompt opens by itself from 10 plays, or from the link). -->
	<DeviceOnlyBanner
		autoPrompt
		text="Ces chiffres ne vivent que sur cet appareil."
	/>

	{#if error}
		<p class="state">{error}</p>
	{:else if loading && !summary}
		<p class="state">Chargement…</p>
	{:else if !hasPlays}
		<section
			class="summary empty"
			data-testid="stats-summary"
			data-days={days}
		>
			<p class="state">Pas encore d'écoute sur cette période.</p>
			<p class="hint">Une écoute compte après 30 secondes de lecture.</p>
		</section>
	{:else if summary}
		<section
			class="summary"
			class:dim={loading}
			data-testid="stats-summary"
			data-days={days}
			aria-busy={loading}
		>
			<div class="tiles">
				<div class="tile">
					<span class="num">{fmtInt(summary.plays)}</span>
					<span class="lbl">{plural(summary.plays, "écoute", "écoutes")}</span>
				</div>
				<div
					class="tile"
					title={summary.estimated ? "Estimation : certaines pistes n'ont pas de durée connue (3 min 30 par défaut)" : ""}
				>
					<span class="num">{fmtMinutes(summary.minutes)}</span>
					<span class="lbl">{summary.estimated ? "minutes (estimé)" : "minutes"}</span>
				</div>
				<div class="tile">
					<span class="num">{fmtInt(summary.distinctTracks)}</span>
					<span class="lbl">{plural(summary.distinctTracks, "titre", "titres")}</span>
				</div>
				<div class="tile">
					<span class="num">{fmtInt(summary.distinctArtists)}</span>
					<span class="lbl">{plural(summary.distinctArtists, "artiste", "artistes")}</span>
				</div>
			</div>
			<p class="meta">
				{#if summary.topHour >= 0}
					Heure préférée : <strong>{String(summary.topHour).padStart(2, "0")} h</strong>.
				{/if}
				{#if summary.local + summary.youtube > 0}
					{fmtInt(summary.local)} en local, {fmtInt(summary.youtube)} via YouTube.
				{/if}
			</p>
			<div
				class="hours"
				aria-label="Écoutes par heure de la journée"
			>
				{#each summary.hours as n, h}
					<div
						class="hcol"
						title="{String(h).padStart(2, '0')} h : {formatCountFr(n, 'écoute')}"
					>
						<div
							class="hbar"
							class:top={h === summary.topHour}
							style="height: {maxHour > 0 ? Math.max(n > 0 ? 6 : 2, Math.round((n / maxHour) * 100)) : 2}%"
						/>
						{#if h % 6 === 0}<span class="hlbl">{h}h</span>{/if}
					</div>
				{/each}
			</div>
		</section>

		<Streak />
		<Clock />
		<Year />

		<div class="lists">
			<section
				class="list"
				data-testid="stats-top-tracks"
			>
				<h2>Top titres</h2>
				{#if tracks.length === 0}
					<p class="state">Aucun titre.</p>
				{:else}
					<ol>
						{#each tracks as r, i (r.key)}
							<li class="trow">
								<span class="rank">{i + 1}</span>
								<div class="cell">
									{#if r.item}
										<Listing data={r.item} />
									{:else}
										<span class="plain">{r.title}{r.artist ? ` · ${r.artist}` : ""}</span>
									{/if}
								</div>
								<span
									class="count"
									title={formatCountFr(r.count, "écoute")}
								>
									<span
										class="bar"
										style="width: {pct(r.count, maxTrack)}%"
									/>
									<span class="n">{r.count}</span>
								</span>
							</li>
						{/each}
					</ol>
				{/if}
			</section>

			<section
				class="list"
				data-testid="stats-top-artists"
			>
				<h2>Top artistes</h2>
				{#if artists.length === 0}
					<p class="state">Aucun artiste.</p>
				{:else}
					<ol>
						{#each artists as r, i (r.key)}
							<li class="srow">
								<span class="rank">{i + 1}</span>
								{#if r.artistId}
									<a
										class="name"
										href="/artist/{r.artistId}">{r.title}</a
									>
								{:else}
									<span class="name">{r.title}</span>
								{/if}
								<span
									class="count"
									title={formatCountFr(r.count, "écoute")}
								>
									<span
										class="bar"
										style="width: {pct(r.count, maxArtist)}%"
									/>
									<span class="n">{r.count}</span>
								</span>
							</li>
						{/each}
					</ol>
				{/if}
			</section>

			<section
				class="list"
				data-testid="stats-top-albums"
			>
				<h2>Top albums</h2>
				{#if albums.length === 0}
					<p class="state">Aucun album.</p>
				{:else}
					<ol>
						{#each albums as r, i (r.key + "|" + (r.artist ?? ""))}
							<li class="srow">
								<span class="rank">{i + 1}</span>
								<span class="name">
									{r.title}
									{#if r.artist}<span class="sub">{r.artist}</span>{/if}
								</span>
								<span
									class="count"
									title={formatCountFr(r.count, "écoute")}
								>
									<span
										class="bar"
										style="width: {pct(r.count, maxAlbum)}%"
									/>
									<span class="n">{r.count}</span>
								</span>
							</li>
						{/each}
					</ol>
				{/if}
			</section>
		</div>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}
	h1 {
		margin: 0;
	}
	.periods {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.periods button {
		min-height: 44px;
		min-width: 44px;
		padding: 0.35rem 0.9rem;
		border-radius: 1rem;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.06);
		color: inherit;
		font: inherit;
		font-weight: 500;
		cursor: pointer;
		opacity: 0.75;
	}
	.periods button:hover {
		opacity: 1;
	}
	a.export {
		text-decoration: none;
	}
	.periods button.active {
		opacity: 1;
		background: var(--accent, #1ed760);
		color: #000;
		border-color: transparent;
		font-weight: 600;
	}
	.summary {
		margin-bottom: 1.5rem;
		transition: opacity 0.15s;
	}
	.summary.dim {
		opacity: 0.6;
	}
	.summary.empty {
		padding: 1.5rem 1rem;
		border: 1px dashed rgba(255, 255, 255, 0.2);
		border-radius: 0.6rem;
		text-align: center;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.6rem;
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.9rem 0.8rem;
		min-height: 44px;
		border-radius: 0.6rem;
		background: rgba(255, 255, 255, 0.07);
		border: 1px solid rgba(255, 255, 255, 0.1);
	}
	.num {
		font-size: 1.6rem;
		font-weight: 700;
		line-height: 1.1;
		overflow-wrap: anywhere;
	}
	.lbl {
		color: #bbb;
		font-size: 0.85rem;
	}
	.meta {
		margin: 0.75rem 0 0.5rem;
		color: #bbb;
		font-size: 0.9rem;
	}
	.hours {
		display: grid;
		grid-template-columns: repeat(24, minmax(0, 1fr));
		gap: 2px;
		height: 4.5rem;
		align-items: end;
		padding-bottom: 1rem;
		position: relative;
	}
	.hcol {
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		position: relative;
	}
	.hbar {
		width: 100%;
		border-radius: 2px 2px 0 0;
		background: rgba(255, 255, 255, 0.28);
	}
	.hbar.top {
		background: var(--accent, #1ed760);
	}
	.hlbl {
		position: absolute;
		top: 100%;
		left: 0;
		font-size: 0.7rem;
		color: #999;
	}
	.lists {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
		gap: 1.25rem;
	}
	.list {
		min-width: 0;
	}
	h2 {
		margin: 0.5rem 0 0.5rem;
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.trow,
	.srow {
		display: grid;
		grid-template-columns: 1.6rem minmax(0, 1fr) 5.5rem;
		align-items: center;
		gap: 0.5rem;
		min-height: 44px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}
	.srow {
		padding: 0.45rem 0;
	}
	.cell {
		min-width: 0;
	}
	.plain {
		display: block;
		padding: 0.6rem 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rank {
		color: #999;
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: inherit;
		text-decoration: none;
		display: block;
		min-height: 44px;
		line-height: 44px;
	}
	.name .sub {
		display: block;
		line-height: 1.2;
		margin-top: -0.9rem;
		color: #999;
		font-size: 0.8rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	a.name:hover {
		text-decoration: underline;
	}
	.count {
		position: relative;
		display: block;
		height: 1.5rem;
		border-radius: 0.25rem;
		background: rgba(255, 255, 255, 0.05);
		overflow: hidden;
	}
	.bar {
		position: absolute;
		inset: 0 auto 0 0;
		background: rgba(30, 215, 96, 0.35);
	}
	.n {
		position: absolute;
		right: 0.4rem;
		top: 0;
		line-height: 1.5rem;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}
	.state {
		color: #999;
		margin: 0.75rem 0;
	}
	.hint {
		color: #777;
		font-size: 0.85rem;
		margin: 0;
	}
	@media screen and (max-width: 56em) {
		.lists {
			grid-template-columns: 1fr;
		}
	}
	@media screen and (max-width: 37em) {
		.tiles {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.num {
			font-size: 1.35rem;
		}
	}
</style>
