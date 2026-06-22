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
	.follow-btn {
		appearance: none;
		border: 1px solid rgba(255, 255, 255, 0.4);
		background: transparent;
		color: inherit;
		font-weight: 600;
		padding: 0.45rem 1.25rem;
		border-radius: 2rem;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
	}
	.follow-btn:hover {
		background: rgba(255, 255, 255, 0.12);
	}
	.follow-btn.following {
		background: var(--accent, #1ed760);
		border-color: transparent;
		color: #000;
	}
	.follow-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
