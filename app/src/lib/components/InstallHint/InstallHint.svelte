<script lang="ts">
	// HL4: contextual install prompt. Shown above the mini-bar once the
	// session heard its first sound (c48c B8-4: `installHintGate` in ./gate,
	// AudioPlayer.paused true -> false once; /bienvenue, the install page, is
	// the one page whose first paint may carry it; the HL4 3rd-visit /
	// first-keep eligibility of $lib/stores/pwa no longer shows it on first
	// paint) AND the browser can actually
	// install the app (Chromium's captured `beforeinstallprompt`, or iOS where
	// the event never fires and we show the Share instructions instead) AND
	// it is not already installed, not snoozed (14 days, "Plus tard") and was
	// not shown yet this session. Never pops up right as a track starts
	// playing (a 2 s window after `AudioPlayer.paused` goes false: the first
	// sound shows the bar 2 s later, not on the beat).
	// Audit UX v11 U11-3: one full-width compact bar docked on the mini-bar
	// instead of a floating card
	// with two dismiss affordances; a single "Installer" + a single close
	// ("Plus tard" = the 14-day snooze); never over the fullscreen player or
	// the lyrics page, which it used to mask.
	// UX5 (cycle 35): without a mini-player it docks on the bottom edge
	// (safe-area inset) instead of under the top nav, where it covered the
	// library nav and the page title; see ./dock.ts.
	import { onDestroy, onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/stores";
	import Icon from "$components/Icon/Icon.svelte";
	import {
		installPrompt,
		isAndroid,
		isInstalled,
		isIOS,
		isInstallHintSnoozed,
		promptInstall,
		snoozeInstallHint,
	} from "$lib/stores/pwa";
	import { AudioPlayer } from "$lib/player";
	import { queue } from "$lib/stores/list";
	import { fullscreenStore } from "$components/Player/channel";
	import { installHintDock, installHintGeometry, installHintReserve } from "./dock";
	import { heardFirstSound, installHintGate, installOffer, showInstallHintLink } from "./gate";

	// Shown at most once per session: once true, stays true for the rest of
	// this component's (= the app's) lifetime, whatever triggers next.
	let dismissed = false;
	let snoozed = true;
	let justStartedPlaying = false;
	// c48c B8-4: a track started playing in this session (never reset).
	let heardSound = false;
	let startTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		snoozed = isInstallHintSnoozed();
		let prevPaused = true;
		const unsubPaused = AudioPlayer.paused.subscribe((paused) => {
			if (heardFirstSound(prevPaused, paused)) {
				heardSound = true;
				justStartedPlaying = true;
				clearTimeout(startTimer);
				startTimer = setTimeout(() => (justStartedPlaying = false), 2000);
			}
			prevPaused = paused;
		});
		return unsubPaused;
	});
	onDestroy(() => clearTimeout(startTimer));

	// U14-3: the captured prompt (one tap), the iOS Share steps, or the menu
	// steps on an Android that never fired `beforeinstallprompt` (Vanadium,
	// Firefox, a prompt refused once): the bar used to not exist there at all.
	$: offer = installOffer({ isIOS: $isIOS, isAndroid: $isAndroid, hasPrompt: !!$installPrompt });
	$: canOffer = offer !== null;
	// Playback surfaces (fullscreen player, lyrics): the bar stays out of the way.
	$: onPlaybackSurface =
		$fullscreenStore === "open" || ($page?.url?.pathname ?? "").startsWith("/lyrics");
	$: hasPlayer = $queue.length > 0;
	$: dock = installHintDock(hasPlayer);
	$: geometry = installHintGeometry(dock);
	// c48c B8-4: after the first sound of the session, or on /bienvenue; never on first paint.
	$: allowed = installHintGate({ heardSound, pathname: $page?.url?.pathname ?? "" });
	// B9-1 (U13-13): on /bienvenue the page IS the guide, so drop the self-referential link.
	$: showHowLink = showInstallHintLink($page?.url?.pathname ?? "");
	$: show =
		!dismissed &&
		!snoozed &&
		!justStartedPlaying &&
		!onPlaybackSurface &&
		!$isInstalled &&
		allowed &&
		canOffer;

	// L10-14: while shown, the page's main keeps the strip's height free at its
	// end (global rule below), so the last row / button stays reachable.
	let stripHeight = 0;
	$: reserve = installHintReserve(show, stripHeight);
	$: applyReserve(reserve);
	function applyReserve(r: string | null) {
		if (typeof document === "undefined") return;
		const root = document.documentElement;
		if (r) {
			root.style.setProperty("--install-hint-reserve", r);
			root.setAttribute("data-install-hint", "");
		} else {
			root.style.removeProperty("--install-hint-reserve");
			root.removeAttribute("data-install-hint");
		}
	}
	onDestroy(() => applyReserve(null));

	function dismissForLonger() {
		dismissed = true;
		snoozeInstallHint();
	}
	async function install() {
		let outcome: Awaited<ReturnType<typeof promptInstall>> = "unavailable";
		try {
			outcome = await promptInstall();
		} finally {
			dismissed = true;
		}
		// U14-3: the browser had no prompt to show after all ("This app cannot
		// be installed"): the steps page, not a bar that silently closes.
		if (outcome === "unavailable") void goto("/bienvenue");
	}
</script>

{#if show}
	<div
		class="install-hint"
		data-dock={dock}
		style:--install-hint-bottom={geometry.bottom}
		style:--install-hint-safe-area={geometry.safeArea}
		role="status"
		data-testid="install-hint"
		bind:offsetHeight={stripHeight}
	>
		<p class="text">
			{#if offer === "ios"}
				Installe l'app : Partager puis « Sur l'écran d'accueil ».
			{:else if offer === "android-manual"}
				<!-- U14-3: no `beforeinstallprompt` on this Android: the gesture in words. -->
				<span data-testid="install-hint-steps">Installe l'app : menu ⋮ puis « Installer l'application » (ou « Ajouter à l'écran d'accueil »).</span>
			{:else}
				Installe l'application pour l'écouter sans réseau.
			{/if}
			<!-- B7-13: the steps page, for whoever does not know the gesture.
			     B9-1 (U13-13): never on /bienvenue, where it would point to this page. -->
			{#if showHowLink}
				<a
					class="how"
					href="/bienvenue"
					data-testid="install-hint-how"
					on:click={() => (dismissed = true)}>Comment installer ?</a
				>
			{/if}
		</p>
		{#if offer === "prompt"}
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
	// L10-14: extra room at the end of the page while the strip is shown
	// (additive: a spacer after the page's own bottom padding).
	:global(html[data-install-hint] main)::after {
		content: "";
		display: block;
		height: var(--install-hint-reserve, 0px);
		pointer-events: none;
	}
	.install-hint {
		position: fixed;
		left: 0;
		right: 0;
		// Docked right on top of the mini-bar (the footer is `--player-bar-height`
		// tall and fixed at the bottom; the safe-area inset is already inside
		// the bar), or on the bottom edge without a player, padded by the
		// safe-area inset (dock.ts). Never docked at the top, so no nav or page title
		// under it. No transform / no centering: a full-width strip.
		bottom: var(--install-hint-bottom, var(--player-bar-height, 0px));
		z-index: 55;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: max(2.75rem, 44px);
		padding: 0.35rem 0.5rem calc(0.35rem + var(--install-hint-safe-area, 0px)) 1rem;
		background: rgba(20, 20, 24, 0.97);
		border-top: 1px solid rgba(255, 255, 255, 0.12);
		color: #eee;
		// 12px floor at the 12px mobile root (audit v11: 10.2px before), shared token (c32a).
		font-size: var(--text-secondary-size);
		line-height: 1.3;
		box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.35);
	}
	.text {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
	}
	// 44px tap target without inflating the strip: the negative block margin
	// keeps the line box at the text height while the box stays 44px tall.
	.how {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-block: -14px;
		margin-inline-start: 0.35em;
		color: #fff;
		text-decoration: underline;
		white-space: nowrap;
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
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
