<script lang="ts">
	// "Partager": native share sheet, else the canonical URL (/listen?id= for a
	// track, /release?id= for an album) copied with a "Lien copié" toast.
	import Icon from "$components/Icon/Icon.svelte";
	import { canonicalShareURL, shareLink, type ShareKind } from "$lib/utils/shareLink";

	export let kind: ShareKind;
	export let id: string | null | undefined;
	export let title = "";
	export let artist = "";
	/** Icon-only round button (fullscreen player bars); else icon + "Partager". */
	export let iconOnly = false;
	/** Icon colour (the fullscreen player sits on a dark cover). */
	export let color: string | undefined = undefined;
	/** UX7: "secondary" = the pill of the album action row; default ghost. */
	export let variant: "ghost" | "secondary" = "ghost";
	/** UX7: icon + label on desktop, icon-only on phones (aria-label stays). */
	export let responsive = false;

	let busy = false;
	async function onShare() {
		if (busy || !id || typeof location === "undefined") return;
		busy = true;
		try {
			const url = canonicalShareURL(kind, id, location.origin);
			const text = artist ? `${title} · ${artist}` : title;
			await shareLink({ title: title || "music.ekaii.fr", text: text || undefined, url });
		} finally {
			busy = false;
		}
	}
</script>

<button
	type="button"
	class="share-link {variant === 'secondary' ? 'btn-secondary' : 'btn-ghost'}"
	class:icon-only={iconOnly}
	class:responsive
	data-testid="share-link"
	aria-label="Partager"
	title="Partager le lien"
	disabled={!id || busy}
	on:click|stopPropagation={onShare}
>
	<Icon
		name="share"
		size={iconOnly ? "1.5em" : "1.1em"}
		{color}
		--stroke={color ?? "currentColor"}
	/>
	{#if !iconOnly}<span class="share-lbl">Partager</span>{/if}
</button>

<style>
	.share-link.icon-only {
		min-width: max(2.75rem, 44px);
		padding: 0.4em;
		filter: drop-shadow(0 1px 2px rgb(0 0 0 / 60%));
	}
	@media only screen and (max-width: 719px) {
		.share-link.responsive {
			min-width: max(2.75rem, 44px);
			padding-inline: 0.6rem;
			gap: 0;
		}
		.share-link.responsive .share-lbl {
			display: none;
		}
	}
</style>
