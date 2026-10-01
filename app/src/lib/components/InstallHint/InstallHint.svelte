<script lang="ts">
	// HL4: contextual install prompt. Shown above the mini-bar once eligible
	// (3rd visit or the first successful "Garder hors-ligne", see
	// `installHintEligible` in $lib/stores/pwa) AND the browser can actually
	// install the app (Chromium's captured `beforeinstallprompt`, or iOS where
	// the event never fires and we show the Share instructions instead) AND
	// it is not already installed, not snoozed (14 days, "Plus tard") and was
	// not shown yet this session. Never pops up right as a track starts
	// playing (a 2 s window after `AudioPlayer.paused` goes false).
	import { onDestroy, onMount } from "svelte";
	import {
		installHintEligible,
		installPrompt,
		isInstalled,
		isIOS,
		isInstallHintSnoozed,
		promptInstall,
		snoozeInstallHint,
	} from "$lib/stores/pwa";
	import { AudioPlayer } from "$lib/player";

	// Shown at most once per session: once true, stays true for the rest of
	// this component's (= the app's) lifetime, whatever triggers next.
	let dismissed = false;
	let snoozed = true;
	let justStartedPlaying = false;
	let startTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		snoozed = isInstallHintSnoozed();
		let prevPaused = true;
		const unsubPaused = AudioPlayer.paused.subscribe((paused) => {
			if (prevPaused && !paused) {
				justStartedPlaying = true;
				clearTimeout(startTimer);
				startTimer = setTimeout(() => (justStartedPlaying = false), 2000);
			}
			prevPaused = paused;
		});
		return unsubPaused;
	});
	onDestroy(() => clearTimeout(startTimer));

	$: canOffer = $isIOS || !!$installPrompt;
	$: show = !dismissed && !snoozed && !justStartedPlaying && !$isInstalled && $installHintEligible && canOffer;

	function dismissForNow() {
		dismissed = true;
	}
	function dismissForLonger() {
		dismissed = true;
		snoozeInstallHint();
	}
	async function install() {
		try {
			await promptInstall();
		} finally {
			dismissed = true;
		}
	}
</script>

{#if show}
	<div
		class="install-hint"
		role="status"
		data-testid="install-hint"
	>
		<div class="text">
			{#if $isIOS}
				<p>Installe l'app : appuie sur Partager puis « Sur l'écran d'accueil ».</p>
			{:else}
				<p>Installe l'application pour l'écouter sans réseau.</p>
			{/if}
		</div>
		<div class="actions">
			{#if !$isIOS}
				<button
					type="button"
					class="btn-secondary"
					on:click={install}>Installer l'application</button
				>
			{/if}
			<button
				type="button"
				class="btn-ghost"
				on:click={dismissForLonger}>Plus tard</button
			>
			<button
				type="button"
				class="btn-ghost close"
				aria-label="Fermer"
				on:click={dismissForNow}
			>
				&times;
			</button>
		</div>
	</div>
{/if}

<style lang="scss">
	.install-hint {
		position: fixed;
		left: 50%;
		transform: translateX(-50%);
		bottom: calc(var(--player-bar-height, 0px) + 0.75rem);
		z-index: 55;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem 0.9rem;
		max-width: calc(100vw - 2rem);
		padding: 0.6rem 0.9rem;
		border-radius: 0.9rem;
		background: rgba(20, 20, 24, 0.96);
		border: 1px solid rgba(255, 255, 255, 0.12);
		color: #eee;
		font-size: var(--text-secondary-size);
		box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
	}
	.text p {
		margin: 0;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-left: auto;
	}
	.close {
		// L8-7: 32px undercut .btn-ghost's 44px floor (scoped rule wins).
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		padding: 0;
		font-size: 1.1rem;
		line-height: 1;
	}
</style>
