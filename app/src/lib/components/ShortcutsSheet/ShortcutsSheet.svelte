<script
	context="module"
	lang="ts"
>
	import { writable } from "svelte/store";

	/** Open / close the cheat sheet from anywhere (keyboard "?", player ⋮ menu). */
	export const showShortcutsSheet = writable<boolean>(false);

	export interface ShortcutRow {
		keys: string[];
		label: string;
	}

	/** Single source of truth for the cheat sheet (the handlers live in Player.svelte). */
	export const SHORTCUT_ROWS: ReadonlyArray<ShortcutRow> = [
		{ keys: ["Espace", "K"], label: "Lecture / pause" },
		{ keys: [",", "P"], label: "Morceau précédent" },
		{ keys: [".", "N"], label: "Morceau suivant" },
		{ keys: ["←"], label: "Reculer de 5 s" },
		{ keys: ["→"], label: "Avancer de 5 s" },
		{ keys: ["J"], label: "Reculer de 10 s" },
		{ keys: ["L"], label: "Avancer de 10 s" },
		{ keys: ["↑"], label: "Volume +5 %" },
		{ keys: ["↓"], label: "Volume -5 %" },
		{ keys: ["M"], label: "Couper / rétablir le son" },
		{ keys: ["S"], label: "Lecture aléatoire" },
		{ keys: ["R"], label: "Répéter (liste, morceau, off)" },
		{ keys: ["F"], label: "Lecteur plein écran" },
		{ keys: ["H"], label: "Ajouter / retirer des favoris" },
		{ keys: ["/"], label: "Rechercher" },
		{ keys: ["?"], label: "Afficher cette aide" },
		{ keys: ["Échap"], label: "Fermer cette aide" },
	];
</script>

<script lang="ts">
	import Modal from "$components/Modal/Modal.svelte";
	import { portal } from "$lib/actions/portal";

	function close() {
		showShortcutsSheet.set(false);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "Escape" && $showShortcutsSheet) {
			e.preventDefault();
			close();
		}
	}
</script>

<svelte:window on:keydown={onKey} />

{#if $showShortcutsSheet}
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
					id="shortcuts-title"
				>
					Raccourcis clavier
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
				class="shortcuts-sheet"
				data-testid="shortcuts-sheet"
				aria-labelledby="shortcuts-title"
			>
				<p class="hint">
					Sur ordinateur, hors champ de saisie. Les lettres fonctionnent sur
					tous les claviers.
				</p>
				<table>
					<tbody>
						{#each SHORTCUT_ROWS as row}
							<tr>
								<td class="keys">
									{#each row.keys as k, i}
										{#if i > 0}<span class="or">ou</span>{/if}
										<kbd>{k}</kbd>
									{/each}
								</td>
								<td class="label">{row.label}</td>
							</tr>
						{/each}
					</tbody>
				</table>
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
	.shortcuts-sheet {
		min-width: min(28rem, 80vw);
		max-height: 70vh;
		overflow-y: auto;
	}
	.hint {
		font-size: 0.85em;
		opacity: 0.7;
		margin: 0 0 0.75em;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	tr + tr td {
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}
	td {
		padding: 0.45em 0.5em;
		vertical-align: middle;
	}
	.keys {
		white-space: nowrap;
		width: 1%;
	}
	.or {
		font-size: 0.75em;
		opacity: 0.6;
		margin: 0 0.35em;
	}
	kbd {
		display: inline-block;
		min-width: 1.6em;
		text-align: center;
		padding: 0.15em 0.45em;
		border-radius: 0.3em;
		border: 1px solid rgba(255, 255, 255, 0.35);
		border-bottom-width: 2px;
		background: rgba(255, 255, 255, 0.08);
		font-family: inherit;
		font-size: 0.9em;
	}
	.label {
		opacity: 0.9;
	}
</style>
