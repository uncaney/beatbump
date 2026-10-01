<script lang="ts">
	// ON1: first-visit guided home. Replaces the awkward "looks broken" first
	// impression (PersonalRows already hides its empty rows, but hides them
	// into nothing) with three concrete actions, shown only when the profile
	// has no history (me/stats/recent empty, including the anonymous/failed
	// case) AND no local "Remember Last Track" queue to resume. Hidden the
	// moment a play is recorded this session, and for good once dismissed or
	// acted on (localStorage `ytm-first-run-done`).
	import { onMount } from "svelte";
	import { getRecent } from "$lib/me";
	import { readResumeState } from "$lib/stores/resumeState";
	import { settings } from "$lib/stores/settings";
	import { currentTrack } from "$lib/stores/list";
	import { get } from "svelte/store";

	const DONE_KEY = "ytm-first-run-done";

	let visible = false;

	function dismiss() {
		visible = false;
		try {
			localStorage.setItem(DONE_KEY, "1");
		} catch {
			/* no storage: nothing to persist, just hide for this load */
		}
	}

	onMount(() => {
		(async () => {
			try {
				if (localStorage.getItem(DONE_KEY) === "1") return;
			} catch {
				/* no storage: treat as not-yet-dismissed */
			}
			let hasSavedQueue = false;
			try {
				hasSavedQueue =
					get(settings)?.playback?.["Remember Last Track"] === true && !!readResumeState(localStorage);
			} catch {
				hasSavedQueue = false;
			}
			if (hasSavedQueue) return;
			let recentCount = 0;
			try {
				const r = await getRecent(1);
				recentCount = Array.isArray(r?.items) ? r.items.length : 0;
			} catch {
				// Anonymous profile or a failed call both read as "no history".
				recentCount = 0;
			}
			if (recentCount > 0) return;
			visible = true;
		})();
		// A play starting (this session, from any source) means the "first
		// impression" moment has passed.
		return currentTrack.subscribe((t) => {
			if (t) dismiss();
		});
	});
</script>

{#if visible}
	<section
		class="first-run"
		data-testid="first-run"
	>
		<button
			type="button"
			class="btn-ghost dismiss"
			aria-label="Fermer"
			on:click={dismiss}
		>
			&times;
		</button>
		<p class="headline">Bienvenue</p>
		<p class="sub">Trouve ta musique en trois gestes.</p>
		<div class="actions">
			<a
				class="btn-secondary"
				href="/library/albums"
				on:click={dismiss}>Explorer ma bibliothèque</a
			>
			<a
				class="btn-secondary"
				href="/home?search=1"
				on:click={dismiss}>Chercher un titre</a
			>
			<a
				class="btn-secondary"
				href="/library/downloads-offline"
				on:click={dismiss}>Écouter une mixtape</a
			>
		</div>
	</section>
{/if}

<style lang="scss">
	.first-run {
		position: relative;
		margin: 0.75rem 0 1.25rem;
		padding: 1.1rem 1.1rem 1rem;
		border-radius: 0.9rem;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(255, 255, 255, 0.04);
	}
	.dismiss {
		position: absolute;
		top: 0.4rem;
		right: 0.4rem;
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		display: grid;
		place-items: center;
		font-size: 1.2rem;
		line-height: 1;
	}
	.headline {
		margin: 0 2.5rem 0.2rem 0;
		font-size: 1.1rem;
		font-weight: 700;
	}
	.sub {
		margin: 0 2.5rem 0.75rem 0;
		color: #b3b3b3;
		font-size: 0.9rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
</style>
