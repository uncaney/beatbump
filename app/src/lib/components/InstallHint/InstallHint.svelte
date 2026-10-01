<script lang="ts">
	// HL4: contextual install prompt. Shown above the mini-bar once eligible
	// (3rd visit or the first successful "Garder hors-ligne", see
	// `installHintEligible` in $lib/stores/pwa) AND the browser can actually
	// install the app (Chromium's captured `beforeinstallprompt`, or iOS where
	// the event never fires and we show the Share instructions instead) AND
	// it is not already installed, not snoozed (14 days, "Plus tard") and was
	// not shown yet this session. Never pops up right as a track starts
	// playing (a 2 s window after `AudioPlayer.paused` goes false).
	// Audit UX v11 U11-3: one full-width compact bar docked on the mini-bar
	// (or under the top nav while nothing plays) instead of a floating card
	// with two dismiss affordances; a single "Installer" + a single close
	// ("Plus tard" = the 14-day snooze); never over the fullscreen player or
	// the lyrics page, which it used to mask.
	import { onDestroy, onMount } from "svelte";
	import { page } from "$app/stores";
	import Icon from "$components/Icon/Icon.svelte";
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
	import { queue } from "$lib/stores/list";
	import { fullscreenStore } from "$components/Player/channel";

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
	// Playback surfaces (fullscreen player, lyrics): the bar stays out of the way.
	$: onPlaybackSurface =
		$fullscreenStore === "open" || ($page?.url?.pathname ?? "").startsWith("/lyrics");
	$: hasPlayer = $queue.length > 0;
	$: show =
		!dismissed &&
		!snoozed &&
		!justStartedPlaying &&
		!onPlaybackSurface &&
		!$isInstalled &&
		$installHintEligible &&
		canOffer;

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
		class:docked-top={!hasPlayer}
		role="status"
		data-testid="install-hint"
	>
		<p class="text">
			{#if $isIOS}
				Installe l'app : Partager puis « Sur l'écran d'accueil ».
			{:else}
				Installe l'application pour l'écouter sans réseau.
			{/if}
		</p>
		{#if !$isIOS}
			<button
				type="button"
				class="btn-primary install"
				on:click={install}>Installer</button
			>
		{/if}
		<button
			type="button"
			class="icon-btn close"
			aria-label="Plus tard"
			title="Plus tard"
			on:click={dismissForLonger}
		>
			<Icon
				name="x"
				size="1.25em"
				color="#fff"
				--stroke="#fff"
			/>
		</button>
	</div>
{/if}

<style lang="scss">
	.install-hint {
		position: fixed;
		left: 0;
		right: 0;
		// Docked right on top of the mini-bar (the footer is `--player-bar-height`
		// tall and fixed at the bottom); the safe-area inset is already inside
		// the bar. No transform / no centering: a full-width strip.
		bottom: var(--player-bar-height, 0px);
		z-index: 55;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: max(2.75rem, 44px);
		padding: 0.35rem 0.5rem 0.35rem 1rem;
		background: rgba(20, 20, 24, 0.97);
		border-top: 1px solid rgba(255, 255, 255, 0.12);
		color: #eee;
		// 12px floor at the 12px mobile root (audit v11: 10.2px before), shared token (c32a).
		font-size: var(--text-secondary-size);
		line-height: 1.3;
		box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.35);
		&.docked-top {
			bottom: auto;
			top: var(--top-bar-height, 0px);
			border-top: none;
			border-bottom: 1px solid rgba(255, 255, 255, 0.12);
			box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
		}
	}
	.text {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
	}
	// Compact primary: the system class gives the pill, 44px floor and plain
	// case; only the bar-friendly geometry lives here.
	.install {
		flex: 0 0 auto;
		font-size: inherit;
		padding-inline: 0.9rem;
		white-space: nowrap;
	}
	// `.icon-btn` is 44x44 and colourless by default (`var(--color-dark)`);
	// the glyph itself is white on this dark strip.
	.close {
		flex: 0 0 auto;
		color: #fff;
		border-radius: 50%;
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
</style>
