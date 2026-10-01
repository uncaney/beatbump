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
	/* Same box as the Button component next to it (Play Radio / Shuffle):
	   inline-flex, 1.1rem text, 40px high on desktop / 36px on phones, so the
	   three sit on one row at the same baseline (audit v3 1.6). The parent
	   .btn-wrpr (ArtistPageHeader) sets the same min-height on all three. */
	.follow-btn {
		appearance: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-height: 40px;
		margin: 0;
		border: 0.13em solid rgba(255, 255, 255, 0.5) !important;
		background: transparent !important;
		color: #fff !important;
		font-family: "Commissioner Variable", sans-serif;
		font-size: 1.1rem;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		padding: 0.5em 1.25em;
		border-radius: 9999em;
		text-transform: none;
		vertical-align: middle;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
		@media only screen and (max-width: 719px) {
			min-height: 36px;
		}
	}
	/* :focus / :active too: the global button:not(.icon-btn):focus rule paints
	   a light grey background !important, which would leave white text on grey
	   right after a click. */
	.follow-btn:hover,
	.follow-btn:focus,
	.follow-btn:focus-within,
	.follow-btn:active {
		background: rgba(255, 255, 255, 0.12) !important;
		border-color: rgba(255, 255, 255, 0.75) !important;
		color: #fff !important;
		box-shadow: none !important;
	}
	.follow-btn.following {
		background: var(--accent, #1ed760) !important;
		border-color: transparent !important;
		color: #000 !important;
	}
	.follow-btn.following:hover,
	.follow-btn.following:focus,
	.follow-btn.following:focus-within,
	.follow-btn.following:active {
		background: var(--accent, #1ed760) !important;
		border-color: transparent !important;
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
