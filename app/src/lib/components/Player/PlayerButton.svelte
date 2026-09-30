<svelte:options immutable={true} />

<script lang="ts">
	import { AudioPlayer } from "$lib/player";
	import { playerLoading } from "$lib/stores";
	import { queue } from "$lib/stores/list";
	import Icon from "../Icon/Icon.svelte";
	const { paused } = AudioPlayer;

	$: isPaused = $paused;
	$: label = $playerLoading ? "Chargement" : isPaused ? "Lecture" : "Pause";
	function handleButtonPress() {
		if (!$queue) return;
		if (isPaused) {
			// console.log(e)
			// AudioPlayer.play(e)
			return AudioPlayer.play();
		} else {
			AudioPlayer.pause();
		}
	}
</script>

<!-- Native <button>: Enter/Space trigger click natively (no duplicate keydown handler). -->
<button
	type="button"
	class="player-btn player-title"
	aria-label={label}
	title={label}
	aria-busy={$playerLoading ? true : undefined}
	on:click|capture|stopPropagation={handleButtonPress}
>
	{#if $playerLoading}
		<div
			class="player-spinner"
			class:fade-out={$playerLoading ? true : false}
		/>
	{:else if isPaused}
		<Icon
			color="white"
			name="play"
			size={"24px"}
		/>
	{:else}
		<Icon
			color="white"
			name="pause"
			size={"1.625rem"}
		/>
	{/if}
</button>

<style lang="scss">
	@import "../../../global/stylesheet/components/_player.scss";

	.player-btn {
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		border-radius: 50%;

		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
</style>
