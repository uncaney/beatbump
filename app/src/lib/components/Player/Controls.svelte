<script lang="ts">
	import { AudioPlayer } from "$lib/player";
	import SessionListService, {
		queue,
		type ISessionListService,
	} from "$lib/stores/list";
	import Icon from "../Icon/Icon.svelte";

	export let prevBtn: () => void;
	export let nextBtn: () => void;
	export let pause: () => void;

	export let isPaused: boolean;
	export let isQueue = false;
	export let loading: boolean;
	// `toggle` = shuffle / repeat glyph (desktop bar keeps 1em; the fullscreen
	// player passes a 24 px floor, audit UX v12 U12-15).
	export let sizes: { main: string; skip: string; toggle?: string } = {
		main: "2em",
		skip: "1.5em",
	};
	$: toggleSize = sizes.toggle ?? "1em";

	let original: ISessionListService["mix"] = [];
	// Mix type captured when shuffle was turned ON, restored when turned OFF
	// (audit F8): without it `setMix(original)` dropped the "local" type and an
	// offline / local queue fell back to YouTube `fetchNext` with local ids.
	let originalType: "auto" | "playlist" | "local" | undefined;
	let isShuffled = false;

	let repeatState: 0 | 1 | 2 = 0;
	let repeatIcon: "repeat" | "repeat-1" = "repeat";
	let repeatAlpha = 0.5;

	// French accessible names (a11y): derived only from existing UI state.
	$: repeatLabel =
		repeatIcon === "repeat-1"
			? "Répéter le morceau"
			: repeatAlpha > 0.5
			? "Répéter la liste"
			: "Répéter";
	$: playLabel = loading ? "Chargement" : isPaused ? "Lecture" : "Pause";
	$: repeatOn = repeatIcon === "repeat-1" || repeatAlpha > 0.5;

	// Audit UX v11 U11-9: inactive shuffle / repeat at 50% white read as
	// disabled. "Off" = muted but clearly enabled (72% white, aria-pressed
	// false); "on" = the green state colour (#1ed760, the playing-row / "Prêt
	// hors-ligne" token: a state, never a button fill) plus a dot under the
	// glyph (.is-on::after), so the state does not rely on colour alone.
	const ON_STROKE = "#1ed760";
	// U12-15: off at 82% white (72% still read as pale next to the white
	// transport glyphs); on also gets a green-tinted pastille behind the glyph.
	const OFF_STROKE = "hsla(0, 0%, 100%, 0.82)";

	function handleShuffle() {
		if (isShuffled === true && original.length !== 0) {
			isShuffled = false;
			const restored = original;
			const type = SessionListService.isLocalPlaylist
				? "local"
				: originalType;
			const currentId = $queue[$SessionListService.position]?.videoId;
			original = [];
			originalType = undefined;
			SessionListService.setMix(restored, type, $SessionListService.context).then(() => {
				// Keep the playing track as the cursor: its index differs once
				// the original order is back (updatePosition only moves the
				// cursor + prefetch, it does not start playback).
				const idx = currentId
					? restored.findIndex((t) => t?.videoId === currentId)
					: -1;
				if (idx >= 0 && idx !== SessionListService.position) {
					SessionListService.updatePosition(idx);
				}
			});
			return;
		}
		isShuffled = true;
		original = [...$queue];
		originalType =
			$SessionListService.currentMixType ??
			(SessionListService.isLocalPlaylist ? "local" : undefined);
		SessionListService.shuffle($SessionListService.position, true);
	}

	// Instance accessors for the keyboard shortcuts (Player.svelte `bind:this`):
	// "s" toggles shuffle, "r" cycles repeat, same code paths as the buttons.
	export function toggleShuffle() {
		handleShuffle();
	}
	export function cycleRepeat() {
		handleRepeat();
	}

	function handleRepeat() {
		++repeatState;
		switch (repeatState) {
			case 0:
				AudioPlayer.repeat("off");
				repeatIcon = "repeat";
				repeatAlpha = 0.5;
				break;
			case 1:
				repeatAlpha = 0.9;
				AudioPlayer.repeat("playlist");
				break;
			case 2:
				repeatAlpha = 0.9;
				repeatIcon = "repeat-1";
				AudioPlayer.repeat("track");
				repeatState = -1;
				break;
			default:
				AudioPlayer.repeat("off");
				repeatState = 0;
				break;
		}
	}
</script>

<div class="player-controls">
	<div class="buttons">
		<button
			type="button"
			class="player-btn"
			class:is-on={isShuffled}
			aria-label="Aléatoire"
			title="Aléatoire"
			aria-pressed={isShuffled}
			on:click|stopPropagation|capture={handleShuffle}
		>
			<Icon
				color="white"
				style="stroke-width:2; stroke: {isShuffled ? ON_STROKE : OFF_STROKE};"
				name="shuffle"
				fill={"none"}
				size={toggleSize}
			/>
		</button>
		<div class="controls-middle">
			<button
				type="button"
				class="player-btn"
				aria-label="Morceau précédent"
				title="Morceau précédent"
				on:click|stopPropagation|capture={prevBtn}
			>
				<Icon
					color="white"
					style="stroke-width:2; stroke: white;"
					name="skip-back"
					fill={isQueue ? "#fff" : "none"}
					size={sizes.skip}
				/>
			</button>
			<button
				type="button"
				class="player-btn player-title"
				aria-label={playLabel}
				title={playLabel}
				aria-busy={loading ? true : undefined}
				on:click|stopPropagation|capture={(e) => {
					if (!$SessionListService.mix) return;
					if (isPaused) {
						// console.log(e)
						// AudioPlayer.play(e)
						AudioPlayer.play(e);
					} else {
						pause();
					}
				}}
			>
				{#if loading}
					<div
						class="player-spinner"
						class:fade-out={loading ? true : false}
					/>
				{:else if isPaused}
					<!-- Solid white glyph in the desktop bar too (stroke-only at 1px read
					     as three faint grey lines, audit v3 TOP 10 #5). -->
					<Icon
						fill="#fff"
						color="#fff"
						--stroke="#fff"
						name="play"
						size={sizes.main}
					/>
				{:else}
					<Icon
						fill="#fff"
						color="#fff"
						--stroke="#fff"
						name="pause"
						size={sizes.main}
					/>
				{/if}
			</button>
			<button
				type="button"
				class="player-btn"
				aria-label="Morceau suivant"
				title="Morceau suivant"
				on:click|stopPropagation|capture={nextBtn}
			>
				<Icon
					color="white"
					style="stroke-width:2; stroke: white;"
					name="skip-forward"
					fill={isQueue ? "#fff" : "none"}
					size={sizes.skip}
				/>
			</button>
		</div>
		<button
			type="button"
			class="player-btn"
			class:is-on={repeatOn}
			aria-label={repeatLabel}
			title={repeatLabel}
			aria-pressed={repeatOn}
			on:click|stopPropagation|capture={handleRepeat}
		>
			<Icon
				color="white"
				style="stroke-width:2; stroke: {repeatOn ? ON_STROKE : OFF_STROKE};"
				name={repeatIcon}
				fill={"none"}
				size={toggleSize}
			/>
		</button>
	</div>
</div>

<style lang="scss">
	@import "../../../global/stylesheet/components/_player.scss";

	.player-controls {
		// margin-bottom: 0.1275em;margin-bottom
		margin-bottom: 0.2em;
	}

	.player-spinner {
		align-items: center;
		justify-content: center;
		justify-self: center;
		width: 2em;
		height: 2em;
		border: rgb(255 255 255 / 26%) solid 0.25em;
		border-radius: 50%;
		border-top-color: rgb(255 255 255 / 90.4%);
		animation: loading 1s infinite cubic-bezier(0.785, 0.135, 0.15, 0.86);
		max-width: 100%;
		max-height: 100%;
		opacity: 0;
		transition: ease-in-out 1s;
		transition-property: opacity;

		&.fade-out {
			opacity: 1;
			// transition: all ease-in-out 1s;transition
			// transition-property: opacity;transition-property
		}
	}

	@keyframes loading {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes loaddone {
		to {
		}
	}

	.buttons {
		justify-content: center;
		gap: 1em;
	}

	.controls-middle {
		display: flex;
		align-items: center;
	}

	.player-btn {
		max-height: 4em;
		max-width: 4em;
		padding: 0.5em;
		// native <button> reset (keeps the .player-btn look)
		background: none;
		border: none;
		color: #fff;
		font: inherit;
		align-items: center;
		justify-content: center;
		// touch target >= 44px
		min-width: 44px;
		min-height: 44px;
		border-radius: 50%;
		// the control itself is always fully opaque (only the hover halo fades)
		opacity: 1;

		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
		// U11-9: "on" dot under the shuffle / repeat glyph (state colour).
		&.is-on {
			background: rgba(30, 215, 96, 0.16);
		}
		&.is-on::after {
			content: "";
			position: absolute;
			left: 50%;
			bottom: 0.3em;
			width: 4px;
			height: 4px;
			border-radius: 50%;
			background: #1ed760;
			transform: translateX(-50%);
			pointer-events: none;
		}
	}
	.player-title {
		opacity: 1 !important;
	}
</style>
