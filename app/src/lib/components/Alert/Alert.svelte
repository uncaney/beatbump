<script lang="ts">
	import { fullscreenStore } from "$lib/components/Player/channel";
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

<!-- U12-13: in the phone fullscreen player the bottom anchor put the toast on
     the "Suivant :" line under the controls; there it docks at the top. -->
<div
	class="alert-container"
	class:in-fullscreen={$fullscreenStore === "open"}
	data-testid="alert-container"
>
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
	// Audit UX v9 TOP 10 #10: anchored above the mini-bar (not mid-screen),
	// stacked, and off to the side on desktop so it stops reading as a banner
	// blocking the flow; still full-width bottom-centre on phones, where
	// there is no room to dock it to a corner.
	.alert-container {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		justify-content: center;
		position: fixed;
		// --alert-bottom is set by +layout.svelte (5.75em with a mini-bar,
		// 0rem without): keep using it so the offset still reacts to the
		// player bar actually being shown. Its own fallback uses the shared
		// --player-bar-height var (72px if that's unset either).
		bottom: calc(var(--alert-bottom, calc(var(--player-bar-height, 72px) + 0.75rem)) + env(safe-area-inset-bottom, 0px));
		left: 0;
		right: 0;
		z-index: 1000;
		max-height: 60vmin;
		align-items: center;
		margin: 0 auto;
		contain: layout;
		padding-bottom: 0.75rem;
		// Container is click-through so the page under it stays usable; each
		// toast opts back in below (and the has-action button was already
		// doing this before).
		pointer-events: none;

		@media (min-width: 640px) {
			left: auto;
			align-items: flex-end;
			padding-right: max(1.25rem, env(safe-area-inset-right, 0px));
		}
		// U12-13: phone fullscreen player. The controls, "Suivant :" and the
		// queue handle fill the bottom of the sheet; anchor the stack under its
		// top bar (over the artwork, above every control) instead.
		@media (max-width: 639.98px) {
			&.in-fullscreen {
				top: calc(env(safe-area-inset-top, 0px) + 4.5rem);
				bottom: auto;
				padding-bottom: 0;
			}
		}
	}

	// The toast itself still receives pointer events (hover/click on its own
	// action), only the container around it is click-through.
	.alert {
		pointer-events: auto;

		@media (min-width: 640px) {
			max-width: 26rem;
			width: auto;
		}
	}

	.alert.has-action {
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
