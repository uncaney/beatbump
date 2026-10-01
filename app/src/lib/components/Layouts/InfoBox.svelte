<script
	context="module"
	lang="ts"
>
	// eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
	type AltSubtitle = {
		tracks: number;
		type: "playlist" | "single" | "album";
		year: number;
	};
</script>

<script
	lang="ts"
	generics="T extends (Subtitle | AltSubtitle)[]"
>
	import Icon from "$components/Icon/Icon.svelte";
	import type { Dropdown, Icons } from "$lib/configs/dropdowns.config";
	import { releasePageContext } from "$lib/contexts";
	import type { Subtitle } from "$lib/types";
	import { buildReleaseLine } from "$lib/utils/releaseMeta";
	import { windowWidth } from "$stores/window";
	import { createEventDispatcher } from "svelte";
	import Button from "../Button";
	import PopperButton from "../Popper/PopperButton.svelte";
	import { page } from "$app/stores";
	import { APIClient } from "$lib/api";
	import { playTracks } from "../PlayAllBar/PlayAllBar.svelte";
	import ShareLinkButton from "../ShareLinkButton/ShareLinkButton.svelte";

	type Button<
		Type extends string = string,
		T = Type extends "icon" | "outlined" | (undefined & infer T) ? T : unknown,
	> = {
		text?: string;
		type?: T;
		action?: () => void;
		style?: "normal" | "squared";
		icon?: Icons | { name: Icons; size?: string };
		/** UX7: accessible name of the release row button (its label is icon-only on phones). */
		label?: string;
	};

	/** Thumbnail to display*/
	export let thumbnail: string | undefined = undefined;
	/** Title of the playlist/album */
	export let title = "";
	/** Description for the playlist/album */
	export let description: string | undefined = undefined;
	/** Subtitles (year/track count/etc.) */
	// eslint-disable-next-line no-undef
	export let subtitles: T[] = [];
	/** Subtitles (year/track count/etc.) */
	export let secondSubtitle:
		| Subtitle[]
		| {
				tracks: number;
				type: "playlist" | "single" | "album";
				year: number;
		  }[] = [];
	/** Buttons (play album/shuffle/etc.)*/
	export let buttons: Button[] = [];
	/** An array of artist or channel objects */
	export let artist: {
		name: string;
		channelId: string;
	}[] = [];
	/** Allows user to change the metadata (local playlists only)*/
	export let editable = false;
	/** Type of metadata (Album / Playlist) */
	export let type = "playlist";

	let DropdownItems: Dropdown = [
		{
			text: "Ajouter à la file",
			icon: "queue",
			action: () => {
				dispatch("addqueue");
			},
		},
		{
			text: "Ajouter à une playlist",
			icon: "list-plus",
			action: () => {
				dispatch("playlistAdd");
			},
		},
		// @ts-expect-error it's fine
		releasePageContext.has("release")
			? {
					text: "Lecture aléatoire",
					action: () => {
						dispatch("shuffle");
					},
					icon: "shuffle",
			  }
			: undefined,
	];

	// Release header: every artist (the old `artist.slice(1, -2)` dropped a lone
	// artist), then "Album · 12 titres · 2013 · 1 h 14 min" (audit v6 TOP 9:
	// year whenever known, duration in French). The parser lives in
	// $lib/utils/releaseMeta (audit v7 TOP 4: the YouTube header arrives with
	// `year` and `length` swapped, so fields are read by shape, not by name).
	$: releaseArtists = (Array.isArray(artist) ? artist : []).filter(
		(a) => a && a.name,
	);
	$: releaseSub = (
		Array.isArray(subtitles) && subtitles[0] && typeof subtitles[0] === "object"
			? subtitles[0]
			: {}
	) as Record<string, unknown>;
	$: releaseExplicit = Boolean(releaseSub.contentRating || releaseSub.explicit);
	$: releaseLine = buildReleaseLine(releaseSub);

	const dispatch = createEventDispatcher<{
		shuffle: void;
		playlistAdd: void;
		addqueue: void;
	}>();

	// UX7: on a release page every action sits on ONE row (Tout lire /
	// Radio / Garder hors-ligne / Partager / ⋮): icon + short label on
	// desktop, icon-only with an aria-label on phones. `releaseId` feeds the
	// "Partager" button of YouTube and local albums alike.
	$: isRelease = type === "release";
	$: releaseId = isRelease ? ($page.url.searchParams.get("id") ?? "") : "";
	const iconName = (icon: Button["icon"]) => (typeof icon === "string" ? icon : icon?.name);

	// EQ1: "Radio" on a local album page (/release?id=lb-…) builds a targeted
	// queue from local/related?seed=album:<id>, context "Radio : <title>".
	$: localAlbumId =
		type === "release" && $page.url.searchParams.get("id")?.startsWith("lb-")
			? ($page.url.searchParams.get("id") as string)
			: "";
	let radioBusy = false;
	async function startRadio() {
		if (radioBusy || !localAlbumId) return;
		radioBusy = true;
		try {
			const res = await APIClient.fetch(
				`/api/v1/local/related?seed=album:${encodeURIComponent(localAlbumId)}`,
			);
			if (!res.ok) return;
			const data = await res.json();
			const items = Array.isArray(data.items) ? data.items : [];
			const name = typeof data.name === "string" && data.name ? data.name : title;
			await playTracks(items, {
				context: { kind: "radio", title: name, href: $page.url.pathname + $page.url.search },
			});
		} catch (err) {
			console.error("radio-seed: failed", err);
		} finally {
			radioBusy = false;
		}
	}
</script>

<div class="box resp-content-width">
	<div class="img">
		<img
			src={thumbnail}
			loading="lazy"
			width="512"
			height="512"
			style="

--img-height: 512;"
			alt="album"
		/>
	</div>
	<div class="metadata">
		<div class="info-title">
			<span class="box-title"
				>{title}
				{#if Array.isArray(subtitles) && typeof subtitles[0] === "object" && "contentRating" in subtitles[0] && subtitles[0]?.contentRating}
					<span class="explicit" />
				{/if}</span
			>
		</div>
		{#if description && type === "playlist"}
			{#key description}
				<p
					class="secondary subtitle description"
					class:hidden={$windowWidth < 640 ? true : false}
				>
					{description}
				</p>
				<span class="secondary subtitle-group">
					<p class="secondary subtitle">
						{Array.isArray(subtitles) && subtitles.length !== 0
							? subtitles.join(" ")
							: ""}
					</p>
					<em
						><small class="subtitle">
							{Array.isArray(secondSubtitle) && secondSubtitle.join(" ")}
						</small>
					</em>
				</span>
			{/key}
		{:else if type === "release"}
			<p class="secondary release-meta">
				{#each releaseArtists as a, index}
					{#if index !== 0}<span aria-hidden="true">, </span>{/if}
					{#if a.channelId}
						<a
							class="secondary artist-link"
							href={`/artist/${a.channelId}`}>{a.name}</a
						>
					{:else}
						<span>{a.name}</span>
					{/if}
				{/each}
				{#if releaseLine || releaseExplicit}
					{#if releaseArtists.length}<br />{/if}
					<small>
						{#if releaseExplicit}
							<Icon
								name="explicit"
								fill="hsla(0, 0%, 95%, 0.7)"
								color="transparent"
								--stroke="transparent"
								style="margin-right: 0.1em; stroke-width: 4;font-weight: 800;"
								size="1em"
							>
								<span class="sr-only">Explicit</span>
							</Icon>
						{/if}
						{releaseLine}
					</small>
				{/if}
			</p>
		{/if}
	</div>
	{#if isRelease}
		<div
			class="button-group release-actions"
			data-testid="release-actions"
		>
			<!-- U12-4: one order for YouTube and local albums: play, keep (slot),
			     radio (YouTube "album-radio" or local "radio-seed"), share, ⋮. -->
			{#each buttons as { type, icon, text, action, label }, i}
				{@const name = iconName(icon)}
				{#if i === 0 && type !== "icon"}
					<button
						type="button"
						class="ra-btn btn-primary"
						data-testid="release-play"
						aria-label={label ?? text}
						title={label ?? text}
						on:click={action}
					>
						{#if name}
							<Icon
								{name}
								size="1.1em"
							/>
						{/if}
						<span class="ra-lbl">{text}</span>
					</button>
				{/if}
			{/each}
			<slot name="actions" />
			{#each buttons as { type, icon, text, action, label }, i}
				{@const name = iconName(icon)}
				{#if i > 0 && type !== "icon"}
					<button
						type="button"
						class="ra-btn btn-secondary"
						data-testid="album-radio"
						aria-label={label ?? text}
						title={label ?? text}
						on:click={action}
					>
						{#if name}
							<Icon
								{name}
								size="1.1em"
							/>
						{/if}
						<span class="ra-lbl">{text}</span>
					</button>
				{/if}
			{/each}
			{#if localAlbumId}
				<button
					type="button"
					class="ra-btn btn-reset btn-secondary"
					data-testid="radio-seed"
					aria-label="Radio de l'album"
					title="Radio de l'album"
					disabled={radioBusy}
					on:click={startRadio}
				>
					<Icon
						name="radio"
						size="1.1em"
					/>
					<span class="ra-lbl">Radio</span>
				</button>
			{/if}
			{#if releaseId}
				<!-- c31b: "Partager" the album (/release?id=…), YouTube or local. -->
				<ShareLinkButton
					kind="album"
					id={releaseId}
					{title}
					artist={releaseArtists[0]?.name ?? ""}
					variant="secondary"
					responsive
				/>
			{/if}
			{#if buttons.some((b) => b.type === "icon")}
				<PopperButton items={DropdownItems} />
			{/if}
		</div>
	{:else}
	<div class="button-group">
		{#each buttons as { style, type, icon, text, action }, i}
			{#if type === "icon"}
				<PopperButton items={DropdownItems} />
			{:else}
				<Button
					on:click={action}
					class={`${style ?? ""} ${
						i === buttons.length - 1 || type === "outlined" ? "btn-reset" : ""
					}`.trim()}
					outlined={i === buttons.length - 1 || type === "outlined"}
					icon={typeof icon === "string"
						? { name: icon }
						: { name: icon?.name, size: icon?.size }}>{text}</Button
				>
			{/if}
		{/each}
	</div>
	{/if}
</div>

<style lang="scss">
	@import "../../shared/listPages.scss";

	p {
		margin-top: 0;
		margin-bottom: 0.3rem;
	}
	p.secondary {
		font-size: var(--text-secondary-size);
		letter-spacing: -0.01em;
		max-width: 40ch;
	}
	/* Audit v7 item 10: long album titles clamp to two lines with an
	   ellipsis (listPages.scss sets text-overflow on a block with no
	   overflow, so nothing was ever clipped). */
	.box-title {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		overflow: hidden;
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	/* Audit v6 TOP 9: below 513 px the title is centred (listPages.scss) but
	   the 40ch meta block started at the left edge, so artist + info line sat
	   41 px left of the title centre. Centre the block itself. */
	/* U12-11: listPages.scss sets `small` to 0.9em, which put the release line
	   ("Album · 13 titres · 2013 · 1 h 14 min") at 10.8 px on phones. */
	p.release-meta small {
		font-size: var(--text-secondary-size);
	}
	@media screen and (max-width: 512.98px) {
		p.release-meta {
			margin-inline: auto;
			text-align: center;
		}
	}
	/* Play Album / Album Radio were 32px tall from rem (audit v5 TOP 5):
	   40px on desktop, 44px floor on phones. */
	.button-group :global(.button) {
		box-sizing: border-box;
		min-height: 40px;
		@media only screen and (max-width: 719px) {
			min-height: max(2.75rem, 44px);
		}
	}
	/* UX7: the release row. One line whenever it fits (it does at 390 px in
	   the icon-only phone layout), labels hidden on phones where each button
	   keeps its aria-label; 44 px floor from the button system. */
	.release-actions {
		flex-wrap: wrap;
		gap: 0.5rem;
		min-width: 0;
		:global(.ra-btn) {
			padding-inline: 0.9rem;
		}
		@media only screen and (max-width: 719px) {
			:global(.ra-btn) {
				min-width: max(2.75rem, 44px);
				padding-inline: 0.6rem;
				gap: 0;
			}
			:global(.ra-lbl) {
				display: none;
			}
		}
	}
</style>
