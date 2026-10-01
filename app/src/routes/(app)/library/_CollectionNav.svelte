<script lang="ts">
	// Tab bar linking the self-hosted collection browse pages + the IDB library.
	import { onMount } from "svelte";

	export let active = "";
	let nav: HTMLElement;
	// Phones: the bar scrolls horizontally (one row). Centre the active chip on
	// load (audit v5 TOP 9: Hors-ligne / Account opened on a half-cut chip) and
	// fade whichever edge still has chips beyond it.
	let fadeStart = false;
	let fadeEnd = false;
	const updateFades = () => {
		if (!nav) return;
		const max = nav.scrollWidth - nav.clientWidth;
		fadeStart = max > 1 && nav.scrollLeft > 1;
		fadeEnd = max > 1 && nav.scrollLeft < max - 1;
	};
	onMount(() => {
		const el = nav?.querySelector<HTMLElement>("a.active");
		if (el && nav && nav.scrollWidth > nav.clientWidth) {
			// scrollLeft, not scrollIntoView: never scroll the page vertically.
			const left =
				el.getBoundingClientRect().left -
				nav.getBoundingClientRect().left +
				nav.scrollLeft;
			nav.scrollLeft = Math.max(0, left - (nav.clientWidth - el.offsetWidth) / 2);
		}
		updateFades();
		const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateFades) : undefined;
		ro?.observe(nav);
		return () => ro?.disconnect();
	});
	const tabs = [
		{ key: "for-you", label: "For You", href: "/library/for-you" },
		{ key: "playlists", label: "Playlists", href: "/library" },
		{ key: "artists", label: "Artists", href: "/library/artists" },
		{ key: "albums", label: "Albums", href: "/library/albums" },
		{ key: "songs", label: "Songs", href: "/library/all-songs" },
		{ key: "genres", label: "Genres", href: "/library/genres" },
		{ key: "mixes", label: "Mixes", href: "/library/mixes" },
		{ key: "saved", label: "Saved", href: "/library/saved" },
		{ key: "my-playlists", label: "My Playlists", href: "/library/playlists-srv" },
		{ key: "recent", label: "Listening", href: "/library/recent" },
		{ key: "stats", label: "Ton mois", href: "/library/stats" },
		{ key: "downloads-offline", label: "Hors-ligne", href: "/library/downloads-offline" },
		{ key: "account", label: "Account", href: "/library/account" },
	];
</script>

<nav
	class="collnav"
	class:fade-start={fadeStart}
	class:fade-end={fadeEnd}
	bind:this={nav}
	on:scroll={updateFades}
>
	{#each tabs as t}
		<a
			href={t.href}
			class:active={t.key === active}>{t.label}</a
		>
	{/each}
</nav>

<style lang="scss">
	.collnav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 1.25rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		padding-bottom: 0.6rem;
	}
	a {
		color: inherit;
		text-decoration: none;
		padding: 0.35rem 0.75rem;
		border-radius: 1rem;
		font-weight: 500;
		opacity: 0.7;
		background: rgba(255, 255, 255, 0.05);
	}
	a:hover {
		opacity: 1;
	}
	a.active {
		opacity: 1;
		background: rgba(255, 255, 255, 0.16);
	}
	/* Touch: chips were 24px high (audit 2.2). 44px tall pills on phones /
	   touch screens, same label size. */
	@media screen and (max-width: 719px), (hover: none) {
		a {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
			padding: 0.35rem 0.9rem;
		}
	}
	/* Phones (audit v4 3.4): one horizontally scrolling row (~52px) instead of
	   three wrapped rows (141px) before the page title. A chip cut at the right
	   edge is the scroll affordance; no scrollbar. */
	@media screen and (max-width: 719px) {
		.collnav {
			flex-wrap: nowrap;
			overflow-x: auto;
			overscroll-behavior-x: contain;
			scrollbar-width: none;
			-webkit-overflow-scrolling: touch;
		}
		.collnav::-webkit-scrollbar {
			display: none;
		}
		/* Edge fades (same idea as the home context chips): 24px on each side
		   that still has chips past it (audit v5 TOP 9). */
		.collnav.fade-start,
		.collnav.fade-end {
			--fade-l: 0px;
			--fade-r: 0px;
			-webkit-mask-image: linear-gradient(
				to right,
				transparent 0,
				#000 var(--fade-l),
				#000 calc(100% - var(--fade-r)),
				transparent 100%
			);
			mask-image: linear-gradient(
				to right,
				transparent 0,
				#000 var(--fade-l),
				#000 calc(100% - var(--fade-r)),
				transparent 100%
			);
		}
		.collnav.fade-start {
			--fade-l: 24px;
		}
		.collnav.fade-end {
			--fade-r: 24px;
		}
		a {
			flex: 0 0 auto;
			white-space: nowrap;
		}
	}
</style>
