<script lang="ts">
	// 41A (B6-22) "Ton année": the calendar year (viewer-local) month by
	// month, its top artist and album, distinct albums and the artists heard
	// for the first time; plus the release decades of the local tracks played
	// over the last 365 days.
	// c45b (B7-11): "Partager mon année" next to the title, the person's own
	// numbers only (yearShareFrom on the year already loaded here).
	import ShareWeek from "$components/ShareWeek/ShareWeek.svelte";
	import {
		decadeLabel,
		decadeShares,
		getDecades,
		getYear,
		MONTHS_FR,
		type Decades,
		type YearView,
	} from "$lib/meStats";
	import { formatCountFr, formatIntFr, NNBSP } from "$lib/utils/formatFr";
	import { yearShareFrom } from "$lib/utils/shareWeek";
	import { onMount } from "svelte";

	let year: YearView | null = null;
	let decades: Decades | null = null;

	onMount(async () => {
		const fail = (what: string) => (err: unknown) => {
			console.error(`${what} load failed`, err);
			return null;
		};
		[year, decades] = await Promise.all([getYear().catch(fail("year")), getDecades(365).catch(fail("decades"))]);
	});

	$: maxMonth = year ? Math.max(0, ...year.months) : 0;
	$: shares = decades ? decadeShares(decades.decades) : [];
	$: share = yearShareFrom(year);
	const fmtMin = (m: number) => {
		const min = Math.round(m || 0);
		return min < 60 ? `${min}${NNBSP}min` : `${formatIntFr(Math.floor(min / 60))}${NNBSP}h`;
	};
</script>

{#if year && year.plays > 0}
	<section
		class="year"
		data-testid="stats-year"
		data-year={year.year}
	>
		<div class="yhead">
			<h2>Ton année {year.year}</h2>
			<ShareWeek
				kind="year"
				year={share}
			/>
		</div>
		<div
			class="months"
			role="img"
			aria-label="Minutes écoutées par mois en {year.year}"
		>
			{#each year.months as m, i}
				<div
					class="mcol"
					title="{MONTHS_FR[i]} : {fmtMin(m)}"
				>
					<div
						class="mbar"
						style="height: {maxMonth > 0 ? Math.max(m > 0 ? 6 : 2, Math.round((m / maxMonth) * 100)) : 2}%"
					/>
					<span class="mlbl">{MONTHS_FR[i].slice(0, 1).toUpperCase()}</span>
				</div>
			{/each}
		</div>
		<ul class="facts">
			<li>
				<span class="k">Écoute</span>
				<span class="v">{fmtMin(year.minutes)}{year.estimated ? " (estimé)" : ""} · {formatCountFr(year.plays, "écoute")}</span>
			</li>
			{#if year.topArtist}
				<li>
					<span class="k">Artiste n°1</span>
					<span class="v">
						{#if year.topArtist.artistId}<a href="/artist/{year.topArtist.artistId}">{year.topArtist.title}</a>{:else}{year.topArtist.title}{/if}
						<span class="sub">({formatCountFr(year.topArtist.count, "écoute")})</span>
					</span>
				</li>
			{/if}
			{#if year.topAlbum}
				<li>
					<span class="k">Album n°1</span>
					<span class="v">
						{#if year.topAlbum.albumId}<a href="/release?id={encodeURIComponent(year.topAlbum.albumId)}">{year.topAlbum.title}</a>{:else}{year.topAlbum.title}{/if}
						{#if year.topAlbum.artist}<span class="sub">· {year.topAlbum.artist}</span>{/if}
					</span>
				</li>
			{/if}
			<li>
				<span class="k">Albums</span>
				<span class="v">{formatCountFr(year.distinctAlbums, "album différent", "albums différents")}</span>
			</li>
			<li>
				<span class="k">Découvertes</span>
				<span class="v">
					{formatCountFr(year.newArtists, "nouvel artiste", "nouveaux artistes")}
					{#if year.newArtistNames.length > 0}<span class="sub">· {year.newArtistNames.join(", ")}</span>{/if}
				</span>
			</li>
		</ul>
		{#if shares.length > 0}
			<div
				class="decades"
				data-testid="stats-decades"
			>
				<h3>Décennies écoutées <span class="sub">(titres locaux, 365 jours)</span></h3>
				<ul>
					{#each shares as s (s.decade)}
						<li>
							<span class="dname">{decadeLabel(s.decade)}</span>
							<span class="dtrack"><span
									class="dbar"
									style="width: {Math.max(2, s.pct)}%"
								/></span>
							<span class="dpct">{s.pct}{NNBSP}%</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</section>
{/if}

<style lang="scss">
	.year {
		margin-bottom: 1.5rem;
	}
	h2 {
		margin: 0.5rem 0 0.5rem;
	}
	.yhead {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 0.75rem;
	}
	h3 {
		margin: 1rem 0 0.4rem;
		font-size: 1rem;
	}
	.months {
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: 4px;
		height: 5rem;
		max-width: 36rem;
		align-items: end;
		padding-bottom: 1rem;
	}
	.mcol {
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		position: relative;
	}
	.mbar {
		width: 100%;
		border-radius: 2px 2px 0 0;
		background: rgba(30, 215, 96, 0.55);
	}
	.mlbl {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		text-align: center;
		font-size: var(--text-secondary-size);
		line-height: 1.2;
		color: #999;
		white-space: nowrap;
	}
	.facts {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.35rem;
	}
	.facts li {
		display: grid;
		grid-template-columns: 7.5rem minmax(0, 1fr);
		gap: 0.5rem;
	}
	.k {
		color: #bbb;
	}
	.v {
		overflow-wrap: anywhere;
	}
	.v a {
		color: inherit;
	}
	.sub {
		color: #999;
		font-size: 0.85rem;
		font-weight: normal;
	}
	.decades ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.3rem;
		max-width: 30rem;
	}
	.decades li {
		display: grid;
		grid-template-columns: 7rem minmax(0, 1fr) 3rem;
		align-items: center;
		gap: 0.5rem;
	}
	.dtrack {
		display: block;
		height: 0.8rem;
		border-radius: 0.25rem;
		background: rgba(255, 255, 255, 0.06);
		overflow: hidden;
	}
	.dbar {
		display: block;
		height: 100%;
		background: rgba(30, 215, 96, 0.55);
	}
	.dpct {
		text-align: right;
		font-variant-numeric: tabular-nums;
		font-size: 0.85rem;
	}
</style>
