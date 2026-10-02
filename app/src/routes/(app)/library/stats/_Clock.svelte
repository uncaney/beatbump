<script lang="ts">
	// 41A (B6-22): when you listen, weekday x hour over the last 90 days, as a
	// CSS grid heat map (no chart library) with a one-line summary for
	// screen readers and everyone else.
	import { clockSummary, getClock, WEEKDAYS_FR, type Clock } from "$lib/meStats";
	import { formatIntFr, NNBSP } from "$lib/utils/formatFr";
	import { onMount } from "svelte";

	let clock: Clock | null = null;

	onMount(async () => {
		try {
			clock = await getClock(90);
		} catch (err) {
			console.error("clock load failed", err);
		}
	});

	$: summary = clock ? clockSummary(clock.minutes) : "";
	$: max = clock ? Math.max(0, ...clock.minutes.map((r) => Math.max(0, ...r))) : 0;
	const level = (m: number, top: number) => (m <= 0 || top <= 0 ? 0 : Math.min(4, 1 + Math.floor((m / top) * 3.999)));
	const hours = Array.from({ length: 24 }, (_, h) => h);
</script>

{#if clock && clock.total > 0}
	<section
		class="clock"
		data-testid="stats-clock"
	>
		<h2>Quand tu écoutes</h2>
		<p
			class="sum"
			data-testid="stats-clock-summary"
		>
			{summary} <span class="win">(90 derniers jours)</span>
		</p>
		<div
			class="grid"
			role="img"
			aria-label="Minutes écoutées par jour de la semaine et par heure. {summary}"
		>
			<span class="corner" />
			{#each hours as h}
				<span
					class="hl"
					aria-hidden="true">{h % 6 === 0 ? `${h}h` : ""}</span
				>
			{/each}
			{#each clock.minutes as row, d}
				<span
					class="dl"
					aria-hidden="true">{WEEKDAYS_FR[d].slice(0, 3)}</span
				>
				{#each row as m, h}
					<span
						class="cell l{level(m, max)}"
						title="{WEEKDAYS_FR[d]} {h} h : {formatIntFr(m)}{NNBSP}min"
					/>
				{/each}
			{/each}
		</div>
	</section>
{/if}

<style lang="scss">
	.clock {
		margin-bottom: 1.5rem;
	}
	h2 {
		margin: 0.5rem 0 0.25rem;
	}
	.sum {
		margin: 0 0 0.6rem;
	}
	// U13-7: 12 px floor (the root font is 12 px on a phone: 0.85rem read 10,2 px).
	.win {
		color: #999;
		font-size: var(--text-secondary-size);
	}
	.grid {
		display: grid;
		grid-template-columns: 2.2rem repeat(24, minmax(0, 1fr));
		gap: 2px;
		max-width: 48rem;
		align-items: center;
	}
	.hl,
	.dl {
		font-size: var(--text-secondary-size);
		color: #999;
		line-height: 1;
		white-space: nowrap;
	}
	.hl {
		overflow: visible;
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
</style>
