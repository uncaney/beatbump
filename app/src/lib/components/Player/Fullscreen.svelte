<script lang="ts">
	import { browser } from "$app/environment";
	import { navigating } from "$app/stores";
	import { goto } from "$app/navigation";
	import Icon from "$components/Icon/Icon.svelte";
	import Description from "$components/ArtistPageHeader/Description/Description.svelte";
	import Carousel from "$components/Carousel/Carousel.svelte";
	import DraggableList from "$components/DraggableList/DraggableList.svelte";
	import PopperButton from "$components/Popper/PopperButton.svelte";
	import { draggable } from "$lib/actions/draggable";
	import { pan } from "$lib/actions/gestures/handlers";
	import type { Detail } from "$lib/actions/gestures/types";
	import type { Dropdown } from "$lib/configs/dropdowns.config";
	import { CTX_ListItem } from "$lib/contexts";
	import { AudioPlayer, getSrc } from "$lib/player";
	import {
		immersiveQueue,
		isMobileMQ,
		isPagePlaying,
		playerLoading,
	} from "$lib/stores";
	import {
		currentTrack,
		queue,
		queuePosition,
		related,
	} from "$lib/stores/list";
	import { groupSession } from "$lib/stores/sessions";
	import type { Thumbnail } from "$lib/types";
	import { debounce, requestFrameSingle, notify } from "$lib/utils";
	import { downloadToDevice } from "$lib/offline";
	import { resolveArtistId } from "$lib/local";
	import SessionListService from "$stores/list/sessionList";
	import { SITE_ORIGIN_URL, playbackURLStateUpdater } from "$stores/url";
	import { windowWidth } from "$stores/window";
	import { onMount, tick } from "svelte";
	import { cubicOut, quartIn, quartOut } from "svelte/easing";
	import { tweened } from "svelte/motion";
	import {
		fade,
		type EasingFunction,
		type TransitionConfig,
	} from "svelte/transition";
	import ListItem, { listItemPageContext } from "../ListItem/ListItem.svelte";
	import Loading from "../Loading/Loading.svelte";
	import Tabs from "../Tabs";
	import type { TabItem } from "../Tabs";
	import Controls from "./Controls.svelte";
	import { createPlayerPopperMenu } from "./Player.svelte";
	import ProgressBar from "./ProgressBar";
	import { progressBarSeek } from "./ProgressBar/ProgressBar.svelte";
	import blurURL from "./blur.svg?url";
	import { fullscreenStore } from "./channel";
	import { cancelSleepTimer, sleepLabel } from "$stores/sleepTimer";
	import { currentIsFavourite, toggleCurrentFavourite } from "./favouriteState";
	export let state: "open" | "closed";

	// F2: heart label (state is refreshed by Player.svelte on track change)
	$: favLabel = $currentIsFavourite ? "Retirer des favoris" : "Ajouter aux favoris";

	const {
		paused,
		currentTimeStore: currentTime,
		videoUrlStore: videoUrl,
		mode,
	} = AudioPlayer;

	$: isPlaying = $paused;
	let windowHeight = 0,
		queueHeight = 0,
		sliding = false;
	let DropdownItems: Dropdown;
	let titleWidth = 320;
	let active = "UpNext";
	let tracklist: HTMLDivElement;
	let rmContextFn: (() => void) | undefined = undefined;
	let hasEverBeenOpen = false;

	$: hasEverBeenOpen =
		hasEverBeenOpen || (!hasEverBeenOpen && state === "open");
	$: loading = $playerLoading;
	$: data = $currentTrack;

	// Direct mobile actions (avoid the popper, which conflicts with the swipe gesture)
	async function mobileDownload() {
		const r = await downloadToDevice($currentTrack);
		notify(r.ok ? "Downloading…" : (r.reason || "Download failed"), r.ok ? "success" : "error");
	}
	async function mobileViewArtist() {
		const aid = await resolveArtistId($currentTrack);
		if (aid) navigateAway(`/artist/${aid}`);
	}
	// Leave the fullscreen player for a page (lyrics, artist). On mobile the
	// backdrop normally fades out over 800 ms after an 800 ms delay, so the
	// destination stayed hidden under the overlay (coordinator probe, 390x844).
	// `leaving` drops that transition, the queue sheet is closed, the store is
	// closed before the navigation starts, and the flag is kept long enough for
	// the layout's deferred `state = "closed"` (setTimeout 0) to land.
	let leaving = false;
	let leavingTimer: ReturnType<typeof setTimeout> | undefined;
	async function navigateAway(path: string) {
		leaving = true;
		if (leavingTimer) clearTimeout(leavingTimer);
		sheetOpen = false;
		if ($isMobileMQ) motion.set(-28, { duration: 0 });
		fullscreenStore.set("closed");
		await tick();
		try {
			await goto(path);
		} finally {
			leavingTimer = setTimeout(() => (leaving = false), 1200);
		}
	}
	$: heightCalc = -windowHeight + 120;
	$: queueOpen = true;
	let seeking = 0;

	$: seekTime = seeking || $currentTime;

	const enum Kind {
		Queue,
		Popup,
	}

	const upNextTab: TabItem = {
		id: "UpNext",
		text: "Up Next",
		action: () => {
			active = "UpNext";
		},
	};
	const relatedTab: TabItem = {
		id: "Related",
		text: "Related",
		action: () => {
			active = "Related";
		},
	};
	// The Related tab is only shown when the backend returned a browseId
	// (`MPTRt_…`) for the current track; previously the tab was always there
	// and its click was silently ignored when the id was empty (audit F10).
	// "Dans ta bibliothèque": owned tracks related to the current one (idea P8),
	// fetched per track; the Related tab shows when either source has content.
	let localRelated: any[] = [];
	let localRelatedFor = "";
	$: loadLocalRelated($currentTrack);
	async function loadLocalRelated(track: any) {
		if (!browser || !track?.videoId) return;
		const key = String(track.videoId);
		if (key === localRelatedFor) return;
		localRelatedFor = key;
		localRelated = [];
		try {
			const isLidId = /^[0-9a-f]{11}$/.test(key);
			const artist = track?.artistInfo?.artist?.[0]?.text || (typeof track?.artist === "string" ? track.artist : "") || "";
			const qs = isLidId
				? "lid=" + encodeURIComponent(key)
				: "title=" + encodeURIComponent(track?.title || "") + "&artist=" + encodeURIComponent(artist);
			const r = await fetch("/api/v1/local/related?" + qs);
			if (!r.ok || localRelatedFor !== key) return;
			const j = await r.json();
			localRelated = Array.isArray(j?.items) ? j.items.slice(0, 20) : [];
		} catch {
			localRelated = [];
		}
	}
	$: hasRelated = !!$SessionListService.related?.browseId || localRelated.length > 0;
	$: tabs = hasRelated ? [upNextTab, relatedTab] : [upNextTab];
	$: if (!hasRelated && active === "Related") active = "UpNext";

	const motion = tweened(-33, {
		duration: 180,
		easing: cubicOut,
	});

	const queueTween = tweened(0, {
		duration: 180,
		easing: cubicOut,
	});

	CTX_ListItem.set({ page: "queue" });

	function onDragStart() {
		sliding = true;
	}

	// Mobile queue sheet: explicit open/closed state for the labelled handle
	// (the legacy `queueOpen` flag is shared with the desktop side panel).
	let sheetOpen = false;
	const TAP_THRESHOLD_PX = 10;

	function toggleSheet() {
		if (sheetOpen) {
			motion.set(-28, { duration: 240 });
		} else {
			motion.set(heightCalc, { duration: 240 });
		}
		sheetOpen = !sheetOpen;
		queueOpen = !queueOpen;
	}

	function release(kind: Kind, detail: Detail) {
		if (sliding) {
			if (
				kind === Kind.Queue &&
				Math.abs(detail.deltaY || 0) < TAP_THRESHOLD_PX
			) {
				// a tap on the handle (no real drag) toggles the sheet
				toggleSheet();
			} else if (Math.sign(detail.deltaY || 0) < 0) {
				open(kind, detail);
			} else {
				close(kind, detail as Required<Detail>);
			}
			sliding = false;
		}
	}

	function trackMovement(kind: Kind, detail: Detail) {
		if (kind === Kind.Queue) {
			motion.set(Math.min(48, Math.max(heightCalc, detail.clientY - 8)), {
				duration: 180,
			});
		} else {
			queueTween.set(
				0 - (detail.clientY * 0.7 + detail.clientY * 0.3) / windowHeight,
				{ duration: 180 },
			);
		}
	}

	function open(kind: Kind, detail: Detail) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const step = detail.deltaY! / queueHeight;
		const miss =
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			detail.velocityY! >= 0 && detail.velocityY! > 0.2 ? 1 - step : 1 - step;
		const distance = miss * windowHeight;
		if (kind === Kind.Queue) {
			queueOpen = !queueOpen;
			sheetOpen = true;
			motion.update(
				() => {
					return heightCalc;
				},
				{
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					duration: Math.min(distance / Math.abs(detail.velocityY!), 640),
				},
			);
		} else {
			queueTween.update(
				(_) => {
					return 0;
				},
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				{ duration: Math.min(distance / Math.abs(detail.velocityY!), 640) },
			);
		}
	}

	function close(kind: Kind, detail: Required<Detail>) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const step = detail.deltaY! / queueHeight;
		const miss =
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			detail.velocityY! >= 0 && detail.velocityY! > 0.2 ? 1 - step : step;
		const distance = miss * windowHeight;
		if (kind === Kind.Queue) {
			queueOpen = !queueOpen;
			sheetOpen = false;
			motion.set(-28, {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				duration: Math.min(distance / Math.abs(detail.velocityY!), 720),
			});
		} else {
			queueTween.update(
				() => {
					return windowHeight;
				},
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				{ duration: Math.min(distance / Math.abs(detail.velocityY!), 720) },
			);
		}
		sliding = false;
	}

	$: {
		if (state === "open") {
			rmContextFn = listItemPageContext.add("queue");
			playbackURLStateUpdater.toggle();
		}
		if (state === "closed") {
			if (rmContextFn) {
				rmContextFn();
				rmContextFn = undefined;
				isPagePlaying.remove("player-queue");
			}
			if (hasEverBeenOpen) playbackURLStateUpdater.toggle();
		}
	}

	let thumbnail: Thumbnail = { height: 0, url: "", width: 0 };

	$: {
		if ($isMobileMQ) {
			DropdownItems = createPlayerPopperMenu(
				$currentTrack,
				$queuePosition,
				groupSession.hasActiveSession,
				$SITE_ORIGIN_URL,
			);
		} else {
			DropdownItems = [];
		}
	}

	$: if ($navigating !== null) {
		fullscreenStore.set("closed");
		$motion = 0;
		$queueTween = 0;
		sheetOpen = false;

		playbackURLStateUpdater.toggle();
	}

	function slideInOut(
		node: HTMLElement,
		{
			duration = 400,
			delay = 400,
			easing = quartOut,
		}: { duration?: number; easing?: EasingFunction; delay?: number },
	): TransitionConfig {
		const style = getComputedStyle(node);
		const target_opacity = +style.opacity;
		const transform = style.transform === "none" ? "" : style.transform;
		const od = target_opacity * (1 - 0);

		return {
			easing,
			duration,
			delay,
			css(t, u) {
				return `
				will-change: transform, opacity;
					transform: ${transform} translate3d(0vh, ${(1 - t) * 100}vh, 0vh);
					opacity: ${target_opacity - od * u};
				`;
			},
		};
	}

	let imgElm: HTMLImageElement;
	let videoElm: HTMLVideoElement;

	onMount(() => {
		let nextTrackThumbnail: Thumbnail | undefined;

		const currentTrackUnsub = currentTrack.subscribe((track) => {
			if (!track) return;
			if (
				imgElm &&
				typeof nextTrackThumbnail === "object" &&
				nextTrackThumbnail &&
				nextTrackThumbnail.url
			) {
				imgElm.src = nextTrackThumbnail.url;
				nextTrackThumbnail = undefined;
			}

			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			thumbnail = track.thumbnails.at(-1)!;

			if ($queue[$queuePosition + 1]) {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				nextTrackThumbnail = $queue[$queuePosition + 1].thumbnails.at(-1)!;
			}
		});

		return currentTrackUnsub;
	});

	const setVideoTime = debounce(() => {
		if (videoElm) {
			videoElm.pause();
			requestFrameSingle(() => {
				videoElm.play();
				videoElm.currentTime = $currentTime;
			});
		}
	}, 100);

	$: $progressBarSeek && setVideoTime();
</script>

{#if $queue.length && state === "open"}
	{#if $immersiveQueue}
		<div
			in:fade|global={{ duration: 200, delay: 200, easing: quartIn }}
			out:fade|global={{ duration: 300, delay: 0, easing: quartIn }}
			class={$immersiveQueue ? "immersive-wrapper" : "backdrop"}
			style={$immersiveQueue
				? `transform: scale(${
						state === "open" || queueOpen
							? $isMobileMQ
								? 2
								: 1.5
							: $isMobileMQ
							? 4
							: 2.2
				  }); --blur: ${queueOpen ? 2 : 8}px;}"`
				: "background-color: hsla(261, 14%, 13%, 1) !important; z-index:100; opacity:1;"}
		>
			>
			<img
				class="immersive"
				bind:this={imgElm}
				src={thumbnail.url}
				style="

            --svg: url({new URL(blurURL + '#blur', import.meta.url)}); "
				alt=""
			/>
		</div>
	{/if}
{/if}
<div
	class="backdrop"
	class:mobile={$isMobileMQ}
	class:open={state === "open"}
	class:leaving
	style:pointer-events={state === "open" ? "all" : "none"}
	bind:clientHeight={windowHeight}
	out:slideInOut={{ delay: 400, duration: 800, easing: quartOut }}
>
	<div
		class="fullscreen-player-popup"
		class:open={state === "open"}
		out:slideInOut={{ duration: 1400, delay: 400, easing: quartOut }}
	>
		<div
			class="column"
			use:pan={{ capture: true }}
			on:pan={(event) => {
				if (!$isMobileMQ) return;
				const { detail } = event;
				if (Math.abs(detail.deltaY || 0) < 65) return;
				trackMovement(0, detail);
			}}
			on:panend={(event) => {
				if (!$isMobileMQ) return;
				const { detail } = event;
				const direction = Math.sign(detail.deltaY || 0) === -1 ? "up" : "down";

				if (Math.abs(detail.deltaY || 0) < 65) return;
				if (direction === "down") {
					close(Kind["Popup"], detail);
					fullscreenStore.set("closed");
				} else {
					open(Kind["Popup"], detail);
				}
			}}
		>
			{#if $isMobileMQ}
				<div class="menu-mobile" style="display:flex;align-items:center;justify-content:space-between;left:0;right:0;width:auto;max-width:none;max-height:none;margin:0;padding:0.6em 0.5em;z-index:200;gap:0.2em;">
					<button
						type="button"
						aria-label="Fermer le lecteur"
						title="Fermer le lecteur"
						class="no-style"
						style="position:static;background:none;border:none;color:#fff;padding:0.4em;cursor:pointer;"
						on:click={() => fullscreenStore.set("closed")}
					>
						<Icon
							name="chevron-left"
							size="1.8em"
							color="#fff"
						/>
					</button>
					<div style="display:flex;align-items:center;gap:0.4em;">
						<button
							type="button"
							aria-label={favLabel}
							title={favLabel}
							aria-pressed={$currentIsFavourite}
							class="no-style"
							style="position:static;background:none;border:none;color:#fff;padding:0.4em;cursor:pointer;"
							on:click|stopPropagation={() => toggleCurrentFavourite($currentTrack)}
						>
							<Icon
								name="heart"
								size="1.6em"
								color="#fff"
								--stroke="#fff"
								fill={$currentIsFavourite ? "#fff" : "none"}
								strokeWidth={1.5}
							/>
						</button>
						<button
							type="button"
							aria-label="Voir l'artiste"
							title="Voir l'artiste"
							class="no-style"
							style="position:static;background:none;border:none;color:#fff;padding:0.4em;cursor:pointer;"
							on:click={mobileViewArtist}
						>
							<Icon
								name="artist"
								size="1.6em"
								color="#fff"
								--stroke="#fff"
							/>
						</button>
						<button
							type="button"
							aria-label="Télécharger sur l'appareil"
							title="Télécharger sur l'appareil"
							class="no-style"
							style="position:static;background:none;border:none;color:#fff;padding:0.4em;cursor:pointer;"
							on:click={mobileDownload}
						>
							<Icon
								name="download"
								size="1.6em"
								color="#fff"
								--stroke="#fff"
							/>
						</button>
						<button
							type="button"
							aria-label="Paroles"
							title="Paroles"
							class="no-style"
							style="position:static;background:none;border:none;color:#fff;padding:0.4em;cursor:pointer;"
							on:click|stopPropagation={() => navigateAway("/lyrics")}
						>
							<Icon
								name="music"
								size="1.6em"
								color="#fff"
							/>
						</button>
						<span
							class="more-options"
							title="Plus d'options"
							style="display:inline-flex;align-items:center;"
						>
							<PopperButton
								items={DropdownItems}
								tabindex={-1}
								size="2em"
							/>
						</span>
					</div>
				</div>
			{/if}
			<div
				class="album-art"
				style="width: {!$isMobileMQ ? (queueOpen ? 55 : 95) : '100'}vw;"
			>
				<div class="img-container">
					<div
						class="kind-selector"
						style={!$isMobileMQ
							? `transform: translate3d(${
									queueOpen ? 0 : 0
							  }vw, 0px, 0) !important;`
							: ""}
					>
						<div
							class="player-kind-wrapper"
							role="group"
							aria-label="Mode de lecture"
						>
							<button
								type="button"
								class:active={$mode === "video"}
								aria-pressed={$mode === "video"}
								title="Mode vidéo"
								on:click={() => {
									$mode = "video";
								}}>Vidéo</button
							><button
								type="button"
								class:active={$mode === "audio"}
								aria-pressed={$mode === "audio"}
								title="Mode audio"
								on:click={() => {
									$mode = "audio";
								}}>Audio</button
							>
						</div>
							{#if $sleepLabel}
								<!-- P4: sleep timer chip; click cancels the timer. -->
								<button
									type="button"
									class="sleep-chip"
									aria-label="Minuterie de sommeil : {$sleepLabel}. Annuler"
									title="Minuterie de sommeil : {$sleepLabel} (cliquer pour annuler)"
									data-testid="sleep-timer-chip-fullscreen"
									on:click|stopPropagation={() => cancelSleepTimer()}
								>
									<Icon
										name="clock"
										size="1em"
										color="#fff"
										--stroke="#fff"
									/>
									<span>{$sleepLabel}</span>
								</button>
							{/if}
					</div>
					{#if loading}
						<Loading size="3em" />
					{/if}

						{#if $mode === "audio"}
                            <div class="thumbnail" id="img">
							<img
								id="img"
								loading="lazy"
								style="aspect-ratio: {thumbnail?.width} / {thumbnail?.height};"
								width={thumbnail?.width}
								height={thumbnail?.height}
								src={thumbnail?.url ?? ""}
								alt="thumbnail"
							/>
                            </div>
						{:else}
                            <div class="thumbnail" id="vid">
							<video
								id="img"
								style="--poster-url: {thumbnail?.url}; aspect-ratio: {thumbnail?.width} / {thumbnail?.height};"
								autoplay
								poster={thumbnail?.url ?? ""}
								disablepictureinpicture
								disableremoteplayback
								width={thumbnail?.width}
								height={thumbnail?.height}
								bind:paused={$paused}
								bind:this={AudioPlayer.videoNode}
								preload="none"
								muted
                                controls
								playsinline
							/>
                            </div>
						{/if}

				</div>
			</div>
			{#if $isMobileMQ}
				<div class="container controls">
					<div
						class="container text-shadow"
						style="overflow:hidden;"
					>
						<div class="marquee">
							<span
								class="marquee-wrapper"
								style=" {titleWidth < $windowWidth
									? 'animation: none; transform: unset;'
									: ''}
									animation-play-state: {state === 'open' && titleWidth > $windowWidth
									? 'running'
									: 'paused'};"
								><span
									bind:clientWidth={titleWidth}
									class="h5 marquee-text">{data?.title}</span
								></span
							>
						</div>
						<span
							class="h6"
							style="text-align:center; "
							>{data?.artistInfo && data?.artistInfo.artist?.at(0)
								? data?.artistInfo?.artist?.at(0)?.text
								: ""}</span
						>
					</div>
					<div
						class="container"
						style="margin-bottom: 1em; max-width: 75vw; margin-inline: auto;"
					>
						<ProgressBar
							on:seek={() => {
								setVideoTime();
							}}
						/>
					</div>
					<Controls
						sizes={{ main: "2.75em", skip: "1.75em" }}
						bind:isPaused={isPlaying}
						bind:loading={$playerLoading}
						on:play={() => AudioPlayer.play()}
						isQueue={true}
						pause={() => AudioPlayer.pause()}
						nextBtn={() => {
							if ($queue.length === 0) return;
							SessionListService.next();
							// AudioPlayer.updateTime($durationStore);
						}}
						prevBtn={() => SessionListService.previous()}
					/>
				</div>
			{/if}
		</div>

		<div
			class="handle vertical"
			style="transform: translate3d({queueOpen
				? 53.5
				: 91.5}vw, 0, 0) !important;"
			on:pointerdown={() => {
				requestFrameSingle(() => {
					tracklist.style.willChange = "transform";
				});
			}}
			on:pointerup={() => {
				setTimeout(() => {
					requestFrameSingle(() => {
						tracklist.style.willChange = "unset";
					});
				}, 200);
				queueOpen = !queueOpen;
			}}
		>
			<hr class="vertical" />
		</div>
		<div
			class="column container tracklist"
			id="fullscreen-queue-sheet"
			bind:clientHeight={queueHeight}
			bind:this={tracklist}
			style={$isMobileMQ
				? `transform: translate3d(0, ${$motion}px, 0); top: ${
						windowHeight - 65
				  }px; bottom:0; padding-bottom: calc(6.5em);`
				: `transform: translate3d(${
						queueOpen ? 55 : 93
				  }vw, 0px, 0) !important;`}
		>
			<div
				use:draggable
				on:bb-dragstart|capture|stopPropagation={() => onDragStart()}
				on:bb-dragmove|capture|stopPropagation={(e) =>
					trackMovement(Kind.Queue, e.detail)}
				on:bb-dragend|capture|stopPropagation={(e) =>
					release(Kind.Queue, e.detail)}
				on:pointerdown={() => {
					tracklist.style.willChange = "top transform";
				}}
				on:pointerup={() => {
					setTimeout(() => {
						requestFrameSingle(() => {
							tracklist.style.willChange = "unset";
						});
					}, 200);
				}}
				on:keydown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						toggleSheet();
					}
				}}
				class="handle horizontal"
				role="button"
				tabindex="0"
				aria-expanded={sheetOpen}
				aria-controls="fullscreen-queue-sheet"
				aria-label={sheetOpen
					? "Masquer la file d'attente"
					: "Afficher la file d'attente"}
				title={sheetOpen ? "Masquer la file d'attente" : "Afficher la file d'attente"}
			>
				<hr class="horizontal" />
				<span class="handle-label" aria-hidden="true">
					<Icon
						name="chevron-right"
						size="1em"
						color="currentColor"
						style="transform: rotate({sheetOpen ? 90 : -90}deg); transition: transform 200ms;"
					/>
					<span>File d'attente</span>
				</span>
			</div>
			<Tabs
				{tabs}
				{active}
			>
				<svelte:fragment
					let:isActive
					let:tab
					slot="tab"
				>
					{#if tab.id === "UpNext"}
						{#if isActive}
							<div
								class="scroller"
								on:touchstart|stopPropagation={null}
							>
								<DraggableList
									items={$queue}
									on:dragend={() => {
										if ($groupSession.hasActiveSession)
											groupSession.updateGuestTrackQueue($SessionListService);
									}}
								>
									<ListItem
										let:index
										let:item
										draggable
										{item}
										idx={index}
										slot="item"
										on:setPageIsPlaying={async ({ detail }) => {
											if (isPagePlaying.has("player-queue")) {
												if (
													detail.isLocal &&
													$queue.length &&
													$SessionListService
												) {
													getSrc(item.videoId, undefined, undefined, true);
													SessionListService.updatePosition(detail.index);
												}
												return;
											}
											isPagePlaying.add("player-queue");
										}}
									/>
								</DraggableList>
							</div>
						{/if}
					{:else if isActive}
						<div class="scroller">
							<div class="pad">
								{#if localRelated.length}
									<section data-row="related-local" class="mb-2">
										<Carousel
											items={localRelated}
											header={{ title: "Dans ta bibliothèque", subheading: "Du même artiste, du même genre, chez toi" }}
											type="trending"
											isBrowseEndpoint={false}
										/>
									</section>
								{/if}
								{#if $related?.description?.description}
									<div class="mb-2">
										<span class="h2">{$related?.description?.header}</span>
										<Description
											description={$related.description.description}
										/>
									</div>
								{/if}
								{#if Array.isArray($related.carousels)}
									{#key $related.carousels}
										{#each $related.carousels as carousel}
											<Carousel
												header={carousel.header}
												items={carousel.items}
												type="home"
												kind={carousel.header?.type}
												isBrowseEndpoint={false}
											/>
										{/each}
									{/key}
								{/if}
							</div>
						</div>
					{/if}
				</svelte:fragment>
			</Tabs>
		</div>
	</div>
</div>

<style lang="scss">
	.pad {
		padding: 2vh 1em 1.5em;
		// height: 100%;

		overflow-y: auto;
		contain: style paint size layout;
		width: 100%;
	}

	.marquee {
		position: relative;
		overflow: hidden;
		max-width: calc(100% - 4em);
		margin: 0 auto;

		--max-width: calc(100% - 4em);
		--offset: 10vw;
		--move-initial: calc(-10vw + var(--offset));
		--move-final: calc(calc(-100% + 80vw) + var(--offset));
		--text-initial: calc(10vw);
		--text-final: calc(var(--text-initial) * 100vw);
	}

	.marquee-wrapper {
		width: fit-content;
		display: flex;
		position: relative;
		transform: translate3d(var(--move-initial), 0, 0);
		animation: marquee linear infinite forwards;
		animation-delay: 2s;
		animation-duration: 9s;
	}

	.marquee-text {
		padding: 0 1em;
		white-space: nowrap;
	}

	@keyframes marquee {
		0% {
			transform: translate3d(var(--move-initial), 0, 0);
		}

		25% {
			transform: translate3d(var(--move-initial), 0, 0);
		}

		75% {
			transform: translate3d(var(--move-final), 0, 0);
		}

		100% {
			transform: translate3d(var(--move-final), 0, 0);
		}
	}

	.controls {
		gap: 1em;
	}

	.text-shadow {
		text-shadow: 0.1em 0.1em 0.2em rgb(0 0 0 / 69.2%),
			-0.1em -0.1em 0.2em rgb(0 0 0 / 41.8%);
	}

	.scroller {
		overflow-y: auto;
		transform: translate3d(0, 0, 0);
		overflow-x: hidden;
		backface-visibility: hidden;
		contain: strict;
		overscroll-behavior: contain;
		height: inherit;
		-webkit-overflow-scrolling: touch;
		background: inherit;
	}

	.immersive-wrapper {
		position: fixed;
		inset: 0;
		overflow: hidden;
		contain: strict;
		overscroll-behavior: contain;
		touch-action: none;
		z-index: 151;
		pointer-events: none;
		isolation: isolate;
		contain: strict;
		perspective: 1000px;
		backface-visibility: hidden;
		will-change: opacity, top, filter, filter;
		transform: scale(var(--scale)) translate3d(0, 0, 0);
		transition: filter cubic-bezier(0.77, 0, 0.175, 1);
		transition-property: background-color, transform, filter, filter;
		transition-duration: 400ms;
		transition-delay: 0ms;

		@media screen and (max-width: 720px) {
			position: absolute;
			max-width: 100%;
			left: 0;
			top: 0;
			background-size: 100vh !important;
			background-attachment: scroll;
			background-position: center;
		}

		background-image: var(--background-image);
		box-shadow: 0 0 100px -20px #000000d5 inset, 0 0 50rem 5px #000000c9;
		filter: brightness(0.9) opacity(1) contrast(1) saturate(1.7) grayscale(0.35)
			sepia(0.2) blur(var(--blur, 4px));
	}
	.immersive {
		position: fixed;
		inset: 0;
		z-index: 1000;
		isolation: isolate;
		touch-action: none;
		pointer-events: none;
		overscroll-behavior: contain;
		contain: style;
		perspective: 1000px;
		backface-visibility: hidden;
		overflow: hidden;

		@media screen and (max-width: 720px) {
			position: fixed;
			z-index: 151;
			left: 0;
			top: 0;
			background-size: 50% 50% !important;
		}

		transform: scale(var(--scale)) translate3d(0, 0, 0);
		transition: backdrop-filter cubic-bezier(0.77, 0, 0.175, 1);
		transition-delay: 500ms;
		transition-property: background-color transform backdrop-filter
			backdrop-filter;
		transition-duration: 1600ms;
		background-color: hsl(0deg 0% 0%);

		&.open {
			background-color: hsl(0deg 0% 0% / 58.7%);
			&::after {
				// transition-delay: 100ms;
				// transition-duration: 300ms;
			}
		}

		&::after {
			content: "";
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;

			z-index: 1;
			touch-action: none;
			overscroll-behavior: contain;
			perspective: 1000px;
			backface-visibility: hidden;
		}

		will-change: opacity, top, backdrop-filter, backdrop-filter;
		object-fit: cover;
		height: 100%;

		overscroll-behavior: contain;
		width: 100%;
		position: absolute;
		backface-visibility: hidden;
		inset: 0;
		overflow: hidden;
		will-change: filter, visibility;
		touch-action: none;
	}

	.tracklist,
	.pad {
		position: absolute;
		bottom: 0;
		height: 100%;
		min-height: 0;
		background: var(--bottom-bg);
		overscroll-behavior: contain;
		touch-action: pan-y;
		// content-visibility: auto;
		z-index: 500;
		border-top-left-radius: $sm-radius;
		border-top-right-radius: $sm-radius;
		contain: paint layout style;

		@media screen and (min-width: 720px) {
			position: absolute;
			left: 0;
			width: calc(45vw);
			max-height: 100%;
			// transform: unset !important;
			height: 100% !important;
			// will-change: unset !important;
			transition: transform cubic-bezier(0.25, 0.46, 0.45, 0.94) 400ms;
			top: unset !important;
			border-top-left-radius: unset !important;
			border-top-right-radius: unset !important;
		}
	}

	.tracklist {
		box-shadow: 0px 5px 32px -10px #000;
	}
	.fullscreen-player-popup {
		position: absolute;
		top: 0;
		height: 100%;
		width: 100%;
		z-index: 1;
		grid-area: m;

		&::before {
			position: absolute;
			content: "";
			inset: 0;
			opacity: 0.2;
			background: var(--base-bg);
		}

		display: flex;
		isolation: isolate;
		touch-action: pan-y;
		transform: translate3d(0, 100vh, 0);
		will-change: transform, opacity;
		overscroll-behavior: contain;
		overflow: hidden;
		contain: strict;
		transition: transform 400ms cubic-bezier(0.895, 0.03, 0.685, 0.22);
		@media screen and (min-width: 720px) {
			// gap: 1em;
			flex-direction: row;
		}
		&.open {
			transform: translate3d(0, 0, 0);
			transition: transform 400ms cubic-bezier(0.215, 0.61, 0.355, 1) 0ms;
		}
	}

	hr {
		margin-bottom: 1rem;
		&.horizontal::before {
			position: absolute;
			inset: 0;
			content: "";
			margin: auto;
			width: 25%;
			color: hsl(0deg 0% 80%);
			background: rgb(206 206 206 / 30.8%);
			height: 0.45em;
			border-radius: 3.6667em;
			line-height: inherit;
			z-index: 5;
		}

		&.vertical::before {
			position: absolute;
			inset: 0;
			opacity: 0;
			transition: cubic-bezier(0.25, 0.46, 0.45, 0.94) 200ms opacity;
			content: "";
			margin: auto;
			height: 15%;
			color: hsl(0deg 0% 80%);
			background: rgb(206 206 206 / 30.8%);
			width: 0.45em;
			line-height: inherit;
			border-radius: 3.6667em;
			z-index: 100;
			transition-delay: 400ms;
		}

		&.vertical:hover::before {
			opacity: 1;
			transition: cubic-bezier(0.25, 0.46, 0.45, 0.94) 200ms opacity;
		}

		overscroll-behavior: contain;
		width: 100%;
		border: none;
		position: relative;

		&.vertical {
			height: 100%;
		}
	}

	.mobile {
		min-height: 100% !important;
		margin-top: unset !important;
	}

	@keyframes fade-in {
		0% {
			background-color: #0000;
		}

		100% {
			background-color: hsl(0deg 0% 0% / 58.7%);
		}
	}

	// P4 sleep timer chip, next to the Vidéo / Audio segment (static: the
	// component-wide `button { position: absolute }` rule below must not apply).
	.sleep-chip {
		position: static;
		all: unset;
		display: inline-flex;
		align-items: center;
		gap: 0.35em;
		margin-left: 0.75rem;
		align-self: center;
		padding: 0.35em 0.8em;
		min-height: 2.2em;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.4);
		background: rgba(0, 0, 0, 0.35);
		color: #fff;
		font-size: 0.85rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		&:hover {
			background: rgba(255, 255, 255, 0.2);
		}
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
		@media screen and (max-width: 719px) {
			margin-bottom: 0.75rem;
		}
	}

	.kind-selector {
		display: flex;
		max-width: 100%;
		justify-content: center;
		min-height: 2rem;
		margin-top: 2rem;
		width: 100%;
		@media screen and (min-width: 720px) {
			width: 53vw;
		}
		// Mobile: the absolute top action row (.menu-mobile, ~3.6em tall) must not
		// overlap the segment, and the segment must not wrap ("Vide/o").
		@media screen and (max-width: 719px) {
			margin-top: 3.75rem;
			min-height: unset;
		}
	}

	.player-kind-wrapper {
		display: grid;
		grid-template-columns: 1fr 1fr;
		position: relative;
		isolation: isolate;
		max-width: 50%;
		@media screen and (max-width: 719px) {
			max-width: none;
			width: fit-content;
			margin-bottom: 0.75rem;
			> button {
				white-space: nowrap;
				font-size: 0.95rem;
				min-height: 44px;
				padding: 0.5rem 1.1rem !important;
			}
		}
		> button:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
		// width: 100%;
		&::before {
			content: "";
			position: absolute;
			inset: 0;
			// background-color: var(--secondary-font-color);
			width: 1px;

			z-index: -11;
			left: 50%;
		}
		margin-bottom: 1.5rem;
		> button {
			all: unset;
			display: flex;
			align-items: center;
			justify-content: center;
			border: none;
			padding: 0.8rem 0.5rem calc(0.8rem - 2px) 0.5rem;

			line-height: 1;
			background-color: hsla(240, 20%, 6%, 0.493) !important;
			color: hsla(0, 0%, 100%, 0.8) !important;
			text-align: center;
			border: hsla(0, 0%, 50%, 0.7) 1px solid;
			font-weight: 600;
			font-size: 1.15rem;
			cursor: pointer;
			transition: background-color 200ms ease-in-out;
			&:last-of-type {
				padding: 0.8rem 1.25rem calc(0.8rem - 2px) 1.25rem;
				border-top-right-radius: 16px;
				border-bottom-right-radius: 16px;
			}
			&:first-of-type {
				padding: 0.8rem 1.25rem calc(0.8rem - 2px) 1.25rem;
				border-top-left-radius: 16px;
				border-bottom-left-radius: 16px;
			}
			&.active,
			&:hover {
				background-color: hsla(219, 7%, 40%, 0.733) !important;
				border-color: hsla(0, 0%, 60%, 0.8) !important;
			}

			@media screen and (min-width: 720px) {
				font-size: 1rem;
			}
		}
	}

	.menu-mobile {
		position: absolute;
		top: 0;
		right: 0;
		margin: 1em;
		z-index: 155;
		max-width: 3em;
		max-height: 3em;

		// a11y: >= 44px touch targets + visible keyboard focus
		button {
			min-width: 44px;
			min-height: 44px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border-radius: 50%;
			&:focus-visible {
				outline: 2px solid #fff;
				outline-offset: 2px;
			}
		}
	}

	.backdrop {
    /* ---------------------------------------------------
       1. LAYOUT & POSITIONING (Keep these exactly as they were)
    --------------------------------------------------- */
    grid-area: m;
    position: fixed;
    isolation: isolate;
    display: grid;
    background-color: #0000;
    inset: 0;
    z-index: 151;
    margin-top: var(--top-bar-height);
    height: calc(100% - calc(var(--top-bar-height) + var(--player-bar-height)));
    max-height: 100vh;
    contain: strict;
    touch-action: pan-y;
    will-change: transform, opacity;

    /* ---------------------------------------------------
       2. CLOSED STATE (Default)
    --------------------------------------------------- */
    pointer-events: none !important; 
    visibility: hidden !important; /* Completely hides it from the touch tree */
    opacity: 0;
    overscroll-behavior: auto !important; /* CRITICAL: Lets scroll pass through to the list */
    transition: opacity 800ms cubic-bezier(0.25, 0.46, 0.45, 0.94) 800ms, visibility 800ms 800ms;

    /* ---------------------------------------------------
       3. OPEN STATE (When player is expanded)
    --------------------------------------------------- */
    &.open {
        pointer-events: auto !important;
        visibility: visible !important;
        opacity: 1;
        overscroll-behavior: contain !important; /* CRITICAL: Locks background scroll when player is open */
        transition: opacity 400ms cubic-bezier(0.25, 0.46, 0.45, 0.94) 0ms;
    }

    /* Navigating away (lyrics / artist): hide at once instead of the 1.6 s fade,
       so the destination page is visible on mobile. */
    &.leaving:not(.open) {
        transition: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
    }
}

	.album-art {
		overscroll-behavior: contain;
		height: 100%;
		display: flex;
		place-items: center;
		margin-bottom: 1em;
		width: 55vw;
		justify-content: center;
		max-width: 100%;

		@media screen and (max-width: 719px) {
			margin-bottom: 0.25em;
			height: unset;
		}
	}

	.img-container {
		display: grid;
		place-items: center;
		min-height: 0;
		position: relative;
		max-width: 100%;
		height: 100%;
		overscroll-behavior: contain;
		max-height: 35vh;

		// Phones: the 28vh cap + 12vh margin left a ~30vh dead band between the
		// transport controls and the queue sheet (audit mobile-17). Let the
		// artwork take the height; the sheet handle sits at windowHeight-65.
		@media screen and (max-width: 719px) {
			max-height: none;
			margin-bottom: 1.5vh;
		}

		@media screen and (min-width: 1800px) {
			max-height: 45vh;
		}
	}

	.thumbnail {
		position: relative;
		overscroll-behavior: contain;
		height: 100%;
		min-height: 20vh;
		max-height: inherit;
		height: 100%;
		// Phones (390x844 / 360x780): 44vh artwork + ~9.5vh selector block +
		// ~22vh title/progress/controls still clears the queue handle without
		// scrolling; 92vw keeps a square cover inside the viewport in landscape.
		@media screen and (max-width: 719px) {
			height: 44vh;
			min-height: 44vh;
			max-height: 44vh;
			max-width: 92vw;
		}
		video,
		img {
			touch-action: none;
			max-width: inherit;
			max-height: inherit;
			width: 100%;
			height: 100%;
			object-fit: contain;
			overscroll-behavior: contain;
			border-radius: 4px;
			&:not(video) {
				filter: drop-shadow(0 0 12px rgb(0 0 0 / 66%));
			}
			&:not(img) {
				background: var(--poster-url);
			}
		}
	}

	button {
		position: absolute;
		top: 0;
		right: 0;
		z-index: 100;
	}

	.horizontal {
		width: 100%;
		border-top-left-radius: $sm-radius;
		border-top-right-radius: $sm-radius;
		height: 4.5em;
		padding-bottom: 0.0606em;
		padding-block: 0.7em;
		align-content: center;
		top: 0;
		left: 0;

		@media screen and (min-width: 720px) {
			display: none !important;
			visibility: none !important;
		}
	}

	// Explicit, labelled queue sheet handle (mobile): grip bar + "File d'attente"
	.handle.horizontal {
		grid-template-rows: auto auto;
		justify-items: center;
		row-gap: 0.15em;
		padding-block: 0.5em 0.4em;
		height: auto;
		min-height: 3.6em;

		// the grip bar (::before, 0.45em) is centered inside this box
		hr.horizontal {
			height: 1.2em;
			margin: 0 0 0.2em;
			padding: 0;
		}

		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: -3px;
		}
	}

	.handle-label {
		display: inline-flex;
		align-items: center;
		gap: 0.35em;
		font-size: 0.85em;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: hsla(0, 0%, 100%, 0.85);
		line-height: 1;
		user-select: none;
		pointer-events: none;
	}

	.handle {
		overscroll-behavior: contain;
		z-index: 1;
		display: grid;
		cursor: pointer;
		padding: 0.12em;
		align-items: center;
		touch-action: none;
	}

	.handle.vertical {
		@media screen and (max-width: 719px) and (hover: hover) {
			display: none;
			visibility: none;
		}

		left: 0;
		position: absolute;
		transition: transform cubic-bezier(0.25, 0.46, 0.45, 0.94) 400ms;

		@media screen and (min-width: 720px) and (hover: hover) {
			width: 2.5em;
			height: 100%;
			padding-right: 0.0606em;
			place-items: center;
		}
	}
</style>
