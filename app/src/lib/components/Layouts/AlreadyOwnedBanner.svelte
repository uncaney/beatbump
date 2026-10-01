<script lang="ts">
	// D5 "Tu l'as déjà": a YouTube album page (/release?id=MPREb_…) whose album
	// is in the local library (strict artist + title match) links to the local
	// version: offline playback, no network, the library's own files.
	import { findOwnedAlbum, isYouTubeAlbumId, type OwnedAlbum } from "$lib/utils/alreadyOwned";

	/** Album id of the page (only MPREb_ ids are looked up). */
	export let albumId: string | null = null;
	export let artist = "";
	export let title = "";

	let match: OwnedAlbum | null = null;
	let seq = 0;

	// Inputs only (never `match`) drive the lookup; a stale answer of the
	// previous album is dropped by the sequence number.
	$: lookup(albumId, artist, title);

	function lookup(id: string | null, a: string, t: string) {
		const mine = ++seq;
		match = null;
		if (!isYouTubeAlbumId(id) || !a || !t) return;
		void findOwnedAlbum(a, t).then((m) => {
			if (mine === seq) match = m;
		});
	}
</script>

{#if match}
	<aside
		class="already-owned resp-content-width"
		data-testid="already-owned"
		aria-label="Album dans ta bibliothèque"
	>
		{#if match.thumbnail}
			<img
				class="owned-cover"
				src={match.thumbnail}
				alt=""
				width="48"
				height="48"
				loading="lazy"
			/>
		{/if}
		<div class="owned-text">
			<strong>Tu l'as déjà dans ta bibliothèque</strong>
			<span class="owned-benefits">
				Version locale{match.trackCount ? ` · ${match.trackCount} titres` : ""} : écoute hors-ligne, sans réseau.
			</span>
		</div>
		<a
			class="owned-link"
			href={match.href}
			data-testid="already-owned-link">Ouvrir la version locale</a
		>
	</aside>
{/if}

<style lang="scss">
	.already-owned {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		box-sizing: border-box;
		margin: 0.5rem auto 1rem;
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		border: 1px solid hsl(0deg 0% 100% / 14%);
		background: hsl(0deg 0% 100% / 6%);
	}
	.owned-cover {
		width: 48px;
		height: 48px;
		border-radius: 0.375rem;
		object-fit: cover;
		flex: none;
	}
	.owned-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		flex: 1 1 12rem;
		min-width: 0;
	}
	.owned-benefits {
		opacity: 0.75;
		font-size: 0.9em;
	}
	.owned-link {
		display: inline-flex;
		align-items: center;
		min-height: max(2.75rem, 44px);
		padding: 0 1rem;
		border-radius: 999px;
		font-weight: 600;
		background: hsl(0deg 0% 100% / 12%);
		color: inherit;
		text-decoration: none;
		&:hover,
		&:focus-visible {
			background: hsl(0deg 0% 100% / 20%);
		}
	}
</style>
