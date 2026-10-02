<script lang="ts">
	// 41A (B6-13) "Partager ma semaine": the profile's OWN last 7 days, sent by
	// the person through the native share sheet (else copied, toast "Copié").
	// Numbers are loaded on mount so the click calls navigator.share right
	// away (iOS drops the user gesture across a network wait).
	// c45b (B7-11) kind="year": "Partager mon année" from the year the parent
	// already loaded (me/stats/year, `year` prop); nothing is rendered without
	// a play that year (the parent's empty state stands alone).
	import Icon from "$components/Icon/Icon.svelte";
	import { loadWeekShare } from "$lib/meStats";
	import { shareLink } from "$lib/utils/shareLink";
	import { weekShareCopy, weekShareData, yearShareData, type WeekShare, type YearShare } from "$lib/utils/shareWeek";
	import { onMount } from "svelte";

	export let kind: "week" | "year" = "week";
	/** kind="year": the year to share (yearShareFrom), null = nothing to share. */
	export let year: YearShare | null = null;

	let week: WeekShare | null = null;
	let busy = false;

	onMount(async () => {
		if (kind !== "week") return;
		try {
			week = await loadWeekShare();
		} catch (err) {
			console.error("week share load failed", err);
		}
	});

	$: ready = kind === "year" ? !!year : !!week;

	async function onShare() {
		if (busy || !ready || typeof location === "undefined") return;
		busy = true;
		try {
			const data = kind === "year" && year ? yearShareData(year, location.origin) : weekShareData(week as WeekShare, location.origin);
			await shareLink(data, undefined, undefined, { copyText: weekShareCopy(data), copiedToast: "Copié" });
		} finally {
			busy = false;
		}
	}
</script>

{#if ready}
	<button
		type="button"
		class="btn-secondary share-week"
		data-testid={kind === "year" ? "share-year" : "share-week"}
		title={kind === "year" ? "Envoyer tes chiffres de l'année" : "Envoyer tes chiffres de la semaine"}
		disabled={busy}
		on:click|stopPropagation={onShare}
	>
		<Icon
			name="share"
			size="1.1em"
		/>
		<span>{kind === "year" ? "Partager mon année" : "Partager ma semaine"}</span>
	</button>
{/if}

<style>
	.share-week {
		white-space: nowrap;
	}
</style>
