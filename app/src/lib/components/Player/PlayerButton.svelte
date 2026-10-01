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

<!-- Native <button>: Enter/Space trigger click natively (no duplicate keydown handler).
     `icon-btn` opts out of the global %button-base (white background, dark text,
     !important colours) so the control is a plain white glyph on a round 48 px hit area. -->
<button
	type="button"
	class="player-btn player-title icon-btn"
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
		<!-- Solid glyphs: the sprite's `play` / `pause` symbols are outlines, and with
		     the default 1 px stroke the pause bars read as three faint grey lines
		     (audit 1.11, mobile-16 / desktop-16). fill=white gives a filled icon. -->
		<Icon
			color="white"
			fill="white"
			name="play"
			size={"26px"}
		/>
	{:else}
		<Icon
			color="white"
			fill="white"
			name="pause"
			size={"26px"}
		/>
	{/if}
</button>

<style lang="scss">
	@import "../../../global/stylesheet/components/_player.scss";

	.player-btn {
		background: rgba(255, 255, 255, 0.12);
		border: none;
		color: #fff;
		opacity: 1;
		font: inherit;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		min-width: 48px;
		min-height: 48px;
		max-width: 48px;
		max-height: 48px;
		padding: 0;
		margin: 0 0.1em;
		border-radius: 50%;
		cursor: pointer;

		@media (hover: hover) {
			&:hover {
				background: rgba(255, 255, 255, 0.2);
			}
		}
		&:active {
			background: rgba(255, 255, 255, 0.28);
		}
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
</style>
