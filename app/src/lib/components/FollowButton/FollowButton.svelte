<script lang="ts">
	import { onMount } from "svelte";
	import { follow, unfollow, isFollowing } from "$lib/me";

	export let artistId: string;
	export let name = "";
	export let thumbnail = "";

	let following = false;
	let busy = false;
	let ready = false;

	onMount(async () => {
		if (artistId) following = await isFollowing(artistId);
		ready = true;
	});

	async function toggle() {
		if (busy || !artistId) return;
		busy = true;
		const next = !following;
		try {
			if (next) await follow(artistId, name, thumbnail);
			else await unfollow(artistId);
			following = next;
		} catch (e) {
			console.error("follow toggle failed", e);
		} finally {
			busy = false;
		}
	}
</script>

{#if artistId}
	<button
		class="follow-btn"
		class:following
		data-following={following}
		on:click={toggle}
		disabled={busy}
		title={following ? "Unfollow — stop auto-acquiring" : "Follow — auto-acquire this artist"}
	>
		{following ? "Following" : "Follow"}
	</button>
{/if}

<style lang="scss">
	/* The global %button-base (button:not(.icon-btn)) forces `color: #0f0f0f
	   !important` and a white background; on the transparent artist hero that
	   produced a 1.09:1 ghost outline (audit 1.5). Every colour here is therefore
	   !important too. #fff on #121212 = 17.9:1; border rgba(255,255,255,.5). */
	.follow-btn {
		appearance: none;
		border: 1px solid rgba(255, 255, 255, 0.5) !important;
		background: transparent !important;
		color: #fff !important;
		font-weight: 600;
		padding: 0.45rem 1.25rem;
		border-radius: 2rem;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
	}
	.follow-btn:hover {
		background: rgba(255, 255, 255, 0.12) !important;
		border-color: rgba(255, 255, 255, 0.75) !important;
		color: #fff !important;
	}
	.follow-btn.following {
		background: var(--accent, #1ed760) !important;
		border-color: transparent !important;
		color: #000 !important;
	}
	.follow-btn.following:hover {
		background: var(--accent, #1ed760) !important;
		color: #000 !important;
	}
	.follow-btn:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 2px;
	}
	/* Busy (disabled) state stays readable: #9a9a9a on #2c2c2c = 4.96:1, no opacity. */
	.follow-btn:disabled {
		opacity: 1 !important;
		background: rgb(44, 44, 44) !important;
		color: #9a9a9a !important;
		border-color: rgba(255, 255, 255, 0.25) !important;
		cursor: default;
	}
</style>
