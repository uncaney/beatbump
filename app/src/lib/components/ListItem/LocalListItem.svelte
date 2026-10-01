<svelte:options
	immutable={true}
	accessors={true}
/>

<script lang="ts">
	import { groupSession, isPagePlaying } from "$lib/stores";
	import { page as SPage } from "$app/stores";
	import type { Item } from "$lib/types";
	import { notify } from "$lib/utils";
	import { coverLabel, hueFor, initials } from "$lib/utils/initials";

	import { createEventDispatcher, tick } from "svelte";
	import Icon from "../Icon/Icon.svelte";
	import { fullscreenStore } from "../Player/channel";
	import PopperButton from "../Popper/PopperButton.svelte";
	import { goto } from "$app/navigation";
	import { resolveArtistId } from "$lib/local";
	import { saveFavourite } from "$lib/favourites";
	import SessionListService, { queuePosition, queue } from "$lib/stores/list";
	import { AudioPlayer, updateGroupPosition } from "$lib/player";
	import { CTX_ListItem } from "$lib/contexts";
	import { SITE_ORIGIN_URL } from "$lib/stores/url";
	import { deleteSongFromPlaylist } from "$lib/workers/db/db";
	import { UNAVAILABLE_OFFLINE_MSG, cachedIds, networkOffline } from "$lib/offline";
	import { rowOfflineState } from "$lib/offlineBatch";
	export let item: Item;
	export let idx: number;
	export let ctx: Record<string, unknown> = {};

	let parent: HTMLElement;
	// V1: badge when cached, muted + toast when offline and not cached.
	$: offlineState = rowOfflineState(item?.videoId, $cachedIds, $networkOffline);

	const dispatch = createEventDispatcher<{
		setPageIsPlaying: { id: string };
		initLocalPlaylist: { idx: number };
		hovering: { idx: number };
		notHovering: null;
		change: undefined;
	}>();
	const { page, parentPlaylistId = null } = CTX_ListItem.get();

	$: isPlaying =
		(page !== "queue" && page !== "release"
			? $isPagePlaying.has($SPage.params.slug)
			: true) &&
		$SessionListService.mix.length > 0 &&
		$SessionListService.position === idx &&
		$SessionListService.mix[idx]?.videoId === item.videoId;

	let isHovering = false;
	let width = 640;

	// Cover placeholder (initials on a deterministic hue) once the <img> errors.
	let imgBroken = false;
	$: coverName = coverLabel(item);
	$: coverInitials = initials(coverName);
	$: coverHue = hueFor(coverName);
	let DropdownItems = [
		{
			text: "View Artist",
			icon: "artist",
			action: async () => {
				const __aid = await resolveArtistId(item);
				if (__aid) goto(`/artist/${__aid}`);
				await tick();
				window.scrollTo({
					behavior: "smooth",
					top: 0,
					left: 0,
				});
			},
		},
		{
			text: "Remove from Playlist",
			icon: "x",
			action: async () => {
				await deleteSongFromPlaylist(parentPlaylistId, item.videoId);
				// console.log(promise, item, parentPlaylistId);
				dispatch("change");
			},
		},
		{
			text: "Favorite",
			icon: "heart",
			action: () => {
				saveFavourite(item);
			},
		},
		{
			text: "Share",
			icon: "share",
			action: async () => {
				let shareData = {
					title: item.title,

					url: `${$SITE_ORIGIN_URL}/listen?id=${item.videoId}`,
				};
				if (item.endpoint?.pageType?.includes("MUSIC_PAGE_TYPE_PLAYLIST")) {
					shareData = {
						title: item.title,

						url: `${$SITE_ORIGIN_URL}/playlist/${item.endpoint?.browseId}`,
					};
				}
				if (item.endpoint?.pageType?.includes("MUSIC_PAGE_TYPE_ALBUM")) {
					shareData = {
						title: item.title,

						url: `${$SITE_ORIGIN_URL}/release?id=${item.endpoint?.browseId}`,
					};
				}
				if (item.endpoint?.pageType?.includes("MUSIC_PAGE_TYPE_ARTIST")) {
					shareData = {
						title: item.title,
						text: `${item.title} on Beatbump`,
						url: `${$SITE_ORIGIN_URL}/artist/${item.endpoint?.browseId}`,
					};
				}
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
			},
		},
	];
	async function handleClick(event: MouseEvent) {
		const target = event.target as HTMLElement;
		// The subtitle link's text is a span inside the <a>: look up, not at the target.
		if (target && (target.nodeName === "A" || target.closest?.("a"))) return;
		if (offlineState === "unavailable") {
			notify(UNAVAILABLE_OFFLINE_MSG, "error");
			return;
		}
		if (page === "queue") {
			if (groupSession.initialized && groupSession.hasActiveSession) {
				if (idx === 0) {
					updateGroupPosition(undefined, idx === 0 ? 1 : idx);
					SessionListService.updatePosition(1);
					return AudioPlayer.previous(false);
				}
				if (idx === $queue.length - 1) {
					const pos = SessionListService.updatePosition(
						idx === 0 ? 0 : idx - 1,
					);
					// updateGroupPosition("<-", pos);
					SessionListService.next(true, true);
					await tick();
					return;
				}
				SessionListService.updatePosition(idx === 0 ? 0 : idx - 1);
				updateGroupPosition(undefined, idx === 0 ? 0 : idx - 1);
				await tick();
				SessionListService.next(true, true);
			} else {
				if (idx === 0) {
					SessionListService.updatePosition(1);
					await tick();
					return AudioPlayer.previous(false);
				}
				SessionListService.updatePosition(idx - 1);
				await tick();

				SessionListService.next(true, false);
			}
		} else if (page === "playlist") {
			SessionListService.updatePosition(idx);
			await SessionListService.initPlaylistSession({
				playlistId: item.playlistId,
				index: idx,
			});
		} else if (page === "library") {
			SessionListService.updatePosition(idx);
			dispatch("initLocalPlaylist", { idx });
		} else {
			await SessionListService.initAutoMixSession({
				loggingContext: item?.loggingContext,
				videoId: item.videoId,
				playlistId: parentPlaylistId,
				keyId: page === "artist" ? 0 : idx,
				config: {
					playerParams: item?.playerParams,
					type: item?.musicVideoType,
				},
			});
		}
		dispatch("setPageIsPlaying", { id: parentPlaylistId });
	}
</script>

<svelte:window bind:innerWidth={width} />
<!-- V1: aria-disabled marks a row that cannot play offline (harness offline_badges). -->
<!-- svelte-ignore a11y-role-supports-aria-props -->
<article
	bind:this={parent}
	class="m-item"
	tabindex="0"
	class:offline-unavailable={offlineState === "unavailable"}
	data-offline={offlineState || undefined}
	aria-disabled={offlineState === "unavailable" ? "true" : undefined}
	class:isPlaying={isPagePlaying.has($SPage.params.slug) &&
		$queue?.length > 0 &&
		$queuePosition === idx}
	on:click={handleClick}
	on:pointerenter={(e) => {
		isHovering = true;
	}}
	on:pointerleave={() => {
		isHovering = false;
	}}
	on:pointerenter={(e) => {
		if (parent && parent.contains(e.currentTarget)) isHovering = true;
	}}
	draggable={true}
	on:dragstart
	on:drop|preventDefault
	on:dragover|preventDefault={() => {}}
	on:dragenter={() => dispatch("hovering", { idx })}
	on:dragend={() => dispatch("notHovering", null)}
	on:mouseenter|capture={(e) => {
		if (parent && parent.contains(e.currentTarget)) isHovering = true;
	}}
	on:pointerleave={(e) => {
		if (parent && parent.contains(e.currentTarget)) {
			isHovering = true;
		}
		isHovering = false;
	}}
>
	<div class="index">
		<span class:hidden={isPlaying !== true && isHovering !== true}>
			<!--#9990a0-->
			<Icon
				name="play"
				color="inherit"
				size="1.5em"
			/>
		</span>
		<span class:hidden={isPlaying !== false || isHovering !== false}>
			{idx + 1}
		</span>
	</div>
	<div class="metadata">
		{#if Array.isArray(item?.thumbnails) && item.thumbnails.length !== 0}
			<div class="thumbnail">
				<img
					loading="lazy"
					src={item.thumbnails?.[0]?.url}
					width={item.thumbnails?.[0]?.width}
					height={item.thumbnails?.[0]?.height}
					alt="thumbnail"
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
					><svg
						viewBox="0 0 24 24"
						width="14"
						height="14"
						aria-hidden="true"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 7v9M8 12l4 4 4-4" /></svg
					></span
				>
				{/if}
				{#if item?.explicit}
					<span class="explicit">
						{item.explicit ? "E" : ""}
					</span>
				{/if}
			</span>
			<div class="artists secondary">
				{#if Array.isArray(item.subtitle)}
					{#each item.subtitle as subtitle}
						{#if subtitle?.browseId}
							<!-- Hit area = the text span only (see .artists > a in index.scss):
							     a tap on the wrapped subtitle line plays the row. -->
							<a
								class="artist secondary"
								href={`/artist/${subtitle.browseId}`}
								on:click|preventDefault|stopPropagation={() => {
									goto(`/artist/${subtitle.browseId}`);
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
	{#if isHovering || width < 640}
		<div
			class="length"
			tabindex="0"
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
>
</style>
