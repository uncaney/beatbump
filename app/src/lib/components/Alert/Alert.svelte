<script lang="ts">
	import { alertHandler } from "$lib/stores/stores";
	import type { Alert, AlertAction } from "$lib/stores/stores";
	import { flip } from "svelte/animate";
	import { expoOut } from "svelte/easing";
	import { fade, fly } from "svelte/transition";

	// Plain alerts auto-dismiss after ~3 s. An alert carrying an `{label, run}`
	// action renders a button and stays until it is clicked (or 20 s).
	const PLAIN_MS = 3125;
	const ACTION_MS = 20_000;

	// A string `action` (e.g. "getNextTrack" from player.ts) is legacy metadata
	// and renders nothing, as before.
	const actionOf = (a: Alert): AlertAction | null =>
		a.action && typeof a.action === "object" && typeof a.action.run === "function" ? a.action : null;

	function runAction(a: Alert) {
		const action = actionOf(a);
		alertHandler.remove(a);
		action?.run();
	}
</script>

<div class="alert-container">
	{#each $alertHandler as notif (notif.id)}
		<div
			in:fly|global={{ y: 150, duration: 250, easing: expoOut }}
			out:fade|global={{ duration: 1250, delay: 500 }}
			animate:flip={{ duration: 250, delay: 0 }}
			on:introend={() => {
				setTimeout(() => {
					alertHandler.remove(notif);
				}, actionOf(notif) ? ACTION_MS : PLAIN_MS);
			}}
			class={`alert m-alert-${notif.type}`}
			class:has-action={!!actionOf(notif)}
		>
			<span class="alert-msg">{notif.msg}</span>
			{#if actionOf(notif)}
				<button
					type="button"
					class="alert-action"
					on:click={() => runAction(notif)}
				>
					{actionOf(notif)?.label}
				</button>
			{/if}
		</div>
	{/each}
</div>

<style lang="scss">
	.alert-container {
		display: flex;
        flex-direction: column;
		justify-content: center;
		position: fixed;
		bottom: var(--alert-bottom, 5.75rem);
		left: 0;
		// flex-direction: column;flex-direction
		right: 0;
		z-index: 1000;
		// isolation: isolate;isolation
		max-height: 60vmin;
		align-items: center;
		margin: 0 auto;
		contain: layout;
		padding-bottom: 0.75rem;
		pointer-events: none;
	}

	// The container is click-through; an alert with a button must not be.
	.alert.has-action {
		pointer-events: auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 0.5rem 1rem;
	}

	.alert-action {
		all: unset;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 2.5rem; /* 40px tap target */
		padding: 0.375rem 0.875rem;
		border-radius: 0.5rem;
		font: inherit;
		font-weight: 600;
		text-shadow: none;
		/* The global %button-base forces a dark text colour; keep it readable on
		   the green/red alert backgrounds. */
		color: #fff !important;
		background: rgb(255 255 255 / 22%);
		cursor: pointer;
		transition: background-color 0.15s;

		&:hover {
			background: rgb(255 255 255 / 34%);
		}
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
</style>
