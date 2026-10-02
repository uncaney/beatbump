<script lang="ts">
	// Empty state with ONE action (audit-ux-v2 2.4): a pictogram, a short title,
	// one line of explanation and a single 44px pill link. Used by the Offline,
	// Favorites and Lyrics pages so the three empty screens read the same.
	import Icon from "$components/Icon/Icon.svelte";
	import type { Icons } from "$components/Icon/icons";

	export let title: string;
	export let text = "";
	export let href = "/home";
	/** The one action; "" renders none (U13-8: a pack in progress has nothing to explore yet). */
	export let cta = "Explorer";
	export let icon: Icons | undefined = undefined;
	/** data-testid of the block (UX3: "empty-state" on the library history pages). */
	export let testid: string | undefined = undefined;
</script>

<div
	class="empty-state"
	role="status"
	data-testid={testid}
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
	{#if cta}
		<a
			class="action btn-secondary"
			{href}>{cta}</a
		>
	{/if}
</div>

<style lang="scss">
	$text: var(--color-dark, #fafafa);
	$muted: #b3b3b3; // >= 9:1 on the page background

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
	// Layout only (audit UX v9 BACKLOG P3): colour/border/background now come
	// from the shared .btn-secondary button-system class (_button.scss),
	// dropping the accent-green fill this used to share with the Offline
	// page's .cta.primary.
	.action {
		margin-top: 0.75rem;
		text-decoration: none;
	}
</style>
