<script lang="ts">
	// Empty state with ONE action (audit-ux-v2 2.4): a pictogram, a short title,
	// one line of explanation and a single 44px pill link. Used by the Offline,
	// Favorites and Lyrics pages so the three empty screens read the same.
	import Icon from "$components/Icon/Icon.svelte";
	import type { Icons } from "$components/Icon/icons";

	export let title: string;
	export let text = "";
	export let href = "/home";
	export let cta = "Explorer";
	export let icon: Icons | undefined = undefined;
</script>

<div
	class="empty-state"
	role="status"
>
	{#if icon}
		<span
			class="pictogram"
			aria-hidden="true"
		>
			<Icon
				name={icon}
				size="2rem"
				strokeWidth={1.5}
			/>
		</span>
	{/if}
	<p class="title">{title}</p>
	{#if text}
		<p class="text">{text}</p>
	{/if}
	<a
		class="action"
		{href}>{cta}</a
	>
</div>

<style lang="scss">
	$text: var(--color-dark, #fafafa);
	$muted: #b3b3b3; // >= 9:1 on the page background
	$accent: #1ed760;

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.5rem;
		margin: 2.5rem auto;
		padding: 0 1rem;
		max-width: 28rem;
	}
	.pictogram {
		display: grid;
		place-items: center;
		width: 4rem;
		height: 4rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08);
		color: $muted;
		margin-bottom: 0.25rem;
	}
	.title {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
		line-height: 1.3;
		color: $text;
	}
	.text {
		margin: 0;
		font-size: 0.95rem;
		line-height: 1.45;
		color: $muted;
	}
	// Pill CTA, same recipe as the Offline page's .cta.primary (44px, accent).
	.action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-height: 2.75rem;
		margin-top: 0.75rem;
		padding: 0.55rem 1.4rem;
		border-radius: 999px;
		background: $accent;
		color: #000;
		font-size: 1rem;
		font-weight: 600;
		line-height: 1.2;
		text-decoration: none;
		text-transform: none;
		white-space: nowrap;
		&:hover,
		&:focus {
			background: #22e668;
			color: #000;
		}
		&:focus-visible {
			outline: 2px solid $accent;
			outline-offset: 2px;
		}
	}
</style>
