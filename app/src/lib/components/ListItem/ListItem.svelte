<svelte:options
	immutable={true}
	accessors={true}
/>

<script
	context="module"
	lang="ts"
>
    import {APIClient} from "$lib/api";
    // Audit v8 TOP 2: a restored queue keeps " • " runs whose neighbour run
    // was dropped, so every row ended with an orphan "•". Trim at render time.
    import { trimSeparatorRuns } from "$lib/utils/subtitleRuns";

	type StoreSubscriptions = {
		$startIndex?: number;
		$queue?: ISessionListService["mix"];
		$list?: ISessionListProvider;
	};

	const startIndex = writable(0);

	export const listItemPageContext = (() => {
		let stack: { context: PageContext }[] = [];

		const { subscribe, update } = writable<PageContext>();
		return {
			subscribe,
			isLibrary() {
				return stack.filter(({ context }) => context === "library").length > 0;
			},
			add(context: PageContext) {
				const id = { context } as const;
				if (context === "queue") {
					stack.unshift(id);
				} else {
					stack.push(id);
				}
				update(() => stack[0].context);
				return () => {
					stack = stack.filter((ctx) => ctx !== id);
				};
			},
		};
	})();

	const PositionCache = () => {
		type TrackListPosition = number;
		type QueuePosition = number;
		const cache = new Map<TrackListPosition, QueuePosition>();

		return {
			cache,
			get(position: TrackListPosition): QueuePosition {
				return cache.get(position)!;
			},
			set(trackListPosition: TrackListPosition, queuePosition: QueuePosition) {
				cache.set(trackListPosition, queuePosition);
				return queuePosition;
			},
			has(trackListPosition: TrackListPosition): boolean {
				return cache.has(trackListPosition);
			},
			clear() {
				return cache.clear();
			},
		} as const;
	};

	const cache = PositionCache();

	interface ClickHandler {
		(
			item: Item,
			index: number,
			stores: StoreSubscriptions,
			context: PageContext,
			visitorData?: string,
		): Promise<void>;
	}

	function binarySearchIndex<T extends Record<string, any>[]>(
		arr: T,
		target: Partial<T[number]>,
		compareFn: (a: Partial<T[number]>, b: Partial<T[number]>) => number,
	): number {
		let left = 0;
		let right = arr.length - 1;

		while (left <= right) {
			const mid = Math.floor((left + right) / 2);
			const cmp = compareFn(arr[mid], target);

			if (cmp === 0) {
				return mid;
			} else if (cmp < 0) {
				left = mid + 1;
			} else {
				right = mid - 1;
			}
		}

		return -1;
	}

	const handlePlaylistClick: ClickHandler = async (
		item,
		index,
		stores,
		context,
		visitorData,
	) => {
		const { $queue, $startIndex = 0, $list } = stores;
		if (item.playlistId === $list!.currentMixId) {
			if ($queue && index - $startIndex < $queue.length) {
				await list.updatePosition($startIndex || index);

				await list.getSessionContinuation({
					videoId: item?.videoId,
					key: $startIndex || index,
					playlistId: item.playlistId,
					loggingContext: item.loggingContext,
					playerParams: item?.playerParams,
					playlistSetVideoId: item?.playlistSetVideoId,
					ctoken: $list ? $list.continuation : "",
					clickTrackingParams: item.clickTrackingParams || "",
				});
			} else {
				await list.updatePosition($startIndex || index);

				await list
					.getSessionContinuation({
						videoId: item?.videoId,
						key: $startIndex || index,
						playlistId: item.playlistId,
						loggingContext: item.loggingContext,
						playerParams: item?.playerParams,
						playlistSetVideoId:
							APIParams.lt100 === item.playerParams
								? undefined
								: item?.playlistSetVideoId,

						ctoken: $list!.continuation,
						clickTrackingParams: item.clickTrackingParams!,
					})
					.catch(() => {
						return list.initPlaylistSession({
							playlistId: item.playlistId ?? "",
							visitorData,
							clickTrackingParams: item?.clickTrackingParams,
							index: index,
							params: item.playerParams ?? item?.itct,
							playlistSetVideoId: item?.playlistSetVideoId,
							videoId: item?.videoId,
						});
					});
			}
			return;
		}
		await tick();
		await list.updatePosition(index);
		if (context === "playlist" || context === "release") {
			await list.initPlaylistSession({
				videoId: item?.videoId,
				index: $startIndex || index,
				playlistId: item.playlistId!,
				loggingContext: item?.loggingContext as any,
				params: item?.playerParams,
				playlistSetVideoId: item?.playlistSetVideoId,
				visitorData,
				clickTrackingParams: item.clickTrackingParams!,
			});
		} else {
			await list.initAutoMixSession({
				playlistId: item.playlistId || "",

				clickTracking:
					($queue &&
						item.playlistId === $list?.currentMixId &&
						$queue[index]?.clickTrackingParams) ||
					item?.clickTrackingParams,
				keyId: index,
				config: { playerParams: item.playerParams ?? item?.itct },
				playlistSetVideoId: item?.playlistSetVideoId,
				videoId: item?.videoId,
			});
		}
	};

	const buildMenu = ({
		item,
		idx,
		SITE_ORIGIN_URL,
		dispatch,
		page,
	}: BuildMenuParams) =>
		buildDropdown()
			.add("View Artist", async () => {
				const __aid = await resolveArtistId(item);
				if (__aid) goto(`/artist/${__aid}`);
				await tick();
				window.scrollTo({
					behavior: "smooth",
					top: 0,
					left: 0,
				});
			})
			// Queue actions (P1). On a queue row "Lire ensuite" MOVES the row right
			// after the current track; "Ajouter à la file" is meaningless there.
			.add(
				"Lire ensuite",
				page === "queue"
					? () => {
							list.moveTrackNext(idx);
					  }
					: () => playNext(item),
			)
			.add(page === "queue" ? undefined : "Ajouter à la file", () =>
				addToQueueEnd(item),
			)
			.add("Play Song Radio", async () => {
				list.initAutoMixSession({
					videoId: item.videoId,
					playlistId: item.autoMixList ?? "",
					loggingContext: item?.loggingContext,
				});
			})
			.add("Add to Playlist", async () => {
				if (item.endpoint?.pageType.match(/PLAYLIST|ALBUM|SINGLE/)) {
					const response = await APIClient.fetch(
                        `/api/v1/get_queue.json?playlistId=` + item.playlistId,
					);
					const data = await response.json();
					const items: Item[] = data;
					showAddToPlaylistPopper.set({ state: true, item: [...items] });
				} else {
					showAddToPlaylistPopper.set({ state: true, item });
				}
				dispatch("change");
			})
			.add(
				window.location.href.indexOf("playlists") != -1
					? "Remove From Playlist"
					: undefined,
				async () => {
					let playListId = window.location.href.split("/").pop();
					await deleteSongFromPlaylist(playListId, item.videoId);
					dispatch("change");
				},
			)
			.add("Download to device", async () => {
				const r = await downloadToDevice(item);
				notify(r.ok ? "Téléchargement…" : (r.reason || "Échec du téléchargement"), r.ok ? "success" : "error");
			})
			.add("Garder hors-ligne", () => {
				void keepItemOffline(item);
			})
			.add("Favorite", () => {
				saveFavourite(item);
			})
			.add(
				page === "queue" ? "Remove from Queue" : undefined,
				page === "queue"
					? () => {
							list.removeTrack(idx);
					  }
					: undefined,
			)
			.add("Share", async () => {
				let shareData: {
					title: string;
					url: string;
					text?: string;
				} = {
					title: item.title,
					url: `${SITE_ORIGIN_URL}/listen?id=${item.videoId}`,
				};
				if (item.endpoint?.pageType?.includes("MUSIC_PAGE_TYPE_PLAYLIST")) {
					shareData = {
						title: item.title,

						url: `${SITE_ORIGIN_URL}/playlist/${item.endpoint?.browseId}`,
					};
				}
				if (item.endpoint?.pageType?.includes("MUSIC_PAGE_TYPE_ALBUM")) {
					shareData = {
						title: item.title,

						url: `${SITE_ORIGIN_URL}/release?id=${item.endpoint?.browseId}`,
					};
				}
				if (item.endpoint?.pageType?.includes("MUSIC_PAGE_TYPE_ARTIST")) {
					shareData = {
						title: item.title,
						text: `${item.title} sur Musique`,
						url: `${SITE_ORIGIN_URL}/artist/${item.endpoint?.browseId}`,
					};
				}
				try {
					if (!navigator.canShare) {
						await navigator.clipboard.writeText(shareData.url);
						notify("Lien copié", "success");
					} else {
						await navigator.share(shareData);
						notify("Partagé", "success");
					}
				} catch (error) {
					notify("Erreur : " + error, "error");
				}
			})
			.build();
</script>

<script lang="ts">
	import { page as PageStore } from "$app/stores";
	import {
		isMobileMQ,
		isPagePlaying,
		queue,
		showAddToPlaylistPopper,
		showDownloadSongPopper,
	} from "$lib/stores";
	import type { Item } from "$lib/types";
	import { Logger, notify } from "$lib/utils";

	import { goto } from "$app/navigation";
	import { resolveArtistId, entityHref } from "$lib/local";
	import { coverLabel, hueFor, initials } from "$lib/utils/initials";
	import { UNAVAILABLE_OFFLINE_MSG, cachedIds, downloadToDevice, networkOffline } from "$lib/offline";
	import { keepItemOffline, rowOfflineState } from "$lib/offlineBatch";
	import { addToQueueEnd, playNext } from "$lib/queueActions";
	import { buildDropdown } from "$lib/configs/dropdowns.config";
	import { APIParams, FINITE_LIST_PARAMS } from "$lib/constants";
	import { CTX_ListItem } from "$lib/contexts";
	import { currentTrack, queuePosition } from "$lib/stores/list";
	import type {
		ISessionListProvider,
		ISessionListService,
	} from "$lib/stores/list/types.list";
	import type { PageContext } from "$lib/types/allContexts";
	import type { BuildMenuParams } from "$lib/types/common";
	import { saveFavourite } from "$lib/favourites";
	import list from "$stores/list/sessionList";
	import { AudioPlayer, getSrc } from "$lib/player";
	import { get } from "svelte/store";
	import { SITE_ORIGIN_URL } from "$stores/url";
	import { isDesktopMQ } from "$stores/window";
	import { createEventDispatcher, tick } from "svelte";
	import { writable } from "svelte/store";
	import Icon from "../Icon/Icon.svelte";
	import { fullscreenStore } from "../Player/channel";
	import PopperButton from "../Popper/PopperButton.svelte";

	export let item: Item;
	export let idx: number;

	export let draggable = false;

	const dispatch = createEventDispatcher<{
		click: { index: number; id?: number };
		setPageIsPlaying: { isLocal: boolean; id: string; index: number };
		initLocalPlaylist: { idx: number };
		change: undefined;
	}>();
	const {
		visitorData = "",
		parentPlaylistId = "",
		page: currentCtx,
	} = CTX_ListItem.get()!;
	$: page = $listItemPageContext as PageContext;
	// MUST be reactive: VirtualList recycles ListItem instances with new `item`
	// props; a `const` menu would keep pointing at the row's ORIGINAL track
	// (e.g. View Artist always opening the first song's artist).
	$: DropdownItems = buildMenu({
		item,
		idx,
		SITE_ORIGIN_URL: $SITE_ORIGIN_URL,
		dispatch,
		page,
	});

	$: isPlaying =
		($isPagePlaying.has($PageStore.params.slug) || currentCtx === "queue") &&
		$queue.length > 0 &&
		$queuePosition === idx &&
		$currentTrack?.videoId === item.videoId;

	let isHovering = false;

	// V1: cached rows get the badge; offline, the others are muted and a
	// click explains instead of failing.
	$: offlineState = rowOfflineState(item?.videoId, $cachedIds, $networkOffline);

	// Cover placeholder (initials on a deterministic hue) once the <img> errors
	// (audit v8 TOP 4: local tracks without artwork, same as LocalListItem).
	let imgBroken = false;
	$: coverName = coverLabel(item);
	$: coverInitials = initials(coverName);
	$: coverHue = hueFor(coverName);

	// Keyboard activation of the labelled thumbnail ("Lire {title}").
	function thumbKeydown(e: KeyboardEvent) {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		e.stopPropagation();
		void handleClick(e as unknown as MouseEvent);
	}

	async function handleClick(event: MouseEvent) {
		const target = event.target as HTMLElement;
		// The subtitle link's text is a span inside the <a>: look up, not at the target.
		if (target && (target.nodeName === "A" || target.closest?.("a"))) return;
		if (offlineState === "unavailable") {
			notify(UNAVAILABLE_OFFLINE_MSG, "error");
			return;
		}

		Logger.dev(item);
		const queueIndex = binarySearchIndex<typeof $list.mix>(
			$list.mix,
			{ index: idx },
			(a, b) => (a.index ?? 0) - (b.index ?? 0),
		);

		const position = cache.has(idx)
			? cache.get(idx)
			: cache.set(idx, queueIndex < 0 ? idx : queueIndex);
		//console.log(event, position, idx, queueIndex, $list);
		//Logger.mark(`Handle Click: ${position}`);
		switch (page) {
			case "queue": {
				if (listItemPageContext.isLibrary() && !list.isLocalPlaylist) {
					dispatch("initLocalPlaylist", { idx });
					dispatch("setPageIsPlaying", { isLocal: true, id: "", index: idx });
					return;
				}

				await handlePlaylistClick(
					{ ...item, params: FINITE_LIST_PARAMS },
					position,
					{ $list, $queue, $startIndex: idx },
					page,
					visitorData || undefined,
				);
				break;
			}
			case "playlist":
				Logger.mark(`Handle Playlist Click @ ${$startIndex}:  ${position}`);
				await handlePlaylistClick(
					item,
					position,
					{ $list, $queue, $startIndex },
					page,
					visitorData || undefined,
				);
				break;
			case "library":
				list.updatePosition(idx);
				dispatch("initLocalPlaylist", { idx });
				break;
			case "release":
				Logger.mark(`Release Click: ${$startIndex} ${position}`);
				await handlePlaylistClick(
					item,
					position,
					{ $list, $queue, $startIndex },
					page,
					visitorData || undefined,
				);

				break;
			default:
				// The clicked row is already the current track (e.g. restored session,
				// paused at 0:00): resume it instead of re-resolving the mix, which was
				// a silent no-op. Already playing: leave it alone.
				if (item.videoId && $currentTrack?.videoId === item.videoId) {
					if (get(AudioPlayer.paused)) {
						await getSrc(item.videoId, item.playlistId ?? parentPlaylistId ?? undefined, item?.playerParams ?? undefined, true);
					}
					break;
				}
				await list.initAutoMixSession({
					videoId: item.videoId,
					playlistId: item.playlistId ?? parentPlaylistId,
					playlistSetVideoId: item?.playlistSetVideoId,
					keyId: idx,
					clickTracking: item?.clickTrackingParams ?? undefined,
					loggingContext: item?.loggingContext,
					config: {
						playerParams: item?.playerParams,
						type: item?.musicVideoType,
					},
				});
				break;
		}
		dispatch("setPageIsPlaying", {
			isLocal: page === "library",
			id: `${parentPlaylistId}`,
		});
	}
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<!-- V1: aria-disabled marks a row that cannot play offline (harness offline_badges). -->
<!-- svelte-ignore a11y-role-supports-aria-props -->
<article
	class="m-item"
	tabindex="0"
	class:isPlaying
	class:release-row={currentCtx === "release"}
	class:offline-unavailable={offlineState === "unavailable"}
	data-offline={offlineState || undefined}
	aria-disabled={offlineState === "unavailable" ? "true" : undefined}
	{draggable}
	on:click|stopPropagation={handleClick}
	on:pointerenter={() => {
		isHovering = true;
	}}
	on:pointerleave={() => {
		isHovering = false;
	}}
>
	{#if ($isMobileMQ && (!Array.isArray(item.thumbnails) || !item.thumbnails.length)) || $isDesktopMQ}
		<div class="index">
			<span class:hidden={isPlaying !== true && isHovering !== true}>
				<!--#9990a0-->
				<Icon
					name="play"
					color="inherit"
					size="1.5em"
					strokeWidth={2}
				/>
			</span>
			<span class:hidden={isPlaying !== false || isHovering !== false}>
				{idx + 1}
			</span>
		</div>
	{/if}
	<div class="metadata">
		{#if Array.isArray(item.thumbnails) && item.thumbnails.length}
			<!-- The permanent play badge on touch screens is a CSS ::after of
			     .thumbnail (index.scss); the thumbnail carries the accessible
			     name "Lire {title}" and plays the row from the keyboard too
			     (audit v3 1.7 / TOP 10 #8). -->
			<div
				class="thumbnail"
				role="button"
				tabindex="0"
				aria-label={`Lire ${item.title ?? ""}`}
				on:keydown={thumbKeydown}
			>
				<img
					decoding="async"
					loading="lazy"
					src={item.thumbnails[0]?.url}
					width={item.thumbnails[0]?.width}
					height={item.thumbnails[0]?.height}
					alt=""
					on:error={() => (imgBroken = true)}
				/>
				{#if imgBroken && coverInitials}
					<span
						class="cover-initials"
						aria-hidden="true"
						style="--cover-hue: {coverHue}; font-size: 1.5em;">{coverInitials}</span
					>
				{/if}
			</div>
		{/if}
		<div class="column">
			<span class="title"
				>{item.title}
				{#if offlineState === "ready"}
					<span
					class="offline-badge"
					role="img"
					aria-label="Prêt hors-ligne"
					title="Prêt hors-ligne"
					data-testid="offline-badge"
					><!-- U13-16: the pin of the "Garder" button (Listing.svelte B9-4), not a download arrow. -->
					<Icon
						name="pin"
						size="14px"
						strokeWidth={2}
					/></span
				>
				{/if}
				{#if item.explicit}
					<Icon
						name="explicit"
						strokeWidth={0}
						fill="hsla(0, 0%, 95%, 0.7)"
						size="12px"
					>
						<span class="sr-only">Explicit</span>
					</Icon>
				{/if}
			</span>
			<div class="artists secondary">
				{#if Array.isArray(item.subtitle)}
					{#each trimSeparatorRuns(item.subtitle) as subtitle}
						{#if subtitle?.browseId}
							<!-- Hit area = the text span only (see .artists > a in index.scss):
							     a tap on the wrapped subtitle line plays the row. -->
							<a
								class="artist secondary"
								href={entityHref(subtitle.browseId, subtitle.pageType)}
								on:click|preventDefault|stopPropagation={() => {
									goto(entityHref(subtitle.browseId, subtitle.pageType));
									fullscreenStore.set("closed");
								}}><span>{subtitle.text}</span></a
							>
						{:else}
							<span>{subtitle.text} </span>
						{/if}
					{/each}
				{/if}
			</div>
		</div>
	</div>
	{#if $PageStore.data.iOS || $PageStore.data.Android || $isMobileMQ || isHovering}
		<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
		<div
			class="length"
			tabindex="0"
			role="group"
			aria-label="Plus d'options"
			title="Plus d'options"
			on:focus={() => (isHovering = true)}
		>
			<PopperButton
				tabindex={0}
				items={DropdownItems}
			/>
		</div>
	{:else}
		<span
			class="length"
			class:hidden={!item?.length ? true : false}
			>{(item?.length?.text ?? item.length) || ""}</span
		>
	{/if}
</article>

<style
	src="./index.scss"
	lang="scss"
></style>
