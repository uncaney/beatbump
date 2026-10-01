<script lang="ts">
	import Button from "$components/Button/Button.svelte";
	import FollowButton from "$components/FollowButton/FollowButton.svelte";
	import { scrollObserver } from "$lib/actions/scrollObserver";
	import type { ArtistPage } from "$lib/parsers";
	import list from "$lib/stores/list";
	import type { Thumbnail } from "$lib/types";
	import { debounce } from "$lib/utils";
	import { hueFor, initials } from "$lib/utils/initials";
	import { isDesktopMQ, isMobileMQ, windowHeight } from "$stores/window";
	import { onMount } from "svelte";
	import { quadOut } from "svelte/easing";
	import { tweened } from "svelte/motion";
	import Description from "./Description";

	export let header: ArtistPage["header"];
	export let thumbnail: Thumbnail[] = [];
	export let description = "";
	/** Artist browse id: when set, the Follow button sits in the same row as Play Radio / Shuffle (audit v3 1.6). */
	export let artistId = "";
	let y = 1;
	let isExpanded = false;
	let timestamp = 0;

	let willChange = false;
	const setWillChange = debounce(() => {
		willChange = false;
	}, 1000);

	let opacity = 1;
	let img: HTMLImageElement;

	// Audit v7 TOP 7: a local artist without cover art came with
	// `/cover?lid=` (empty lid) in both thumbnail sizes, so the hero <img>
	// painted its alt text over the nav and left a 280 px empty band. No
	// usable url, an empty-lid url, or a load error -> no <picture> at all:
	// an initials badge on the name's hue (utils/initials, same as the
	// album tiles) and a compact header instead.
	let imgBroken = false;
	$: heroUrl = String(thumbnail?.[1]?.url ?? thumbnail?.[0]?.url ?? "");
	$: heroUsable = heroUrl !== "" && !/[?&]lid=$/.test(heroUrl);
	$: if (heroUrl) imgBroken = false;
	$: hasHero = heroUsable && !imgBroken;
	$: nameInitials = initials(header?.name);
	$: nameHue = hueFor(header?.name);
	// Local artists (la-…) have no YouTube radio / shuffle endpoint and
	// nothing to follow: those buttons are hidden with a one-line reason;
	// playback goes through the Play all bar below (data-testid=play-all-bar).
	$: isLocalArtist = /^la-/.test(artistId);

	let calc: number;
	const scale = tweened(1, { duration: 300, easing: quadOut });

	onMount(() => {
		if (img) {
			img.decode().then(() => {
				opacity = 1;
			}).catch(() => {
				// broken/empty artist image → keep it visible, don't throw EncodingError
				opacity = 1;
			});
		}
		return () => {
			if (timestamp) cancelAnimationFrame(timestamp);
		};
	});
</script>

<div
	class="artist-header"
	style:will-change={willChange ? "top, transform" : null}
>
	<div
		use:scrollObserver={{
			target: "self",
			threshold: [...Array(25).keys()].map((i) => {
				return i / 25;
			}),
		}}
		on:scrolled={({ detail }) => {
			if (typeof detail.intersectionRatio === "number") {
				if (!willChange) willChange = true;
				y = (1.1 - detail.intersectionRatio) * 1000;
				calc = y / detail.intersectionRatio / $windowHeight || 0;

				scale.update(() =>
					$isMobileMQ
						? Math.min(7, Math.max(calc * 3, 1))
						: Math.min(6, Math.max(1, calc * 3)),
				);

				setWillChange();
			}
		}}
		class="artist-thumbnail"
		class:compact={!hasHero}
		style="{isExpanded
			? 'background-color: rgba(0, 0, 0, 0.4) !important'
			: ''};"
	>
		<div
			style={`background-image: linear-gradient(0deg, var(--base-bg), var(--base-bg) ${
				(-0.15 * $scale) / 0.5
			}%,
            var(--base-bg), var(--base-bg) ${
							$scale < 4 ? $scale * 1.5 : 7 - 0.5 * $scale
						}%, var(--base-bg-opacity-1_2) ${Math.min(
				18,
				Math.max(25, 5 * $scale),
			)}%, var(--base-bg-opacity-3_4) ${$scale * 45}%,
                            rgba(0, 0, 0, 0) 105%); --scale: ${$scale};
            `}
			id="gradient"
			class="gradient"
		/>
		{#if hasHero}
		<picture class="header-thumbnail">
			{#each thumbnail as img, i (img)}
				{#if i === 0}
					<source
						media="(max-width:{img.width}px)"
						srcset={img.url}
						type="image/jpeg"
					/>
					<source
						media={`(min-width:${img.width + 1}px) and (max-width:${
							thumbnail[i + 1]?.width
						}px)`}
						srcset={img.url}
						type="image/jpeg"
					/>
				{:else if i === thumbnail.length - 1}
					<!-- -->
				{:else}
					<source
						media={`(min-width:${img.width + 1}px) and (max-width:${
							thumbnail[i + 1]?.width
						}px)`}
						srcset={thumbnail[i + 1]?.url}
						type="image/jpeg"
					/>
				{/if}
			{/each}
			<!-- Decorative: the name is in .name below (alt="" so a slow or
			     failed load paints nothing over the nav). -->
			<img
				bind:this={img}
				class="header-thumbnail"
				style="opacity:{opacity};"
				loading="eager"
				src={heroUrl}
				id="artist_img"
				alt=""
				on:error={() => (imgBroken = true)}
			/>
		</picture>
		{/if}
		<div class="artist-content">
			<div
				class="content-wrapper"
				class:row={header?.foregroundThumbnails}
			>
				{#if !hasHero && !header?.foregroundThumbnails}
					<span
						class="initials-avatar"
						data-testid="artist-initials"
						aria-hidden="true"
						style="--cover-hue: {nameHue};">{nameInitials}</span
					>
				{/if}
				{#if header?.foregroundThumbnails}
					<picture>
						{#each header?.foregroundThumbnails as img, i (img)}
							{#if i === 0}
								<source
									media="(max-width:{img?.width}px)"
									srcset={img?.url}
									type="image/jpeg"
								/>
								<source
									media={`(min-width:${img?.width + 1}px) and (max-width:${
										header?.foregroundThumbnails[i + 1]?.width
									}px)`}
									srcset={img?.url}
									type="image/jpeg"
								/>
							{:else if i === header?.foregroundThumbnails.length - 1}
								<!---->
							{:else}
								<source
									media={`(min-width:${img?.width + 1}px) and (max-width:${
										header?.foregroundThumbnails[i + 1]?.width
									}px)`}
									srcset={header?.foregroundThumbnails[i + 1]?.url}
									type="image/jpeg"
								/>
							{/if}
						{/each}
						<img
							class="content-thumbnail"
							loading="eager"
							src={header?.foregroundThumbnails[1]?.url}
							alt="Artist Thumbnail"
						/>
					</picture>
				{/if}
				<div class="name">{header?.name}</div>
				{#if $isDesktopMQ && description}
					<Description
						{description}
						on:update={(e) => {
							isExpanded = e.detail;
						}}
					/>
				{/if}
				{#if isLocalArtist}
					<p
						class="local-note"
						data-testid="local-artist-note"
					>
						Artiste de ta bibliothèque : pas de radio ni de suivi, lecture
						avec « Lire tout » ci-dessous.
					</p>
				{:else}
				<div class="btn-wrpr">
					{#if header?.buttons?.radio !== null}
						<Button
							icon={{ name: "radio" }}
							on:click={() =>
								list.initAutoMixSession({
									config: { playerParams: header.buttons.radio?.params },
									playlistId: header.buttons.radio?.playlistId,
								})}><span class="button-text"> Play Radio</span></Button
						>
					{/if}
					{#if header?.buttons?.shuffle !== false}
						<Button
							class="outlined"
							icon={{ name: "shuffle" }}
							on:click={() =>
								list.initAutoMixSession({
									videoId: header.buttons.shuffle?.videoId,
									config: { playerParams: header.buttons.shuffle?.params },
									playlistId: header.buttons.shuffle?.playlistId,
								})}><span class="button-text"> Shuffle</span></Button
						>
					{/if}
					{#if artistId}
						<FollowButton
							{artistId}
							name={header?.name ?? ""}
							thumbnail={thumbnail?.[0]?.url ?? ""}
						/>
					{/if}
				</div>
				{/if}
			</div>
		</div>
	</div>
</div>

<!--  -->
<style lang="scss">
	@import "./index.scss";

	.hidden {
		display: none !important;
	}

	.modal {
		position: absolute;
		inset: 0% 0 0 0%;
		width: 80%;
		align-self: center;
		max-height: 100%;
		overflow-y: scroll;
		margin: auto;
		padding: 1rem;
		z-index: 5;
		height: 80%;
		border-radius: var(--md-radius);
		background: var(--color-med);
	}

	.modal-wrapper {
		position: fixed;
		inset: 0% 0 0 0%;
		width: 100%;
		height: 100%;
		z-index: 5;

		&::before {
			background: rgb(0 0 0 / 43.8%);
			position: absolute;
			z-index: -1;
			inset: 0;
			content: "";
			width: 100%;
			height: 100%;
			backdrop-filter: blur(0.05rem);
		}
	}

	.row {
		flex-direction: row !important;
		align-items: center !important;
		gap: 1.2rem;
	}

	.artist-header {
		display: block;
		position: relative;
		inset: 0;
	}

	.artist-thumbnail {
		display: block;
		position: relative;
		bottom: 0;
		left: 0;
		right: 0;
		padding-top: 45vh;
		// Phones: hero capped at ~32vh in total (20vh image band + name/buttons
		// block), was 45vh + content (audit 1.5).
		@media only screen and (max-width: 719px) {
			padding-top: 20vh;
		}
		@media only screen and (min-width: 1024px) {
			padding-top: 33vh;
		}

		@media only screen and (min-width: 1400px) {
			padding-top: 30vh;
		}
		transition: background-color 0.8s cubic-bezier(0.19, 0, 0.7, 1);
		background-color: rgb(0 0 0 / 10%);
		max-width: 100%;

		&::before {
			position: absolute;
			content: "";
			inset: 0;
		}
		// Audit v7 TOP 7: no hero image -> no image band; the initials badge
		// and the name make the header (name at y < 200 on phones).
		// Audit v8 TOP 4: the hero variant passes under the fixed nav with its
		// 20vh/33vh band; the compact one must clear it explicitly.
		&.compact {
			padding-top: calc(var(--top-bar-height, 56px) + 0.75rem);
		}
	}

	.initials-avatar {
		display: grid;
		place-items: center;
		width: 6rem;
		height: 6rem;
		margin-bottom: 0.75rem;
		border-radius: 50%;
		background: hsl(var(--cover-hue, 220) 32% 30%);
		color: hsl(var(--cover-hue, 220) 55% 88%);
		font-family: "Commissioner Variable", sans-serif;
		font-weight: 700;
		font-size: 2.25rem;
		line-height: 1;
		letter-spacing: 0.04em;
		user-select: none;
		@media only screen and (max-width: 719px) {
			width: 5rem;
			height: 5rem;
			font-size: 1.85rem;
		}
	}

	.local-note {
		margin: 0;
		font-size: max(0.8125rem, 12px);
		line-height: 1.35;
		color: hsla(0, 0%, 100%, 0.7);
		max-width: 48ch;
	}

	.gradient {
		z-index: 0;
		width: 100%;
		position: absolute;
		inset: 0;
		transform-origin: bottom;
		transform: scaleY(var(--scale));
		margin-bottom: -0.2em;
		&::before {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			z-index: -5;
			content: "";
		}
	}

	.header-thumbnail {
		z-index: -1;
		top: 0;
		width: 100%;
		height: 100%;
		max-height: 100%;
		object-fit: cover;
		position: absolute;
		transition: opacity 0.75s linear;
		overflow: hidden;
		border-radius: 0;
		object-position: top;
	}

	.artist-content {
		position: relative;
		z-index: 1;

		@include content-spacing($type: "padding");
		@include content-width();

		padding-bottom: 0 !important;
		margin: 0 auto;

		.content-wrapper {
			display: inline-flex;
			flex-flow: column wrap;
			align-items: flex-start;
			width: 80%;
			// Audit UX v4 TOP 4: at 80% of a 390px screen the three buttons did not fit
			// and Follow wrapped under Play Radio / Shuffle.
			@media only screen and (max-width: 719px) {
				width: 100%;
			}

			.content-thumbnail {
				max-width: 6rem;
				max-height: 6rem;
			}

			// One flex-wrap row for Play Radio / Shuffle / Follow, all 40px high
			// (44px on phones) and starting at the same gutter (audit v3 1.6:
			// Follow used to sit on its own line, 28px left of the grid, 30px high).
			.btn-wrpr {
				display: flex;
				flex-flow: row wrap;
				align-items: center;
				gap: 0.5rem 0.75rem;
				width: 100%;
				// One row on phones (wrapping only below 360px); buttons may shrink.
				@media only screen and (min-width: 360px) and (max-width: 719px) {
					flex-wrap: nowrap;
					gap: 0.5rem;
					> :global(*) {
						min-width: 0;
						flex: 0 1 auto;
					}
				}

				:global(.button),
				:global(.follow-btn) {
					box-sizing: border-box;
					min-height: 40px;
					margin: 0;
					// Phones: 44px floor (audit v5 TOP 5: 36px was below the touch
					// minimum); max() keeps any larger rem-based size.
					@media only screen and (max-width: 719px) {
						min-height: max(2.75rem, 44px);
					}
				}
			}

			.name {
				font-weight: 700;
				font-size: 2.5rem;
				font-family: "Commissioner Variable", sans-serif;
				text-shadow: rgb(0 0 0 / 17.1%) 0.2rem -0.12rem 0.5rem;
				letter-spacing: -0.02em;
				padding-bottom: 1rem;
				// Audit v7 item 10: long names clamp to two lines with an
				// ellipsis instead of pushing the buttons off-screen.
				display: -webkit-box;
				-webkit-box-orient: vertical;
				-webkit-line-clamp: 2;
				overflow: hidden;
				max-width: 100%;
				overflow-wrap: anywhere;

				@media screen and (min-width: 642px) and (max-width: 839px) {
					font-size: 2rem;
				}

				@media screen and (min-width: 840px) and (max-width: 960px) {
					font-size: 3.5rem;
					inline-size: 100%;
					overflow-wrap: break-word;
				}

				@media screen and (min-width: 961px) {
					font-size: 4.5rem;
				}
			}
		}

		max-width: $content-width-mobile;

		@media only screen and (min-width: 1080px) and (max-width: 1366px) {
			max-width: $content-width-md;
		}

		@media only screen and (min-width: 1367px) and (max-width: 1600px) {
			max-width: $content-width-lg;
		}

		@media only screen and (min-width: 1601px) {
			max-width: $content-width-xl;
		}
	}
</style>
