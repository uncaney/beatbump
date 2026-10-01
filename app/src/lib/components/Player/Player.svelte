<script
    context="module"
    lang="ts"
>
    const volumeMenuHandler = (callback: () => void, delay: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const toggle = () => {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            } else {
                timer = setTimeout(callback, delay);
            }
        };

        return {
            toggle,
        };
    };

    export const createPlayerPopperMenu = (
        $currentTrack: Item,
        $queuePosition: number,
        hasActiveSession = false,
        $SITE_ORIGIN_URL: string,
    ) =>
        buildDropdown()
            .add("View Artist", async () => {
                const __aid = await resolveArtistId($currentTrack);
                if (__aid) {
                    fullscreenStore.set("closed"); // reveal the destination on mobile
                    window.scrollTo({ behavior: "smooth", top: 0, left: 0 });
                    goto(`/artist/${__aid}`);
                }
            })
            .add("Lyrics", () => {
                fullscreenStore.set("closed");
                goto("/lyrics");
            })
            .add("Add to Playlist", async () => {
                fullscreenStore.set("closed");
                showAddToPlaylistPopper.set({ state: true, item: $currentTrack });
            })
            .add(
                hasActiveSession ? "Share Group Session" : "Start Group Session",
                hasActiveSession
                    ? async () => {
                        if (!browser) return;
                        const shareData = {
                            title: `Join ${groupSession.client.displayName}'s Beatbump Session`,

                            url: `${$SITE_ORIGIN_URL}/session?token=${IsoBase64.toBase64(
                                JSON.stringify({
                                    clientId: groupSession.client.clientId,
                                    displayName: groupSession.client.displayName,
                                }),
                            )}`,
                        };
                        try {
                            if (!navigator.canShare) {
                                await navigator.clipboard.writeText(shareData.url);
                                notify("Link copied successfully", "success");
                            } else {
                                const share = await navigator.share(shareData);
                                notify("Shared successfully", "success");
                            }
                        } catch (error) {
                            notify("Error: " + error, "error");
                        }
                    }
                    : async () => {
                        if (!browser) return;
                        showGroupSessionCreator.set(true);
                    },
            )
            .add("Shuffle", () => {
                list.shuffle($queuePosition, true);
            })
            .add("Download to device", async () => {
                const r = await downloadToDevice($currentTrack);
                notify(r.ok ? "Downloading…" : (r.reason || "Download failed"), r.ok ? "success" : "error");
            })
            // P4 / T1 (lane c8b): both open a sheet portalled to <body>, so they
            // work from the mini-bar and from the mobile fullscreen ⋮ alike.
            .add("Minuterie de sommeil", () => {
                showSleepTimerSheet.set(true);
            })
            .add("Raccourcis clavier", () => {
                showShortcutsSheet.set(true);
            })
            .build()
            .filter(Boolean);
</script>

<script lang="ts">
	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	import { resolveArtistId } from "$lib/local";
	import { recordHistory } from "$lib/me";
	import { historyThreshold, isLoopRestart } from "$stores/statsPlayCount";
	import { downloadToDevice } from "$lib/offline";
	import Icon from "$components/Icon/Icon.svelte";
	import { clickOutside } from "$lib/actions/clickOutside";
	import { IMAGE_NOT_FOUND } from "$lib/constants";
	import { AudioPlayer } from "$lib/player";
	import { groupSession, isMobileMQ } from "$lib/stores";
	import list, { currentTrack, queue, queuePosition } from "$lib/stores/list";
	import { IsoBase64, notify, slide } from "$lib/utils";
	import { messenger } from "$lib/utils/sync";
	import { IDBService } from "$lib/workers/db/service";
	import {
		playerLoading,
		showGroupSessionCreator,
		showAddToPlaylistPopper,
		showDownloadSongPopper,
	} from "$stores/stores";
	import { PopperButton } from "../Popper";
	import Controls from "./Controls.svelte";
	import ProgressBar from "./ProgressBar";
	import { fullscreenStore } from "./channel";
	import keyboardHandler from "./keyboardHandler";
	import SleepTimerSheet, { showSleepTimerSheet } from "./SleepTimerSheet.svelte";
	import ShortcutsSheet, {
		showShortcutsSheet,
	} from "$components/ShortcutsSheet/ShortcutsSheet.svelte";
	import { cancelSleepTimer, sleepLabel } from "$stores/sleepTimer";
	import {
		currentIsFavourite,
		refreshFavouriteState,
		toggleCurrentFavourite,
	} from "./favouriteState";

	import { buildDropdown } from "$lib/configs/dropdowns.config";
	import type { Item } from "$lib/types";
	import SessionListService from "$stores/list/sessionList";
	import { SITE_ORIGIN_URL } from "$stores/url";
	import PlayerButton from "./PlayerButton.svelte";
	const { paused, volume: AudioPlayerVolume } = AudioPlayer;

	$: volume = $AudioPlayerVolume;
	let volumeHover = false;

	const handleVolumeHover = volumeMenuHandler(() => {
		volumeHover = !volumeHover;
	}, 500);

	$: isPlaying = $paused;

	// S2 "historique honnête": a play is recorded (server-side history →
	// recently/most-played + taste + stats) only once the track has really
	// played HISTORY_MIN_SECONDS (or half of a track shorter than 60 s), not on
	// track change. One event per track playback: the flag resets when the
	// videoId changes, so seeks / pauses never double-count and skips < 30 s
	// are never counted. Payload unchanged (the full current item).
	// G10 (audit v4): in "repeat one" the <audio> loops without a track change;
	// each loop (time wrapping from the end to the start, see isLoopRestart in
	// $stores/statsPlayCount) starts a new play, counted after 30 s again.
	const { currentTimeStore: historyTime, durationStore: historyDuration } = AudioPlayer;
	let _historyId = "";
	let _historySent = false;
	$: if (browser && ($currentTrack?.videoId ?? "") !== _historyId) {
		_historyId = $currentTrack?.videoId ?? "";
		_historySent = false;
	}
	let _historyPrevTime = 0;
	$: if (browser) {
		const t = $historyTime;
		if (_historySent && isLoopRestart(_historyPrevTime, t, $historyDuration)) _historySent = false;
		_historyPrevTime = t;
	}
	$: if (
		browser &&
		_historyId &&
		!_historySent &&
		$historyTime >= historyThreshold($historyDuration) &&
		$currentTrack?.videoId === _historyId
	) {
		_historySent = true;
		recordHistory($currentTrack);
	}

	// F2: favourite state of the playing track (mini-bar + fullscreen hearts).
	let _lastFavId = "";
	$: if (browser && ($currentTrack?.videoId ?? "") !== _lastFavId) {
		_lastFavId = $currentTrack?.videoId ?? "";
		refreshFavouriteState($currentTrack);
	}
	$: favLabel = $currentIsFavourite ? "Retirer des favoris" : "Ajouter aux favoris";

	messenger.listen("player", () => {
		AudioPlayer.play();
	});

	function handleImageError(event: Event) {
		(event.target as HTMLImageElement).src = IMAGE_NOT_FOUND;
	}

	async function dlDevice() {
		if (!$currentTrack) return;
		const r = await downloadToDevice($currentTrack);
		notify(r.ok ? "Downloading…" : (r.reason || "Download failed"), r.ok ? "success" : "error");
	}

	$: DropdownItems = createPlayerPopperMenu(
		$currentTrack,
		$queuePosition,
		$groupSession.hasActiveSession,
		$SITE_ORIGIN_URL,
	);

	// T1: keyboard shortcuts (desktop; keyboardHandler ignores inputs / textareas /
	// contenteditable). Letters are matched by physical key (KeyJ…) so they work
	// on AZERTY too; "/" and "?" are matched by `event.key`. The table shown by
	// "?" lives in ShortcutsSheet.svelte (SHORTCUT_ROWS): keep both in sync.
	let controlsRef: Controls | undefined;
	let mutedVolume = 0;

	function togglePlay() {
		if (!$queue.length) return;
		if ($paused) {
			AudioPlayer.play();
		} else {
			AudioPlayer.pause();
		}
	}
	function prevTrack() {
		if (!$queue.length) return;
		SessionListService.previous();
	}
	function nextTrack() {
		if (!$queue.length) return;
		SessionListService.next();
	}
	function seekBy(delta: number) {
		const duration = AudioPlayer.duration;
		if (!duration || !$queue.length) return;
		const to = Math.min(Math.max(0, AudioPlayer.currentTime + delta), duration);
		AudioPlayer.seek(to);
	}
	function volumeBy(delta: number) {
		const v = Math.min(1, Math.max(0, ($AudioPlayerVolume ?? 0) + delta));
		AudioPlayer.setVolume(Math.round(v * 100) / 100);
	}
	function toggleMute() {
		if (($AudioPlayerVolume ?? 0) > 0) {
			mutedVolume = $AudioPlayerVolume;
			AudioPlayer.setVolume(0);
		} else {
			AudioPlayer.setVolume(mutedVolume > 0 ? mutedVolume : 0.5);
		}
	}
	function toggleFullscreen() {
		if (!$queue.length) return;
		fullscreenStore.toggle();
	}
	function focusSearch() {
		const box = document.getElementById("searchBox") as HTMLInputElement | null;
		if (box) {
			box.focus();
			box.select?.();
			return;
		}
		(document.querySelector(".nav-item__search") as HTMLElement | null)?.click();
		setTimeout(() => {
			(document.getElementById("searchBox") as HTMLInputElement | null)?.focus();
		}, 60);
	}

	const shortcut = {
		Space: togglePlay,
		KeyK: togglePlay,
		Comma: prevTrack,
		KeyP: prevTrack,
		Period: nextTrack,
		KeyN: nextTrack,
		ArrowLeft: () => seekBy(-5),
		ArrowRight: () => seekBy(5),
		KeyJ: () => seekBy(-10),
		KeyL: () => seekBy(10),
		ArrowUp: () => volumeBy(0.05),
		ArrowDown: () => volumeBy(-0.05),
		KeyM: toggleMute,
		KeyS: () => controlsRef?.toggleShuffle(),
		KeyR: () => controlsRef?.cycleRepeat(),
		KeyF: toggleFullscreen,
		KeyH: () => toggleCurrentFavourite($currentTrack),
		"/": focusSearch,
		"?": () => showShortcutsSheet.update((v) => !v),
	};
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
	class="player"
	aria-haspopup="true"
	on:click={(e) => {
		fullscreenStore.toggle();
	}}
	tabindex="-1"
	use:keyboardHandler={{ shortcut }}
>
	<div
		class="now-playing"
		style="align-items:center;"
	>
		{#if $queue.length !== 0}
			<img
				width="64"
				height="64"
				on:error|capture={handleImageError}
				src={$currentTrack?.thumbnails?.[0]?.url ?? IMAGE_NOT_FOUND}
				alt="{$currentTrack?.title} thumbnail image"
			/>
			<div
				class="container"
				style="
    font-weight: 400;
    font-family: ''Commissioner Variable'';
    letter-spacing: -0.02em;"
			>
				<span class="now-playing-title">{$currentTrack?.title}</span>
				{#if $currentTrack?.artistInfo?.artist?.[0]?.browseId}
					<a class="now-playing-artist" style="color:inherit;text-decoration:none"
						href={`/artist/${$currentTrack.artistInfo.artist[0].browseId}`}
						>{$currentTrack?.artistInfo?.artist?.[0]?.text}</a
					>
				{:else}
					<span class="now-playing-artist"
						>{$currentTrack?.artistInfo?.artist?.[0]?.text}</span
					>
				{/if}
			</div>
		{:else}
			<img
				width="64"
				height="64"
				on:error={(event) => handleImageError(event)}
				style="object-fit:scale-down; background: #000;"
				src={IMAGE_NOT_FOUND}
				alt=""
			/>
			<div
				class="container"
				style="gap:0.20125em;"
			>
				<span>Not Playing</span>
				<div />
			</div>
		{/if}
	</div>
	<div
		class="player-controls"
		style:display={$isMobileMQ ? "none" : "block"}
	>
		{#if !$isMobileMQ}
			<Controls
				bind:this={controlsRef}
				bind:isPaused={isPlaying}
				bind:loading={$playerLoading}
				on:play={() => AudioPlayer.play()}
				pause={() => AudioPlayer.pause()}
				nextBtn={() => {
					if ($queue.length === 0) return;
					SessionListService.next(undefined, true);
					// AudioPlayer.updateTime($durationStore);
				}}
				prevBtn={() => {
					if ($queue.length && $SessionListService.position >= 1)
						SessionListService.previous(true);
				}}
			/>
			<ProgressBar />
		{/if}
	</div>

	<div class="player-right">
		<div
			class="container row"
			style="gap:0.5em;"
		>
			<div
				class="volume"
				on:pointerleave={handleVolumeHover.toggle}
				use:clickOutside
				on:click_outside={() => (volumeHover = false)}
			>
				<div
					color="white"
					class="volume-icon player-btn"
					role="button"
					tabindex="0"
					aria-label="Volume"
					title="Volume"
					aria-expanded={volumeHover}
					on:pointerover={() => {
						handleVolumeHover.toggle();
					}}
					on:click|capture|stopPropagation={() => (volumeHover = !volumeHover)}
					on:keydown|stopPropagation={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							volumeHover = !volumeHover;
						}
					}}
				>
					<Icon
						color="white"
						name="volume"
						size="1.625em"
					/>
				</div>
				{#if volumeHover}
					<div
						class="volume-wrapper"
						transition:slide|global={{ duration: 80, y: 100 }}
					>
						<div class="volume-slider">
							<input
								class="volume"
								type="range"
								on:click|capture|stopPropagation={() => {
									// no empty
								}}
								on:input|capture|stopPropagation={(e) => {
									let linear =
										(e.target instanceof HTMLInputElement
											? e.target.valueAsNumber
											: volume) / 1;
									let sqrt = Math.pow(linear, 1.2);
									AudioPlayer.setVolume(sqrt);
								}}
								bind:value={volume}
								min="0"
								max="1"
								step="any"
							/>
						</div>
					</div>
				{/if}
			</div>
			{#if !$isMobileMQ}
				{#if $sleepLabel}
					<!-- P4: sleep timer countdown (desktop bar only); click cancels. -->
					<button
						type="button"
						class="player-btn no-style sleep-chip"
						aria-label="Minuterie de sommeil : {$sleepLabel}. Annuler"
						title="Minuterie de sommeil : {$sleepLabel} (cliquer pour annuler)"
						data-testid="sleep-timer-chip"
						on:click|stopPropagation={() => cancelSleepTimer()}
					>
						<Icon
							color="#fff"
							--stroke="#fff"
							name="clock"
							size="1.1em"
						/>
						<span>{$sleepLabel}</span>
					</button>
				{/if}
				<!-- F2: favourite toggle for the playing track (desktop bar only). -->
				<button
					type="button"
					class="player-btn no-style heart-btn"
					aria-label={favLabel}
					title={favLabel}
					aria-pressed={$currentIsFavourite}
					disabled={!$currentTrack?.videoId}
					on:click|stopPropagation={() => toggleCurrentFavourite($currentTrack)}
				>
					<Icon
						color="#fff"
						--stroke="#fff"
						name="heart"
						fill={$currentIsFavourite ? "#fff" : "none"}
						strokeWidth={1.5}
						size="1.5em"
					/>
				</button>
			{/if}
			<!-- Lyrics + download are hidden from the mini-bar under 576px (both live
			     in the fullscreen top bar) so the title column keeps >= 100px. -->
			<a
				class="player-btn no-style mini-secondary"
				href="/lyrics"
				aria-label="Paroles"
				data-testid="player-lyrics"
				title="Paroles"
				style="display:flex;align-items:center;color:#fff;"
				on:click|preventDefault|stopPropagation={() => {
					// The bar's own click toggles the fullscreen player (hence stopPropagation),
					// but stopping propagation also hides the click from SvelteKit's router
					// listener on document: navigate explicitly so the queue survives.
					fullscreenStore.set("closed");
					goto("/lyrics");
				}}
			>
				<Icon
					color="#fff"
					--stroke="#fff"
					name="music"
					size="1.5em"
				/>
			</a>
			<button
				type="button"
				class="player-btn no-style mini-secondary"
				aria-label="Télécharger sur l'appareil"
				title="Télécharger sur l'appareil"
				on:click|stopPropagation={dlDevice}
				style="background:none;border:none;cursor:pointer;display:flex;align-items:center;color:#fff;"
			>
				<Icon
					color="#fff"
					--stroke="#fff"
					name="download"
					size="1.5em"
				/>
			</button>
			<div
				on:click|capture|stopPropagation={() => {
					if (!$queue) return;
					fullscreenStore.toggle();
				}}
				on:keydown|stopPropagation={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						if (!$queue) return;
						fullscreenStore.toggle();
					}
				}}
				role="button"
				tabindex="0"
				aria-label="File d'attente"
				title="File d'attente"
				class="listButton player-btn"
			>
				<Icon
					color="white"
					name="queue"
					size="1.625em"
				/>
			</div>
			{#if !$isMobileMQ}
				<div class="menu-container" title="Plus d'options">
					<PopperButton
						tabindex={-1}
						type="player"
						size="1.625em"
						items={DropdownItems}
					/>
				</div>
			{:else}
				<div class="menu-container mobile-controls">
					<PlayerButton />
					<!-- Mobile mini-bar "next": same logic as the desktop Controls nextBtn callback. -->
					<button
						type="button"
						class="player-btn no-style mini-next"
						aria-label="Morceau suivant"
						title="Morceau suivant"
						on:click|capture|stopPropagation={() => {
							if ($queue.length === 0) return;
							SessionListService.next(undefined, true);
						}}
					>
						<Icon
							color="white"
							style="stroke-width:2; stroke: white;"
							name="skip-forward"
							fill="none"
							size="1.5em"
						/>
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- Sheets are portalled to <body> (the footer has `contain: layout`), and sit
     outside the .player div so their clicks never toggle the fullscreen. -->
<SleepTimerSheet />
<ShortcutsSheet />

<style lang="scss">
	@import "../../../global/stylesheet/components/player";
	.now-playing {
		display: flex;
		grid-area: n;
		line-height: 1.3;
		font-size: 0.95em;
		gap: 0.95em;
		// grid item: allow the text column to shrink instead of wrapping mid-word
		min-width: 0;

		@media screen and (min-width: 720px) {
			line-height: 1.4;
			font-size: 14px;
			// gap: 0.875em;gap
		}

		> .container {
			visibility: visible;
			display: flex;
			flex-direction: column;
			flex: 1 1 auto;
			min-width: 0;
			overflow: hidden;
		}
	}
	// (was `:where(.now-playing) title`, a non-existent element: nothing applied
	// and the title broke into "Aerodyna / mic" on mobile)
	.now-playing-title {
		display: block;
		white-space: nowrap;
		text-overflow: ellipsis;
		max-width: 100%;
		overflow: hidden;
		word-break: normal;
		overflow-wrap: normal;
	}
	// < 576px: lyrics + download leave the mini-bar (available in the fullscreen)
	.mini-secondary {
		@media screen and (max-width: 575.75px) {
			display: none !important;
			visibility: hidden !important;
		}
	}
	.now-playing-artist {
		display: block;
		font-size: 12px;
		color: rgba(255, 255, 255, 0.7) !important;

		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		line-clamp: 2;
		overflow: hidden;
	}
	.now-playing img {
		object-fit: contain;
		background: #000;
		max-height: 4.25rem;
		max-width: 4.25rem;
		width: 100%;
	}
	.player-controls {
		width: 100%;
	}

	row {
		position: relative;
	}

	.hidden {
		display: none !important;
		visibility: hidden !important;
	}

	.volume {
		position: relative;
		will-change: visibility, display;
		@media screen and (max-width: 575.75px) {
			visibility: hidden;
			display: none;
		}
	}

	.listButton {
		visibility: hidden !important;
		order: -1;
		pointer-events: none;
	}

	.player {
		background-color: inherit;
	}

	.volume-wrapper {
		background: var(--dark-bottom);
		display: flex;

		position: absolute;
		bottom: 7em;
		transform: rotate(-90deg);
		padding: 0 0.4rem;
		left: calc(calc(100% * -1) + 2px);
		height: 1.3rem;
		border-radius: 0.6rem;
		isolation: isolate;
		z-index: 100;
		&::before {
			content: "";
			position: absolute;
			width: 100%;
			// bottom: 0;
			// inset: 0;
			top: 50%;
			left: 50%;
			transform: translate(-50%, -50%);
			height: 2rem;
		}
	}

	.volume-slider {
		height: 100%;
		background: var(--dark-bottom);

		display: flex;
		align-items: center;
	}

	.volume-icon {
		cursor: pointer;
	}

	.menu-container {
		padding: 0;
		position: relative;
		place-self: flex-end;
		align-self: center;
		@media screen and (max-width: 575.5px) {
			position: relative !important;
			place-self: center;
		}
	}

	.mobile-controls {
		display: inline-flex;
		align-items: center;
		gap: 0.1em;
	}

	// a11y: icon buttons in the mini-bar: >= 44px touch target + visible focus ring
	.player-right .player-btn {
		min-width: 44px;
		min-height: 44px;
		justify-content: center;
		border-radius: 50%;

		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
	.mini-next {
		background: none;
		border: none;
		color: #fff;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		padding: 0.5em;
	}
	.heart-btn {
		background: none;
		border: none;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		color: #fff;
		&[disabled] {
			opacity: 0.4;
			cursor: default;
		}
	}
	.sleep-chip {
		background: rgba(255, 255, 255, 0.12);
		border: 1px solid rgba(255, 255, 255, 0.35);
		border-radius: 999px !important;
		color: #fff;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 0.35em;
		font-size: 0.8em;
		font-weight: 600;
		padding: 0.35em 0.8em;
		min-height: 2.2em;
		white-space: nowrap;
		&:hover {
			background: rgba(255, 255, 255, 0.22);
		}
	}

	.player-left,
	.player-right {
		align-self: center;

		align-items: center;
	}

	.player-right {
		grid-area: r;
		display: inline-flex;
		justify-content: end;
		.container {
			width: auto;
		}
	}

	@media screen and (min-width: 720px) {
		.listButton {
			visibility: visible !important;
			order: 0;
			pointer-events: unset;
		}
	}
</style>
