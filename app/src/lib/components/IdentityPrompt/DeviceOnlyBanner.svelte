<script lang="ts">
	// 39A (B6-23): one line for an ANONYMOUS profile on its history screens
	// (Ton mois, Écoutes): what is shown lives on this device only. The link
	// opens the identity prompt (forced: whatever the count and the snooze).
	// `autoPrompt` also lets the prompt open by itself (>= 10 plays, not
	// snoozed) right under the banner. Nothing for a named profile.
	import { onMount } from "svelte";
	import { isAnonymousProfile } from "$lib/me";
	import IdentityPrompt from "./IdentityPrompt.svelte";

	export let autoPrompt = false;
	export let text = "Ces écoutes ne vivent que sur cet appareil.";

	let anonymous = false;
	let opened = false;
	let promptVisible = false;

	onMount(() => {
		let alive = true;
		isAnonymousProfile().then((a) => {
			if (alive) anonymous = a;
		});
		return () => {
			alive = false;
		};
	});
</script>

{#if anonymous}
	<p
		class="device-only"
		data-testid="device-only-banner"
	>
		<span>{text}</span>
		{#if !promptVisible}
			<button
				type="button"
				class="btn-reset link"
				data-testid="device-only-link"
				on:click={() => (opened = true)}>Dis-moi ton prénom</button
			>
		{/if}
	</p>
	{#if autoPrompt || opened}
		<IdentityPrompt
			force={opened}
			bind:visible={promptVisible}
			on:named={() => (anonymous = false)}
			on:later={() => (opened = false)}
		/>
	{/if}
{/if}

<style lang="scss">
	.device-only {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.6rem;
		margin: 0.5rem 0 0.75rem;
		color: #b3b3b3;
		font-size: var(--text-secondary-size);
	}
	/* U13-6: the link read green on a grey pad (2.78:1): `.btn-reset` keeps
	   the global button rule off it, but `.link` set no background and the
	   accent green sat on the muted banner. No background, the primary text
	   colour underlined (white on the page background: >= 4.5:1). */
	.link {
		min-height: 44px;
		padding: 0 0.25rem;
		background: none;
		border: 0;
		color: #fff;
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	.link:hover,
	.link:focus-visible {
		text-decoration-thickness: 2px;
	}
	.link:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 2px;
	}
</style>
