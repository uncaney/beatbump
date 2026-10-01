<script lang="ts">
	// Tab bar linking the self-hosted collection browse pages + the IDB library.
	// F9: 9 chips in 3 visual groups (was 13, two "Playlists", mixed fr/en):
	// Collection (Albums, Artistes, Titres, Playlists), Pour toi (Pour toi,
	// Mixes), Activité (Écoutes, Tes stats), then Hors-ligne. Genres live under
	// Mixes (a link on that page and on Explore), Favoris under the ♥ of the
	// navigation bar (/library/saved), Compte under its user icon.
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
	// Pages without a chip of their own highlight the chip they belong to.
	const ALIAS: Record<string, string> = { genres: "mixes", "my-playlists": "playlists" };
	$: current = ALIAS[active] ?? active;
	const groups: { name: string; tabs: { key: string; label: string; href: string }[] }[] = [
		{
			name: "Collection",
			tabs: [
				{ key: "albums", label: "Albums", href: "/library/albums" },
				{ key: "artists", label: "Artistes", href: "/library/artists" },
				{ key: "songs", label: "Titres", href: "/library/all-songs" },
				{ key: "playlists", label: "Playlists", href: "/library" },
			],
		},
		{
			name: "Pour toi",
			tabs: [
				{ key: "for-you", label: "Pour toi", href: "/library/for-you" },
				{ key: "mixes", label: "Mixes", href: "/library/mixes" },
			],
		},
		{
			name: "Activité",
			tabs: [
				{ key: "recent", label: "Écoutes", href: "/library/recent" },
				{ key: "stats", label: "Tes stats", href: "/library/stats" },
			],
		},
		{
			name: "Hors-ligne",
			tabs: [{ key: "downloads-offline", label: "Hors-ligne", href: "/library/downloads-offline" }],
		},
	];
</script>

<nav
	class="collnav"
	class:fade-start={fadeStart}
	class:fade-end={fadeEnd}
	aria-label="Bibliothèque"
	bind:this={nav}
	on:scroll={updateFades}
>
	{#each groups as g, gi (g.name)}
		<span
			class="group"
			class:first={gi === 0}
			role="group"
			aria-label={g.name}
		>
			{#each g.tabs as t (t.key)}
				<a
					href={t.href}
					aria-current={t.key === current ? "page" : undefined}
					class:active={t.key === current}>{t.label}</a
				>
			{/each}
		</span>
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
	/* A group is a run of chips; a thin rule separates groups (F9). */
	.group {
		display: inline-flex;
		gap: 0.4rem;
		padding-left: 0.6rem;
		border-left: 1px solid rgba(255, 255, 255, 0.18);
		&.first {
			padding-left: 0;
			border-left: 0;
		}
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
		.group {
			flex: 0 0 auto;
		}
		a {
			flex: 0 0 auto;
			white-space: nowrap;
		}
	}
</style>
