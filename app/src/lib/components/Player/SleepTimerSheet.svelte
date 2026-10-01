<script
	context="module"
	lang="ts"
>
	import { writable } from "svelte/store";

	/** Open / close the sleep timer sheet (player ⋮ menu "Minuterie de sommeil"). */
	export const showSleepTimerSheet = writable<boolean>(false);
</script>

<script lang="ts">
	import Modal from "$components/Modal/Modal.svelte";
	import { portal } from "$lib/actions/portal";
	import {
		SLEEP_MINUTE_OPTIONS,
		cancelSleepTimer,
		sleepLabel,
		sleepMode,
		startSleepTimer,
		type SleepMode,
	} from "$stores/sleepTimer";

	function close() {
		showSleepTimerSheet.set(false);
	}

	function pick(mode: SleepMode) {
		startSleepTimer(mode);
		close();
	}

	function cancel() {
		cancelSleepTimer();
		close();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "Escape" && $showSleepTimerSheet) {
			e.preventDefault();
			close();
		}
	}
</script>

<svelte:window on:keydown={onKey} />

{#if $showSleepTimerSheet}
	<div use:portal>
		<Modal
			zIndex={400}
			on:close={close}
		>
			<div
				slot="header"
				class="sheet-header"
			>
				<h2
					class="h4"
					id="sleep-timer-title"
				>
					Minuterie de sommeil
				</h2>
				<button
					type="button"
					class="close-btn"
					aria-label="Fermer"
					title="Fermer (Échap)"
					on:click={close}>×</button
				>
			</div>
			<div
				class="sleep-sheet"
				data-testid="sleep-timer-sheet"
				aria-labelledby="sleep-timer-title"
			>
				{#if $sleepMode !== null}
					<p
						class="status"
						aria-live="polite"
					>
						Minuterie active : {$sleepLabel}
					</p>
				{:else}
					<p class="status">
						La lecture s'arrête en fondu à l'échéance.
					</p>
				{/if}
				<div
					class="options"
					role="group"
					aria-label="Arrêter la lecture"
				>
					{#each SLEEP_MINUTE_OPTIONS as m}
						<button
							type="button"
							class="opt"
							aria-pressed={$sleepMode === m}
							on:click={() => pick(m)}
						>
							Dans {m} min
						</button>
					{/each}
					<button
						type="button"
						class="opt"
						aria-pressed={$sleepMode === "track"}
						on:click={() => pick("track")}
					>
						À la fin du morceau
					</button>
				</div>
				{#if $sleepMode !== null}
					<button
						type="button"
						class="opt cancel"
						on:click={cancel}
					>
						Annuler la minuterie
					</button>
				{/if}
			</div>
		</Modal>
	</div>
{/if}

<style lang="scss">
	.sheet-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1em;
		padding-bottom: 0.5em;
		h2 {
			margin: 0;
		}
	}
	.close-btn {
		all: unset;
		cursor: pointer;
		font-size: 1.6em;
		line-height: 1;
		padding: 0.1em 0.4em;
		border-radius: 50%;
		color: #fff;
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
	.sleep-sheet {
		min-width: min(22rem, 80vw);
		display: flex;
		flex-direction: column;
		gap: 0.75em;
	}
	.status {
		margin: 0;
		font-size: 0.9em;
		opacity: 0.8;
	}
	.options {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5em;
		> .opt:last-child {
			grid-column: 1 / -1;
		}
	}
	.opt {
		all: unset;
		box-sizing: border-box;
		cursor: pointer;
		text-align: center;
		padding: 0.75em 1em;
		min-height: 44px;
		border-radius: 0.75em;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: rgba(255, 255, 255, 0.06) !important;
		// the global button rule sets a dark text colour with !important
		color: #fff !important;
		font-weight: 600;
		&:hover,
		&[aria-pressed="true"] {
			background: rgba(255, 255, 255, 0.18);
			border-color: rgba(255, 255, 255, 0.6);
		}
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
	.cancel {
		border-color: rgba(255, 120, 120, 0.6);
	}
</style>
