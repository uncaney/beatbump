<script lang="ts">
	// One album (or an artist's "Singles" bucket): cover, name, artist, count,
	// two visible actions (play album + pin, audit v5 TOP 6), a kebab menu for
	// the secondary ones (shuffle, show/hide tracks) and a collapsible track list
	// (the cover and the name toggle it; click a track to play the album from
	// there). Events: play {tracks, index, shuffle}, remove track, pin, recache.
	//
	// The global stylesheet forces `color: #0f0f0f !important`, `display:
	// inline-flex` and `text-transform: capitalize` on every `button:not(.icon-btn)`;
	// the styles below override those explicitly so the album name and meta stack
	// (name on top, artist/count under it) and stay readable on dark backgrounds.
	import Icon from "$components/Icon/Icon.svelte";
	import type { AlbumGroup } from "$lib/offlineQueue";
	import { formatBytes } from "$lib/offlineQueue";
	import { keepOffline } from "$lib/offlineBatch";
	import { markOfflineSuccess } from "$lib/stores/pwa";
	import { notify } from "$lib/utils";
	import { createEventDispatcher, tick } from "svelte";
	import OfflineTrackRow from "./OfflineTrackRow.svelte";

	export let album: AlbumGroup;
	export let activeId = "";
	export let open = false;
	export let showArtist = true;
	/** Passed to each row: "Retélécharger" is disabled offline (H6). */
	export let online = true;

	const dispatch = createEventDispatcher<{
		play: { tracks: any[]; index: number; shuffle?: boolean };
		remove: any;
		pin: any;
		recache: any;
		/** HL1: one or more missing tracks were just downloaded + pinned; ask the page to refresh its list. */
		complete: { album: AlbumGroup };
	}>();

	let imgBroken = false;
	$: count = album.tracks.length;
	$: allPinned = album.tracks.length > 0 && album.tracks.every((t: any) => !!t._pinned);
	$: size = formatBytes(album.bytes);
	$: isActive = !!activeId && album.tracks.some((t) => t.videoId === activeId);
	$: toggleLabel = open ? "Replier l'album" : "Déplier l'album";

	// HL1: per-album readiness. `_cached` is set per track by the offline list
	// (offlineQueue.ts); "ready" tracks are already downloaded whether or not
	// they are pinned. "Compléter" downloads + pins only the missing ones via
	// the existing keep-offline batch (offlineBatch.keepOffline), same engine
	// as KeepOfflineButton.
	$: readyCount = album.tracks.filter((t: any) => !!t._cached).length;
	$: missingTracks = album.tracks.filter((t: any) => !t._cached);
	let completing = false;
	async function completeAlbum() {
		if (completing || !missingTracks.length) return;
		completing = true;
		try {
			const r = await keepOffline(missingTracks);
			dispatch("complete", { album });
			if (r.ready > 0) markOfflineSuccess();
			if (r.cancelled) return;
			if (r.refused) notify("Quota atteint, augmente-le dans Réglages", "error");
			else if (r.failed && !r.ready) notify("Impossible de compléter l'album pour l'instant", "error");
			else if (r.failed) notify(`${r.ready} sur ${r.total} pistes complétées`, "error");
			else notify(r.ready > 1 ? `${r.ready} pistes complétées` : "Piste complétée", "success");
		} finally {
			completing = false;
		}
	}

	// Kebab menu (secondary actions). Closes on Escape, outside click and after
	// a choice; focus goes to the first item on open and back to the kebab.
	let menuOpen = false;
	let menuBtn: HTMLButtonElement | null = null;
	let menuEl: HTMLDivElement | null = null;
	const menuId = "album-menu-" + Math.random().toString(36).slice(2, 9);
	async function toggleMenu() {
		menuOpen = !menuOpen;
		if (menuOpen) {
			await tick();
			menuEl?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
		}
	}
	function closeMenu(refocus = true) {
		if (!menuOpen) return;
		menuOpen = false;
		if (refocus) menuBtn?.focus();
	}
	function onWindowClick(e: MouseEvent) {
		if (!menuOpen) return;
		const t = e.target as Node | null;
		if (t && (menuEl?.contains(t) || menuBtn?.contains(t))) return;
		closeMenu(false);
	}
	function onMenuKeydown(e: KeyboardEvent) {
		const items = Array.from(menuEl?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") || []);
		const i = items.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === "Escape") {
			e.preventDefault();
			closeMenu();
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const n = items.length;
			if (n) items[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n].focus();
		} else if (e.key === "Tab") {
			closeMenu(false);
		}
	}
	function shuffleAlbum() {
		closeMenu();
		dispatch("play", { tracks: album.tracks, index: 0, shuffle: true });
	}
	function toggleTracks() {
		closeMenu();
		open = !open;
	}
</script>

<svelte:window on:click={onWindowClick} />

<section
	class="album"
	class:active={isActive}
	class:menu-open={menuOpen}
>
	<div class="head">
		<button
			class="cover"
			type="button"
			title={toggleLabel}
			aria-label={toggleLabel}
			on:click={() => (open = !open)}
		>
			{#if album.thumbnail && !imgBroken}
				<img
					alt=""
					src={album.thumbnail}
					loading="lazy"
					on:error={() => (imgBroken = true)}
				/>
			{:else}
				<span class="ph"><Icon name="album" size="1.4em" /></span>
			{/if}
		</button>
		<button
			class="info"
			type="button"
			aria-expanded={open}
			title={toggleLabel}
			on:click={() => (open = !open)}
		>
			<span class="text">
				<span
					class="name"
					title={album.name}>{album.name}</span
				>
				<!-- One space on each side of every " · " (audit v6 3.5): the line
				     break after {/if} used to add a second one. -->
				<span class="sub"
					>{#if showArtist}<span class="artist">{album.artist}</span><span class="dot"
							>{" · "}</span
						>{/if}{count} {count > 1 ? "pistes" : "piste"}{#if size}<span class="dot"
							>{" · "}</span
						>{size}{/if}</span
				>
			</span>
		</button>
		<div class="actions">
			<button
				class="btn"
				type="button"
				title="Lire l'album"
				aria-label="Lire l'album"
				on:click={() => dispatch("play", { tracks: album.tracks, index: 0 })}
			>
				<Icon
					name="play"
					size="1.1em"
					fill="currentColor"
				/>
			</button>
			<button
				type="button"
				class="btn pin"
				class:on={allPinned}
				aria-pressed={allPinned}
				aria-label={allPinned ? "Désépingler l'album" : "Épingler l'album hors-ligne"}
				on:click={() => dispatch("pin", { tracks: album.tracks, pinned: !allPinned })}>
				<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill={allPinned ? "currentColor" : "none"} stroke="currentColor" stroke-width="2"><path d="M16 3l5 5-4 1-5 5 1 5-3 3-4-6-4 4-1-1 4-4-6-4 3-3 5 1 5-5z"/></svg>
			</button>
			<div class="menu-wrap">
				<button
					class="kebab"
					type="button"
					title="Plus d'options"
					aria-label="Plus d'options pour l'album"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					aria-controls={menuOpen ? menuId : undefined}
					bind:this={menuBtn}
					on:click={toggleMenu}
				>
					<Icon
						name="dots"
						size="1.1em"
					/>
				</button>
				{#if menuOpen}
					<div
						class="menu"
						id={menuId}
						role="menu"
						tabindex="-1"
						aria-label="Options de l'album"
						bind:this={menuEl}
						on:keydown={onMenuKeydown}
					>
						<button
							class="item"
							type="button"
							role="menuitem"
							tabindex="-1"
							on:click={shuffleAlbum}
						>
							<Icon
								name="shuffle"
								size="1.1em"
							/>
							<span>Lecture aléatoire</span>
						</button>
						<button
							class="item"
							type="button"
							role="menuitem"
							tabindex="-1"
							on:click={toggleTracks}
						>
							<Icon
								name="list-music"
								size="1.1em"
							/>
							<span>{open ? "Masquer les pistes" : "Afficher les pistes"}</span>
						</button>
					</div>
				{/if}
			</div>
		</div>
	</div>
	{#if count > 0}
		<div class="readiness">
			<span class="ready" data-testid="album-ready">{readyCount}/{count} prêts</span>
			{#if readyCount < count}
				<button
					type="button"
					class="btn-secondary complete"
					data-testid="album-complete"
					disabled={completing}
					aria-busy={completing}
					on:click={completeAlbum}
				>
					{completing ? "Téléchargement…" : "Compléter"}
				</button>
			{/if}
		</div>
	{/if}
	{#if open}
		<div class="tracks">
			{#each album.tracks as t, i (t.videoId)}
				<OfflineTrackRow
					track={t}
					number={album.isSingles ? undefined : i + 1}
					showArtist={album.isSingles ? showArtist : false}
					active={t.videoId === activeId}
					{online}
					on:play={() => dispatch("play", { tracks: album.tracks, index: i })}
					on:remove={(e) => dispatch("remove", e.detail)}
					on:pin={(e) => dispatch("pin", e.detail)}
					on:recache={(e) => dispatch("recache", e.detail)}
				/>
			{/each}
		</div>
	{/if}
</section>

<style lang="scss">
	$text: var(--color-dark, #fafafa);
	$muted: #b3b3b3;
	$accent: #1ed760;

	.album {
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.75rem;
		background: rgba(255, 255, 255, 0.03);
		margin-bottom: 0.6rem;
		overflow: hidden;
		&.active {
			border-color: rgba(30, 215, 96, 0.35);
		}
		// The kebab menu is absolute inside the card: let it overflow.
		&.menu-open {
			overflow: visible;
		}
		&.active .name {
			color: $accent;
		}
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem;
		min-width: 0;
	}
	// Shared reset for the three buttons: beats the global %button-base
	// (dark text / border / hover backgrounds, all !important there).
	.cover,
	.info,
	.btn,
	.kebab,
	.item {
		color: $text !important;
		box-shadow: none !important;
		font: inherit;
		text-transform: none;
		line-height: 1.3;
		cursor: pointer;
		text-align: left;
		// Global `button:not(.icon-btn):focus/:active` (0,2,1) paints a light
		// grey background !important; keep ours on every interactive state.
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			color: $text !important;
			box-shadow: none !important;
		}
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
		}
	}
	.cover {
		flex: 0 0 auto;
		width: 3.5rem;
		height: 3.5rem;
		padding: 0;
		border: 0 !important;
		border-radius: 0.5rem;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.06) !important;
		display: grid;
		place-items: center;
		color: #aaa !important;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.12) !important;
			border-color: transparent !important;
			color: #aaa !important;
		}
		img {
			width: 100%;
			height: 100%;
			object-fit: cover;
			display: block;
		}
	}
	// Name + meta stacked in a column (the button toggles the track list, as
	// the cover does): no chevron, the card shows two round actions only.
	.info {
		flex: 1 1 auto;
		min-width: 0;
		min-height: max(2.75rem, 44px);
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0;
		border: 0 !important;
		background: none !important;
		white-space: normal;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: none !important;
			border-color: transparent !important;
		}
		&:hover .name {
			text-decoration: underline;
		}
	}
	.text {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.name {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
		font-weight: 600;
		font-size: 1rem;
	}
	.sub {
		display: block;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.85rem;
		font-weight: 400;
		color: $muted;
	}
	.dot {
		margin: 0;
		white-space: pre;
	}
	.actions {
		flex: 0 0 auto;
		display: flex;
		gap: 0.3rem;
	}
	.btn {
		// 44px touch target with a px floor: the mobile root font is 12px, so
		// 2.75rem alone collapsed to 33px (audit v4 TOP 3).
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		width: auto;
		height: auto;
		padding: 0;
		border-radius: 999px;
		display: grid;
		place-items: center;
		line-height: 1;
		background: rgba(255, 255, 255, 0.08) !important;
		border: 1px solid rgba(255, 255, 255, 0.15) !important;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.16) !important;
			border-color: rgba(255, 255, 255, 0.3) !important;
		}
	}
	// Kebab: no disc, so the two round actions stay the card's only visible
	// buttons; 44px tall tap zone, narrow width.
	.menu-wrap {
		position: relative;
		display: flex;
	}
	.kebab {
		min-width: max(2rem, 32px);
		min-height: max(2.75rem, 44px);
		padding: 0;
		display: grid;
		place-items: center;
		border: 0 !important;
		border-radius: 0.5rem;
		background: none !important;
		color: $muted !important;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.08) !important;
			border-color: transparent !important;
			color: $text !important;
		}
	}
	.menu {
		position: absolute;
		right: 0;
		top: calc(100% + 0.25rem);
		z-index: 20;
		min-width: 13rem;
		padding: 0.3rem;
		border-radius: 0.6rem;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: #1e1e1e;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		display: flex;
		flex-direction: column;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		min-height: max(2.75rem, 44px);
		padding: 0 0.75rem;
		border: 0 !important;
		border-radius: 0.4rem;
		background: none !important;
		font-size: 0.95rem;
		white-space: nowrap;
		&:hover,
		&:focus,
		&:focus-within,
		&:active {
			background: rgba(255, 255, 255, 0.1) !important;
			border-color: transparent !important;
		}
		&:focus-visible {
			outline-offset: -2px;
		}
	}
	.tracks {
		padding: 0 0.4rem 0.5rem;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}
	// HL1: readiness line under the head row; the pill button is full-size
	// (.btn-secondary) so it stays outside the cramped icon-button row.
	.readiness {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0 0.6rem 0.5rem;
	}
	.ready {
		font-size: 0.85rem;
		color: $muted;
	}
	.complete {
		font-size: 0.85rem;
		min-height: 2rem;
		padding: 0.3rem 0.9rem;
	}
	@media (max-width: 420px) {
		.head {
			gap: 0.5rem;
			padding: 0.5rem;
		}
		.cover {
			width: 3rem;
			height: 3rem;
		}
		.actions {
			gap: 0.25rem;
		}
	}
	.pin.on {
		color: #1ed760;
	}
</style>
