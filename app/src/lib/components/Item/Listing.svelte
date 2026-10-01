<script
	context="module"
	lang="ts"
>
	const RE_THUMBNAIL_DIM = /=w\d+-h\d+-/gm;

	const isChannelOrArtist = (item: Item) => {
		if (item?.subtitle) {
			return (
				!!(item.endpoint && item.endpoint?.pageType?.includes("ARTIST")) ||
                !!(item.endpoint && item.endpoint?.pageType?.includes("ALBUM")) ||
				!!item.endpoint?.pageType?.includes("USER_CHANNEL")
			);
		}
		return false;
	};

	// Thumbnail shape is keyed on the ITEM type, not the page: only artists and
	// channels get the round thumbnail; albums, singles and playlists stay square
	// (audit 1.3: the circle codes "artist" everywhere else in the app).
	const hasRoundThumbnail = (item: Item) => {
		const pt = item?.endpoint?.pageType ?? "";
		if (/ALBUM|SINGLE|PLAYLIST|EP/.test(pt)) return false;
		if (/ARTIST|USER_CHANNEL/.test(pt)) return true;
		return item?.type === "artist" || item?.type === "artists";
	};
</script>

<script lang="ts">
	import Loading from "$components/Loading/Loading.svelte";
	import { createEventDispatcher, hasContext, tick } from "svelte";

	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	import { resolveArtistId, entityHref } from "$lib/local";
	import { saveFavourite, removeFavourite } from "$lib/favourites";
	import { downloadToDevice } from "$lib/offline";
	import Icon from "$components/Icon/Icon.svelte";
	import { mobileLongPress } from "$lib/actions/longtouch";
	import type { Dropdown } from "$lib/configs/dropdowns.config";
	import { groupSession } from "$lib/stores";
	import list from "$lib/stores/list";
	import { addToQueueEnd, playNext } from "$lib/queueActions";
	import type { Item } from "$lib/types";
	import { IsoBase64, Logger, filter, notify } from "$lib/utils";
	import { coverLabel, hueFor, initials } from "$lib/utils/initials";
	import {
		showAddToPlaylistPopper,
		showGroupSessionCreator,
	} from "$stores/stores";
	import { SITE_ORIGIN_URL } from "$stores/url";
	import { PopperButton, PopperStore } from "../Popper";
	import { APIClient } from "$lib/api";
	import { showDownloadSongPopper } from "$lib/stores";

	export let data: Item;
	// Row index in a long list (_Browse passes it): the first 12 covers load
	// eagerly with a high fetch priority, the rest lazily (audit v4 TOP 6: the
	// first rows of /library/albums on mobile rendered with naturalWidth 0).
	export let index: number | undefined = undefined;

	const dispatch = createEventDispatcher();

	let isLibrary = hasContext("library") ? true : false;
	let videoId = "";
	let playlistId = "";
	let isArtist = isChannelOrArtist(data);
	let roundThumbnail = hasRoundThumbnail(data);

	let srcImg =
		Array.isArray(data?.thumbnails) && data?.thumbnails[0]
			? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			  data.thumbnails[0]!
			: { width: 0, height: 0, url: "", placeholder: "" };

	let loading = false;

	let DropdownItems: Dropdown = [
		{
			text: "View Artist",
			icon: "artist",
			action: async () => {
				window.scrollTo({ behavior: "smooth", top: 0, left: 0 });
				await tick();
				const __aid = await resolveArtistId(data);
				if (__aid) goto(`/artist/${__aid}`);
			},
		},
		{
			text: "Go to Album",
			icon: "album",
			action: () => {
				window.scrollTo({
					behavior: "smooth",
					top: 0,
					left: 0,
				});
				goto(`/release?id=${data?.album?.browseId}`);
			},
		},
		{
			text: "Lire ensuite",
			icon: "play-circle",
			action: () => playNext(data),
		},
		{
			text: "Ajouter à la file",
			icon: "queue",
			action: () => addToQueueEnd(data),
		},

		{
			text: "Add to Playlist",
			icon: "list-plus",
			action: async () => {
				if (data?.endpoint?.pageType.match(/PLAYLIST|ALBUM|SINGLE/)) {
					// console.log('PLAYLIST')
					const response = await APIClient.fetch(
            `/api/v1/get_queue.json?playlistId=`+ data?.playlistId,
					);
					const _data = await response.json();
					const items: Item[] = _data;
					showAddToPlaylistPopper.set({ state: true, item: [...items] });
				} else {
					showAddToPlaylistPopper.set({ state: true, item: data });
				}
			},
		},
		{
			text: !isLibrary ? "Favorite" : "Remove From Favorites",
			icon: !isLibrary ? "heart" : "x",
			action: async () => {
				if (!browser) return;
				if (!isLibrary) {
					saveFavourite(data);
				}
				if (isLibrary) {
					await removeFavourite(data);
					dispatch("update");
				}
			},
		},
		{
			text: "Download to device",
			icon: "download",
			action: async () => {
				if (!browser) return;
				const r = await downloadToDevice(data);
				notify(r.ok ? "Downloading…" : (r.reason || "Download failed"), r.ok ? "success" : "error");
			},
		},
		!groupSession.hasActiveSession
			? {
					text: "Start Group Session",
					icon: "users",
					action: async () => {
						if (!browser) return;
						showGroupSessionCreator.set(true);
					},
			  }
			: {
					text: "Invite Group Session",
					icon: "send",
					action: async () => {
						if (!browser) return;
						const shareData = {
							title: `Join ${groupSession.client.displayName}'s Group Session on Beatbump!`,

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
					},
			  },
		{
			text: "Share",
			icon: "share",
			action: async () => {
				const shareData = {
					title: data.title,

					url: `${$SITE_ORIGIN_URL}/listen?id=${data.videoId}`,
				};
				try {
					if (!navigator.canShare) {
						await navigator.clipboard.writeText(shareData.url);
						notify("Link copied successfully", "success");
					} else {
						await navigator.share(shareData);
						notify("Shared successfully", "success");
					}
				} catch (error) {
					notify("Error: " + error, "error");
				}
			},
		},
	];
	if (isArtist) {
		DropdownItems = DropdownItems.filter(
			(item) => !item.text?.includes("Add to Playlist"),
		);
	}
	if (data.type?.includes("playlist")) {
		DropdownItems.splice(1, 1, {
			text: "View Playlist",
			icon: "list",
			action: () => {
				window.scrollTo({
					behavior: "smooth",
					top: 0,
					left: 0,
				});
				goto(`/playlist/${data?.endpoint?.browseId}`);
			},
		});
		DropdownItems.shift();
		DropdownItems.pop();
		DropdownItems = DropdownItems.filter(
			(item) => !item.text.includes("Favorite"),
		);
	}
	if (data.type === "videos") {
		DropdownItems = DropdownItems.filter((d) => {
			if (d.text === "View Artist") return;
		});
	}

	if (data?.album?.browseId === undefined) {
		DropdownItems = filter(DropdownItems, (d) => d.text !== "Go to Album");
	}
	if (isArtist) {
		DropdownItems = filter(DropdownItems, (d) => d.text !== "View Artist");
	}
	const clickHandler = async (event: { target: { nodeName: string } }) => {
		if (
			(event.target instanceof HTMLElement && event.target.nodeName === "A") ||
			loading
		)
			return;
		// console.log(event.target)
		if (isArtist) {
			// entityHref routes by the item's OWN endpoint id (album→/release?id=lb-,
			// artist→/artist/la-); never sends an artist id to /release.
			goto(entityHref(data.endpoint?.browseId, data.endpoint?.pageType));
			return;
		}

		if (data.endpoint?.pageType.includes("PLAYLIST") ) {
			goto(`/playlist/${data?.endpoint?.browseId}`);
			return;
		}
		try {
			loading = true;
			videoId = data.videoId ? data.videoId : "";
			playlistId = data?.playlistId ? data?.playlistId : "";
			if (data.type?.includes("playlist") || data?.type === "albums") {
				// notify(JSON.stringify({ type: data.type }), "success");
				await list.initPlaylistSession({
					playlistId,
					index: 0,
					clickTrackingParams: data.clickTrackingParams ?? undefined,
					params: data.params,
				});
			} else {
				// notify(JSON.stringify({ type: data.type }), "success");
				await list.initAutoMixSession({
                    clickedItem: data,
					loggingContext: data?.loggingContext,
					videoId: videoId,
					playlistId: playlistId,
					keyId: 0,
					clickTracking: data.params,
					config: {
						playerParams: data.playerParams,
						type: data.musicVideoType,
					},
				});
			}
			loading = false;
			return;
		} catch (error) {
			Logger.err(error);
			return;
		}
	};

	$: srcImg.url =
		srcImg.width < 240
			? ((srcImg.width = 240),
			  (srcImg.height = 240),
			  srcImg.url.replace(RE_THUMBNAIL_DIM, "=w240-h240-"))
			: srcImg.url;

	let pressing = false;

	// Cover placeholder (initials on a deterministic hue) once the <img> errors;
	// the tile overlays the 5rem box, so the row does not move.
	let imgBroken = false;
	$: eager = index !== undefined && index < 12;
	let imgLoading: "eager" | "lazy" | undefined;
	$: imgLoading = index === undefined ? undefined : eager ? "eager" : "lazy";
	$: coverName = coverLabel(data);
	$: coverInitials = initials(coverName);
	$: coverHue = hueFor(coverName);

	// Accessible name of the thumbnail (the permanent play badge is a CSS
	// ::after on .img-container, see global/redesign/modules/_item.scss; the
	// row's click is the real action). Audit v3 1.7 / TOP 10 #8.
	$: isPlaylistRow = !!data?.endpoint?.pageType?.includes("PLAYLIST") || !!data?.type?.includes("playlist");
	$: thumbLabel = isArtist
		? `Ouvrir ${data?.title ?? ""}`
		: isPlaylistRow
		? `Ouvrir la playlist ${data?.title ?? ""}`
		: `Lire ${data?.title ?? ""}`;
	const thumbKeydown = (e: KeyboardEvent) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		e.stopPropagation();
		void clickHandler(e as unknown as { target: { nodeName: string } });
	};
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
	class="container"
	class:pressing
	on:contextmenu|preventDefault={(e) => {
		window.dispatchEvent(
			new window.CustomEvent("contextmenu", { detail: "listing" }),
		);

		PopperStore.set({
			items: DropdownItems.slice(),
			x: e.pageX,
			y: e.pageY,
			direction: "right",
		});
	}}
>
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<div
		class="innercard"
		on:click|stopPropagation={clickHandler}
	>
		<div
			class="itemWrapper"
			use:mobileLongPress={{ delay: 500, duration: 720 }}
			on:touchstart={() => {
				pressing = true;
			}}
			on:touchend={() => {
				pressing = false;
			}}
			on:touchcancel={() => {
				pressing = false;
			}}
			on:pressEnd={(e) => {
				e.currentTarget?.dispatchEvent(new TouchEvent("touchcancel"));
				pressing = false;
				// setTimeout(() => {
				// 	pressing = false;
				// 	// e.currentTarget?.querySelector(".dd-button")?.click?.();
				// }, 1200);
			}}
		>
			<div
				class="img-container"
				class:artist-img={roundThumbnail}
				role="button"
				tabindex="0"
				aria-label={thumbLabel}
				on:keydown={thumbKeydown}
			>
				{#if loading}
					<Loading size="3em" />
				{/if}
				<div class="thumbnail">
					<img
						alt=""
						width={srcImg.width}
						height={srcImg.height}
						src={srcImg.url}
						loading={imgLoading}
						fetchpriority={eager ? "high" : undefined}
						on:error={() => (imgBroken = true)}
					/>
					{#if (imgBroken || !srcImg.url) && coverInitials}
						<span
							class="cover-initials"
							aria-hidden="true"
							style="--cover-hue: {coverHue};">{coverInitials}</span
						>
					{/if}
				</div>
			</div>
			<div class="title">
				<p class="text-title">
					<span>{data.title}</span>
					{#if data.explicit}
						<Icon
							name="explicit"
							fill="hsla(0, 0%, 95%, 0.7)"
							size="12px"
						>
							<span class="sr-only">Explicit</span>
						</Icon>
					{/if}
				</p>
				{#if isArtist}
					<p class="artist-stats">
						{#each data.subtitle as subtitle}
							{subtitle.text}
						{/each}
					</p>
				{:else if data.type === "playlist"}
					<p class="text-artist">
						{data.type === "playlist" && "metaData" in data
							? `${data.metaData}`
							: ""}
					</p>
				{:else}
					<p class="text-artist secondary">
						{#if data.subtitle}
							{#each data?.subtitle as artist}
								{#if !artist.pageType}
									{artist.text}
								{:else if artist.pageType.includes("ALBUM")}
									<!-- The link's hit area is its text only (see .sub-link): on a
									     390px row the subtitle wraps and a tap aimed at the row must
									     play it, not open the album / artist page. -->
									<a
										class="sub-link"
										on:click|preventDefault|stopPropagation={() =>
											goto(`/release?id=${artist?.browseId}`)}
										href={`/release?id=${artist?.browseId}`}
										><span>{artist.text}</span></a
									>
								{:else}
									<a
										class="sub-link"
										on:click|preventDefault|stopPropagation={() =>
											goto(`/artist/${artist?.browseId}`)}
										href={`/artist/${artist?.browseId}`}
										><span>{artist.text}</span></a
									>
								{/if}
							{/each}
						{/if}
					</p>
				{/if}
			</div>
		</div>

		<div
			class="menu"
			role="group"
			aria-label="Plus d'options"
			title="Plus d'options"
		>
			<PopperButton
				metadata={{
					artist: data.type !== "playlist" &&
						Array.isArray(data?.subtitle) && [
							data.subtitle.find((s) => s?.pageType?.includes("ARTIST")) ??
								data.artistInfo?.artist[0],
						],
					thumbnail: data.thumbnails,
					title: data.title,
					length:
						data.type !== "artist" && data.type !== "playlist"
							? data?.length?.text
							: "",
				}}
				type="search"
				size="1.5em"
				items={DropdownItems}
			/>
		</div>
	</div>
</div>

<style lang="scss">
	@use "../../../global/stylesheet/base/mixins";

	.menu {
		padding-right: 0em;
		// Desktop: the kebab sat a few px above the row centre (audit v3 3.2).
		// Centre it on the grid row and keep the 44px hit box around the icon.
		align-self: center;
		display: grid;
		place-items: center;
		min-width: 44px;
		min-height: 44px;
	}

	.hidden {
		display: none !important;
		visibility: hidden !important;
	}

	.album,
	.artist-stats {
		font-size: 0.9em;
		font-weight: 400;
		align-items: center;

		/* white-space: revert; */
		display: inline-flex;
		pointer-events: auto;

		a {
			margin-left: 0.25em;
		}
	}

	.itemWrapper {
		display: flex;
		width: 100%;
		margin: 0;
		padding: 0.3em 0.3em 0.3em 0.6em;
		flex-flow: row nowrap;
		overflow: hidden;
		align-items: center;
	}

	p {
		margin: 0.2rem 0;
	}

	.container:not(.menu) {
		cursor: pointer;
		display: flex;
		flex: 1 1 auto;
		width: 100%;
		flex-flow: row nowrap;

		transition: cubic-bezier(0.755, 0.05, 0.855, 0.06) background 0.4s;
		transition-delay: 100ms;
		background: #0000;
		max-width: unset !important;
		contain: paint;
		&.pressing {
			transition-duration: 200ms;
			transition-delay: 0ms;
			transition-timing-function: cubic-bezier(0.86, 0, 0.07, 1);

			background: lighten(#3c3d4159, 3%);
		}
		@media screen and (hover: hover) {
			transition: cubic-bezier(0.25, 0.46, 0.45, 0.94) background 0.1s;

			&:hover {
				transition: cubic-bezier(0.25, 0.46, 0.45, 0.94) background 0.2s;
				transition-delay: 0ms;

				background: lighten(#3c3d4159, 3%);
			}
		}
		&:not(.pressing):active {
			transition: cubic-bezier(0.215, 0.61, 0.355, 1) background 0.2s;

			background: lighten(#3c3d4159, 3%);
			// filter: brightness(0.7);filter
			transition-delay: 0ms;
		}
	}

	.text-artist {
		font-size: 0.925em;
		margin-top: 0;

		@include mixins.trim(2);

		// Subtitle links (artist / album) stay inline text: no padding, no flex
		// growth, and the anchor box itself is transparent to taps; only the
		// text span catches them. The rest of the (wrapped) subtitle line falls
		// through to .innercard, which plays the row. Pure hit-testing: no
		// layout change on desktop.
		.sub-link {
			display: inline;
			padding: 0;
			margin: 0;
			pointer-events: none;

			> span {
				pointer-events: auto;
			}
		}
	}

	.text-title {
		align-self: flex-start;
		display: block;
		font-size: 1em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		width: 100%;
		> span {
			margin-right: 3px;
		}

		&:hover {
			text-decoration: underline solid currentcolor 0.0714rem;
			cursor: pointer;
		}
	}

	img {
		position: relative;
		width: auto;
		height: auto;
		image-rendering: auto;
		object-fit: contain;
		image-rendering: crisp-edges;
		image-rendering: -webkit-optimize-contrast;
	}

	img::before {
		display: block;
		content: "";
		padding-top: calc(100% * 2 / 3);
	}

	.innercard {
		align-items: center;
		display: grid;

		/* flex-direction: row; */
		grid-template-columns: 18fr 1fr;
		overflow: hidden;
		padding: 0.4rem 0;
		position: relative;
		text-overflow: ellipsis;
		width: 100%;
		// max-width: calc(100% - 4.45em);max-width
		@media screen and (min-width: 640px) {
			padding: 0.2rem 0;
		}
	}

	.title {
		// display: inline-flex;display
		// width: 100%;width    align-self: center;
		flex-direction: column;
		font-size: 100%;
		margin-left: 1rem;
		max-width: calc(87% - 4.6em);
		overflow: hidden;
		text-overflow: ellipsis;
		width: 100%;
		white-space: nowrap;
		line-height: 1.3;

		// line-height: 2;line-height
		display: inherit;
	}

	.img-container {
		position: relative;
		display: block;
		width: 100%;
		max-width: 5rem;
		min-width: 5rem;
		height: 5rem;
		border-radius: $xs-radius;
		&::before {
			display: block;
			position: absolute;
			inset: 0;
			content: "";

			background-image: linear-gradient(
				to bottom,
				hsla(0, 0%, 0%, 0.82) 0%,
				hsla(0, 0%, 0%, 0.754) 7.9%,
				hsla(0, 0%, 0%, 0.684) 14.2%,
				hsla(0, 0%, 0%, 0.612) 19.2%,
				hsla(0, 0%, 0%, 0.539) 23.3%,
				hsla(0, 0%, 0%, 0.465) 26.8%,
				hsla(0, 0%, 0%, 0.393) 30%,
				hsla(0, 0%, 0%, 0.324) 33.3%,
				hsla(0, 0%, 0%, 0.258) 36.9%,
				hsla(0, 0%, 0%, 0.197) 41.2%,
				hsla(0, 0%, 0%, 0.142) 46.5%,
				hsla(0, 0%, 0%, 0.094) 53.2%,
				hsla(0, 0%, 0%, 0.055) 61.6%,
				hsla(0, 0%, 0%, 0.025) 71.9%,
				hsla(0, 0%, 0%, 0.006) 84.6%,
				hsla(0, 0%, 0%, 0) 100%
			);
			opacity: 0.1;
			z-index: 1;
			z-index: 10;
		}
		> .thumbnail {
			position: relative;
			width: 100%;
			height: 100%;
			background: rgb(13 13 15 / 19.2%);
			border-radius: inherit;

			// Shared look in global/redesign/modules/_item.scss; 5rem-box letters here.
			.cover-initials {
				font-size: 1.7em;
			}

			img {
				border-radius: inherit;
				width: 100%;
				height: 100%;
				object-fit: contain;
				image-rendering: crisp-edges;
			}
		}
	}

	// Keyboard focus on the labelled thumbnail button ("Lire {title}").
	.img-container:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 2px;
	}

	// Round thumbnail: artists and channels only (see hasRoundThumbnail). Albums,
	// singles and playlists keep the square $xs-radius of .img-container.
	.artist-img {
		border-radius: 99999em;
	}

	.album a {
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
		display: block;
		max-width: calc(100vw - 2ch) !important;
	}

	a {
		color: inherit;
	}

	@media (min-width: 640px) {
		.container:active:not(.menu) {
			background: lighten(#575a6359, 5%);
		}
	}
</style>
