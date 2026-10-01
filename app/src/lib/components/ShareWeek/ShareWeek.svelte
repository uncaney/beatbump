<script lang="ts">
	// 41A (B6-13) "Partager ma semaine": the profile's OWN last 7 days, sent by
	// the person through the native share sheet (else copied, toast "Copié").
	// Numbers are loaded on mount so the click calls navigator.share right
	// away (iOS drops the user gesture across a network wait).
	import Icon from "$components/Icon/Icon.svelte";
	import { loadWeekShare } from "$lib/meStats";
	import { shareLink } from "$lib/utils/shareLink";
	import { weekShareCopy, weekShareData, type WeekShare } from "$lib/utils/shareWeek";
	import { onMount } from "svelte";

	let week: WeekShare | null = null;
	let busy = false;

	onMount(async () => {
		try {
			week = await loadWeekShare();
		} catch (err) {
			console.error("week share load failed", err);
		}
	});

	async function onShare() {
		if (busy || !week || typeof location === "undefined") return;
		busy = true;
		try {
			const data = weekShareData(week, location.origin);
			await shareLink(data, undefined, undefined, { copyText: weekShareCopy(data), copiedToast: "Copié" });
		} finally {
			busy = false;
		}
	}
</script>

{#if week}
	<button
		type="button"
		class="btn-secondary share-week"
		data-testid="share-week"
		title="Envoyer tes chiffres de la semaine"
		disabled={busy}
		on:click|stopPropagation={onShare}
	>
		<Icon
			name="share"
			size="1.1em"
		/>
		<span>Partager ma semaine</span>
	</button>
{/if}

<style>
	.share-week {
		white-space: nowrap;
	}
</style>
