<script lang="ts">
	// B6-17 (cycle 40, pack trajet): "Prépare ton week-end", Friday to Sunday
	// (local time), only when the profile has something a pack can take
	// (favourites or recent plays: the same sources as the Hors-ligne pack).
	// One link opens /library/downloads-offline?pack=dur:7200: the Espace card
	// unfolds with "2 h" preselected. "✕" hides it until next weekend
	// (localStorage WEEKEND_CARD_DISMISS_KEY = epoch ms). Self-contained: mounted
	// by one line in _PersonalRows.svelte.
	import { onMount } from "svelte";
	import { getFavorites, getRecent } from "$lib/me";
	import { WEEKEND_CARD_DISMISS_KEY, WEEKEND_PACK_HREF, hasPackMaterial, shouldShowWeekendCard } from "$lib/weekendCard";

	let show = false;

	function stored(): string | null {
		try {
			return localStorage.getItem(WEEKEND_CARD_DISMISS_KEY);
		} catch {
			return null;
		}
	}

	onMount(() => {
		let alive = true;
		if (!shouldShowWeekendCard(new Date(), stored())) return;
		void (async () => {
			try {
				const [fav, rec] = await Promise.all([
					getFavorites().catch(() => null),
					// Same limit as the home resume row: getRecent is memoised (5 s).
					getRecent(30).catch(() => null),
				]);
				const f = fav ?? { items: [], favorites: [] };
				const favItems = Array.isArray(f.items) && f.items.length ? f.items : Array.isArray(f.favorites) ? f.favorites : [];
				if (alive) show = hasPackMaterial(favItems, rec?.items) && shouldShowWeekendCard(new Date(), stored());
			} catch {
				if (alive) show = false;
			}
		})();
		return () => {
			alive = false;
		};
	});

	function dismiss() {
		try {
			localStorage.setItem(WEEKEND_CARD_DISMISS_KEY, String(Date.now()));
		} catch {
			/* private mode: hidden for this visit only */
		}
		show = false;
	}
</script>

{#if show}
	<div
		class="weekend-card"
		data-testid="weekend-card"
	>
		<div class="weekend-card-body">
			<p class="weekend-card-title">Prépare ton week-end</p>
			<p class="weekend-card-text">2 h de tes favoris et de tes écoutes récentes, prêtes sans réseau.</p>
		</div>
		<a
			class="btn-reset btn-secondary weekend-card-start"
			data-testid="weekend-card-start"
			href={WEEKEND_PACK_HREF}>Préparer 2 h</a
		>
		<button
			type="button"
			class="btn-reset weekend-card-dismiss"
			data-testid="weekend-card-dismiss"
			aria-label="Fermer la carte Prépare ton week-end"
			on:click={dismiss}
		>
			✕
		</button>
	</div>
{/if}

<style>
	/* Same footprint as the Monday "Ta semaine" card. */
	.weekend-card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin: 0.5em 1rem 0;
		padding: 0.75rem 1rem;
		border-radius: 0.9rem;
		background: hsl(0deg 0% 100% / 6%);
	}
	.weekend-card-body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.weekend-card-title {
		font-weight: 600;
		margin: 0 0 0.15em;
	}
	.weekend-card-text {
		margin: 0;
		opacity: 0.85;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.weekend-card-start {
		flex: 0 0 auto;
		white-space: nowrap;
	}
	.weekend-card-dismiss {
		flex: 0 0 auto;
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		width: max(2.75rem, 44px);
		height: max(2.75rem, 44px);
		opacity: 0.7;
		color: inherit;
		background: none;
		cursor: pointer;
	}
	.weekend-card-dismiss:hover,
	.weekend-card-dismiss:focus-visible {
		opacity: 1;
	}
</style>
