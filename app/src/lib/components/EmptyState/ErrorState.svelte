<script lang="ts">
	// L10-9: a list whose request FAILED (server error, not offline) says so
	// and offers to retry, instead of the empty state ("Rien d'écouté…"),
	// which is only for a request that succeeded with 0 items.
	import { createEventDispatcher } from "svelte";

	export let title = "Impossible de charger";
	export let text = "";
	/** data-testid of the retry button. */
	export let retryTestid = "retry";
	const dispatch = createEventDispatcher<{ retry: void }>();
</script>

<div
	class="error-state"
	role="alert"
	data-testid="error-state"
>
	<p class="title">{title}</p>
	{#if text}
		<p class="text">{text}</p>
	{/if}
	<button
		type="button"
		class="btn-reset btn-secondary action"
		data-testid={retryTestid}
		on:click={() => dispatch("retry")}>Réessayer</button
	>
</div>

<style lang="scss">
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.5rem;
		margin: 2.5rem auto;
		padding: 0 1rem;
		max-width: 28rem;
	}
	.title {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
		line-height: 1.3;
		color: var(--color-dark, #fafafa);
	}
	.text {
		margin: 0;
		font-size: 0.95rem;
		line-height: 1.45;
		color: #b3b3b3;
	}
	.action {
		margin-top: 0.75rem;
		min-height: 44px;
	}
</style>
