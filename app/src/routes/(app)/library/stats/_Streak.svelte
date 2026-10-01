<script lang="ts">
	// 41A (B6-22) "Série": consecutive local days with at least one play
	// (a play counts after 30 s), the record, and the last 90 days as a strip.
	import { getStreaks, localDateKey, streakLabel, streakNeedsToday, type Streaks } from "$lib/meStats";
	import { formatIntFr, NNBSP } from "$lib/utils/formatFr";
	import { onMount } from "svelte";

	let streaks: Streaks | null = null;

	onMount(async () => {
		try {
			streaks = await getStreaks();
		} catch (err) {
			console.error("streaks load failed", err);
		}
	});

	$: maxDay = streaks ? Math.max(0, ...streaks.days.map((d) => d.minutes)) : 0;
	const level = (m: number, max: number) => (m <= 0 || max <= 0 ? 0 : Math.min(4, 1 + Math.floor((m / max) * 3.999)));
	const dayTitle = (d: { date: string; minutes: number }) =>
		`${d.date.split("-").reverse().join("/")} : ${formatIntFr(d.minutes)}${NNBSP}min`;
</script>

{#if streaks && streaks.longest > 0}
	<section
		class="streak"
		data-testid="stats-streak"
		data-current={streaks.current}
		data-longest={streaks.longest}
	>
		<h2>Série</h2>
		<p class="line">
			<strong>{streakLabel(streaks)}</strong>
			{#if streakNeedsToday(streaks, localDateKey(new Date()))}
				<span class="nudge">Une écoute aujourd'hui la prolonge.</span>
			{/if}
		</p>
		<div
			class="cal"
			role="img"
			aria-label="Écoute par jour sur les 90 derniers jours"
		>
			{#each streaks.days as d (d.date)}
				<span
					class="cell l{level(d.minutes, maxDay)}"
					title={dayTitle(d)}
				/>
			{/each}
		</div>
	</section>
{/if}

<style lang="scss">
	.streak {
		margin-bottom: 1.5rem;
	}
	h2 {
		margin: 0.5rem 0 0.25rem;
	}
	.line {
		margin: 0 0 0.6rem;
	}
	.nudge {
		display: block;
		color: #bbb;
		font-size: 0.85rem;
	}
	/* 90 days: 15 columns x 6 rows on a phone, 45 x 2 from tablets. */
	.cal {
		display: grid;
		grid-template-columns: repeat(15, minmax(0, 1fr));
		gap: 3px;
		max-width: 30rem;
	}
	.cell {
		aspect-ratio: 1;
		border-radius: 2px;
		background: rgba(255, 255, 255, 0.07);
	}
	.l1 {
		background: rgba(30, 215, 96, 0.3);
	}
	.l2 {
		background: rgba(30, 215, 96, 0.5);
	}
	.l3 {
		background: rgba(30, 215, 96, 0.75);
	}
	.l4 {
		background: var(--accent, #1ed760);
	}
	@media screen and (min-width: 48em) {
		.cal {
			grid-template-columns: repeat(45, minmax(0, 1fr));
			max-width: 48rem;
		}
	}
</style>
