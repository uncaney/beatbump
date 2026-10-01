<script lang="ts">
	import { browser } from "$app/environment";
	import Modal from "$components/Modal";
	import Icon from "$lib/components/Icon/Icon.svelte";

	import CreatePlaylist from "$lib/components/PlaylistPopper/CreatePlaylist.svelte";
	import { IDBService } from "$lib/workers/db/service";

	import Button from "$components/Button";
	import { exportDB, importDB } from "$lib/db";
	import type { IDBPlaylist } from "$lib/workers/db/types";
	import type { Item } from "$lib/types";
	import { onMount, setContext } from "svelte";
	import Sync from "./_Sync.svelte";
	import Grid from "./_components/Grid/Grid.svelte";
	import CollectionNav from "./_CollectionNav.svelte";

	let playlists: IDBPlaylist[] = [];

	let showSyncModal = false;
	let showPlaylistModal = false;
	let showImportModal = false;
	let files: FileList;

	setContext("library", { isLibrary: true });

	// "Delete All Playlists" asks for an inline confirmation first (audit F19).
	let confirmDeleteAll = false;
	let deletingAll = false;

	async function deleteAllPlaylists() {
		if (deletingAll) return;
		deletingAll = true;
		try {
			await IDBService.sendMessage("delete", "playlists");
			await updatePlaylists();
		} finally {
			deletingAll = false;
			confirmDeleteAll = false;
		}
	}

	const updatePlaylists = async () => {
		playlists = (await IDBService.sendMessage("get", "playlists")) || [];
		playlists = [...playlists];
		return playlists;
	};

	const readFiles = (files: FileList) => {
		if (files) {
			importDB(files[0]).then(() => {
				updatePlaylists();
			});
		}
	};
	$: if (files) readFiles(files);

	async function loadLibrary() {
		try {
			playlists = (await IDBService.sendMessage("get", "playlists")) || [];
			return { playlists };
		} catch (err) {
			console.error(err);
			return { playlists: [] as IDBPlaylist[] };
		}
	}

	onMount(() => {
		loadLibrary();
	});
</script>

{#if showSyncModal && browser}
	<Sync
		on:close={() => {
			updatePlaylists();
			showSyncModal = false;
		}}
	/>
{/if}

{#if showImportModal}
	<Modal
		zIndex={500}
		on:close={() => {
			showImportModal = false;
		}}
		hasFocus={showImportModal}
	>
		<h1 slot="header">Import your data</h1>
		<div class="container">
			<input
				type="file"
				name="import"
				id="import"
				accept=".json"
				bind:files
			/>
			<p>Import your data using the form above!</p>
		</div>
	</Modal>
{/if}

<main class="resp-content-width">
	<!-- The chips are the only navigation: the 9 hub cards that used to follow
	     them (audit v3 3.8, double navigation) pointed at destinations the chips
	     already list, "Ton mois" and "Hors-ligne" included. -->
	<CollectionNav active="playlists" />

	<header>
		<h1>Your Library</h1>
		<button
			on:click={() => {
				showSyncModal = true;
			}}
			><Icon
				name="send"
				size="1.1em"
			/>
			<span class="btn-text">Sync Your Data</span></button
		>
		<div style="margin-block-start: 0.5em;">
			<Button
				outlined
				class="btn-reset"
				on:click={async () => {
					try {
						exportDB();
					} catch (err) {
						console.error(err);
					}
				}}
				><Icon
					name="upload"
					size="1.1em"
				/>
				<span class="btn-text">Export Data</span></Button
			>
			<Button
				outlined
				class="btn-reset"
				on:click={() => {
					showImportModal = true;
				}}
				><Icon
					name="download"
					size="1.1em"
				/>
				<span class="btn-text">Import Data</span></Button
			>
		</div>
	</header>


	{#if showPlaylistModal}
		<CreatePlaylist
			defaults={{
				description: undefined,
				name: undefined,
				thumbnail: undefined,
			}}
			hasFocus={true}
			on:submit={async (e) => {
				await IDBService.sendMessage("create", "playlist", {
					name: e.detail?.title,
					description: e.detail?.description,
					thumbnail:
						e.detail?.thumbnail ??
						"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHN0eWxlPSJpc29sYXRpb246aXNvbGF0ZSIgdmlld0JveD0iMCAwIDI1NiAyNTYiIHdpZHRoPSIyNTZwdCIgaGVpZ2h0PSIyNTZwdCI+PGRlZnM+PGNsaXBQYXRoIGlkPSJwcmVmaXhfX2EiPjxwYXRoIGQ9Ik0wIDBoMjU2djI1NkgweiIvPjwvY2xpcFBhdGg+PC9kZWZzPjxnIGNsaXAtcGF0aD0idXJsKCNwcmVmaXhfX2EpIj48cGF0aCBmaWxsPSIjNDI0MjQyIiBkPSJNMCAwaDI1NnYyNTZIMHoiLz48ZyBjbGlwLXBhdGg9InVybCgjcHJlZml4X19iKSI+PHRleHQgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTA1LjU0IDE2Ni43OTQpIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LCZxdW90O1NlZ29lIFVJJnF1b3Q7LFJvYm90byxPeHlnZW4sVWJ1bnR1LENhbnRhcmVsbCwmcXVvdDtPcGVuIFNhbnMmcXVvdDssJnF1b3Q7SGVsdmV0aWNhIE5ldWUmcXVvdDssc2Fucy1zZXJpZiIgZm9udC13ZWlnaHQ9IjQwMCIgZm9udC1zaXplPSIxMDAiIGZpbGw9IiNmYWZhZmEiPj88L3RleHQ+PC9nPjxkZWZzPjxjbGlwUGF0aCBpZD0icHJlZml4X19iIj48cGF0aCB0cmFuc2Zvcm09InRyYW5zbGF0ZSg5MiA1NC44MzkpIiBkPSJNMCAwaDcydjE0Ni4zMjNIMHoiLz48L2NsaXBQYXRoPjwvZGVmcz48L2c+PC9zdmc+",
					items: [],
				});
				await updatePlaylists();
				showPlaylistModal = false;
			}}
			on:close={() => {
				showPlaylistModal = false;
			}}
		/>
	{/if}
	<section>
		<Grid
			heading="Your Playlists"
			items={playlists}
			on:new_playlist={() => {
				showPlaylistModal = true;
			}}
		>
			<div
				slot="buttons"
				class="delete-all"
			>
				{#if confirmDeleteAll}
					<span
						class="confirm-text"
						role="alert"
						>Supprimer toutes les playlists ({playlists.length}) ? Cette action est définitive.</span
					>
					<button
						type="button"
						style="margin-top:0.75em;"
						data-testid="confirm-delete-all"
						disabled={deletingAll}
						on:click={deleteAllPlaylists}>Confirmer la suppression</button
					>
					<button
						type="button"
						class="outlined"
						style="margin-top:0.75em;"
						data-testid="cancel-delete-all"
						disabled={deletingAll}
						on:click={() => (confirmDeleteAll = false)}>Annuler</button
					>
				{:else if playlists.length > 0}
					<!-- Audit v8 TOP 10: no disabled button under an empty "Your Playlists". -->
					<button
						type="button"
						class="outlined"
						style="margin-top:0.75em;"
						data-testid="delete-all-playlists"
						disabled={playlists.length === 0}
						on:click={() => (confirmDeleteAll = true)}
						><Icon
							name="x"
							size="1.1em"
						/><span class="btn-text">Delete All Playlists</span></button
					>
				{/if}
			</div></Grid
		>
	</section>
</main>

<style lang="scss">
	section:not(:last-of-type) {
		margin-top: 1rem;
		margin-bottom: 4.5rem;
	}

	// "Delete All Playlists" disabled (no playlist) looked identical to the
	// active "Export Data" (audit v4 3.4 / TOP 10): the global %button-base
	// pins opacity: 1 !important on :disabled, hence the !important here.
	button.outlined:disabled {
		opacity: 0.45 !important;
		cursor: not-allowed;
	}

	.list {
		min-height: 15%;
		margin-bottom: 1rem;
	}

	button {
		gap: 0.25rem;
	}

	.delete-all {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.confirm-text {
		width: 100%;
		color: var(--text-secondary);
		font-size: 0.9em;
	}

	header {
		display: inline;
	}
	// .playlist-container {
	// 	gap: 0.8rem;gap
	// }

	.image {
		min-width: 100%;
		max-width: 12rem;
		width: 100%;
		height: 100%;

		img {
			height: inherit;
			width: inherit;
			max-width: inherit;
			max-height: inherit;
		}
	}

	.loading,
	.loader {
		position: relative;
	}

	.loader {
		height: 3em;
	}

	main {
		min-height: 100%;
	}

	.loading {
		display: grid;
		// background-color: red;background-color
		max-width: 32em;
		position: absolute;
		max-height: 8em;
		margin: 0 auto;
		text-align: center;
		font-size: 1.4em;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
	}
</style>
