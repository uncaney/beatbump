<script lang="ts">
	import { page } from "$app/stores";
	import Header from "$lib/components/Layouts/Header.svelte";
	import InfoBox from "$lib/components/Layouts/InfoBox.svelte";
	import KeepOfflineButton from "$lib/components/ListItem/KeepOfflineButton.svelte";
	import ListItem, {
		listItemPageContext,
	} from "$lib/components/ListItem/ListItem.svelte";
	import { playTracks } from "$lib/components/PlayAllBar/PlayAllBar.svelte";
	import { CTX_ListItem, releasePageContext } from "$lib/contexts";
	import list from "$lib/stores/list";
	import { isPagePlaying } from "$stores/stores";
	import { onMount } from "svelte";
	import type { PageData } from "./$types";

	export let data: PageData;

	// reactive so album→album navigation updates (was const → stale, like the artist page)
	$: pageItems = data?.items;
	$: path = data?.path;
	$: id = $page.url.searchParams.get("id");
	$: items = pageItems?.items ?? [];
	// 404 from the album endpoint (local album with no track left): no page data.
	$: notFound = !pageItems;
	$: releaseInfo = pageItems?.releaseInfo ?? {};
	$: thumbnail = releaseInfo?.thumbnails?.[0]?.url?.replace(
		/=(w(\d+))-(h(\d+))/g,
		"=w512-h512",
	);

	const setId = () => isPagePlaying.add(id);

	// F3: a local album (id "lb-…", local_pages.go) has no YouTube playlistId
	// nor autoMixId: "Play Album" / "Album Radio" called the YouTube `next`
	// endpoint with an empty id (a dead button next to the EQ1 "Radio"). Its
	// rows are played as they are; the only radio is InfoBox's [radio-seed].
	$: isLocalAlbum = !!id && id.startsWith("lb-");
	$: hasAutoMix = typeof releaseInfo?.autoMixId === "string" && releaseInfo.autoMixId.length > 0;
	const localContext = () => ({
		kind: "album" as const,
		title: String(releaseInfo?.title ?? ""),
		href: `/release?id=${encodeURIComponent(id ?? "")}`,
	});

	const playAlbum = () => {
		setId();
		if (isLocalAlbum) {
			void playTracks(items, { context: localContext() });
			return;
		}
		list.initPlaylistSession({ playlistId: releaseInfo.playlistId, index: 0 });
		list.updatePosition(0);
	};

	const playShuffle = () => {
		setId();
		if (isLocalAlbum) {
			void playTracks(items, { shuffle: true, context: localContext() });
			return;
		}

		list.initPlaylistSession({
			playlistId: `${releaseInfo?.playlistId}`,
			index: 0,
			params: "wAEB8gECGAE%3D",
		});
	};

	// One word per concept (F4): "Lire" on a local album (French screen),
	// YouTube albums keep "Play Album" / "Album Radio"; the radio button only
	// exists when YouTube gave an autoMixId.
	$: headerButtons = [
		{ text: isLocalAlbum ? "Lire" : "Play Album", action: () => playAlbum(), icon: "play" },
		...(hasAutoMix
			? [{ text: "Album Radio", type: "outlined", action: () => playRadio(), icon: "play" }]
			: []),
		{ icon: "dots", type: "icon" },
	] as any[];

	const playRadio = () => {
		setId();

		list.initPlaylistSession({
			playlistId: releaseInfo?.autoMixId,
			params: "wAEB",
			index: 0,
		});
	};

	onMount(() => {
		const release = listItemPageContext.add("playlist");
		return () => {
			release?.();
			list.offerContext(null, null);
		};
	});
	// P2: a session started on this album (Play Album or a track row) shows
	// "Album : <title> · n/N" with a link back here.
	$: list.offerContext(releaseInfo?.playlistId, releaseInfo?.title
		? { kind: "album", title: releaseInfo.title, href: `/release?id=${encodeURIComponent(id ?? "")}` }
		: null);

	CTX_ListItem.set({
		parentPlaylistId: data?.items?.releaseInfo?.playlistId,
		page: "release",
	});
	releasePageContext.set({ page: "release" });
</script>

<Header
	title={releaseInfo.title}
	desc={`${releaseInfo.title} by ${releaseInfo?.artist[0]?.name} on Beatbump`}
	url={path + `?id=${id}`}
	image={thumbnail}
/>

<main data-testid="release">
	<InfoBox
		{thumbnail}
		buttons={headerButtons}
		title={releaseInfo.title}
		artist={releaseInfo.artist}
		subtitles={releaseInfo.subtitles}
		type="release"
		on:shuffle={playShuffle}
	>
		<!-- O8: download the missing tracks then pin the whole album.
		     Audit v7 TOP 3: its own row inside the header grid, under
		     the play buttons (was a bare div after the InfoBox:
		     x=0 on phones, under the cover on desktop). -->
		<svelte:fragment slot="actions">
			{#if !notFound && items.length}
				<KeepOfflineButton tracks={items} />
			{/if}
		</svelte:fragment>
	</InfoBox>
	{#if notFound}
		<p class="release-missing">Cet album n'est plus dans la bibliothèque.</p>
	{/if}
	{#each items as item, index}
		<ListItem
			on:setPageIsPlaying={() => setId()}
			{item}
			idx={index}
		/>
	{/each}
</main>
