<script
	context="module"
	lang="ts"
>
</script>

<script lang="ts">
	import { browser } from "$app/environment";
	import Header from "$components/Layouts/Header.svelte";
	import { settings, type Theme } from "$stores/settings";
	import { continueAfterQueue } from "$lib/stores/list/localContinuation";
	import OfflineSettings from "./OfflineSettings.svelte";
	import { installPrompt, isInstalled, isIOS, promptInstall } from "$lib/stores/pwa";
	import { notify } from "$lib/utils";
	const themes: Theme[] = ["Dark", "Dim", "Midnight", "YTM"];

	// PWA install (Settings > Application). States: installed (standalone or
	// just installed) -> no button; Chromium fired beforeinstallprompt -> button;
	// iOS -> Share > Add to Home Screen hint; otherwise -> browser-menu hint.
	let installing = false;
	const install = async () => {
		if (installing) return;
		installing = true;
		try {
			const outcome = await promptInstall();
			if (outcome === "accepted") notify("Application installée", "success");
		} finally {
			installing = false;
		}
	};

	// F14: the commented-out Quality / Stream / Network / Search / Restricted
	// controls (~150 lines of dead HTML and an empty <section> in the DOM) were
	// removed; their settings keys stay in the store with their defaults.
	// The legacy "Download Path" / "Ongoing Listening Download" controls
	// (backend /api/v1/settings keys downloadPath / ongoingListeningEnabled) were
	// removed from this page: every played track is already cached by the
	// service worker, and the single switch for that lives in Settings > Offline
	// (OfflineSettings.svelte, settings.offline.autoCache). The backend keys are
	// untouched and keep their defaults.
</script>

<Header
	title="Settings"
	url="/settings"
	desc="Configure your app settings"
/>
{#if browser}
	<main class="resp-content-width">
		<section>
			<span class="h5">Appearance</span>
			<div class="setting">
				<label for="theme">Theme </label>
				<div class="select">
					<select
						name="theme"
						id="theme"
						bind:value={$settings["appearance"]["Theme"]}
					>
						{#each themes as theme}
							<option
								value={theme}
								selected={$settings["appearance"]["Theme"] === theme}
								>{theme}</option
							>
						{/each}
					</select>
				</div>
			</div>
			<div class="setting">
				<!-- svelte-ignore a11y-label-has-associated-control -->
				<label
					>Immersive Queue
					<span class="help"
						>Affiche la file en plein écran avec la pochette en fond</span
					>
				</label>
				<input
					type="checkbox"
					name="immersive-queue"
					id="immersive-queue"
					bind:checked={$settings["appearance"]["Immersive Queue"]}
				/>
				<label
					for="immersive-queue"
					class="switch"
				/>
			</div>
		</section>
		<section>
			<span class="h5">Playback</span>
			<div class="setting">
				<!-- svelte-ignore a11y-label-has-associated-control -->
				<label
					>Continuer après la fin de la file
					<span class="help"
						>À la fin d'une file locale, enchaîne des titres proches de ta bibliothèque</span
					>
				</label>
				<input
					name="continue-after-queue"
					id="continue-after-queue"
					type="checkbox"
					data-testid="setting-continue-after-queue"
					bind:checked={$continueAfterQueue}
				/>
				<label
					for="continue-after-queue"
					class="switch"
				/>
			</div>
			<div class="setting">
				<!-- svelte-ignore a11y-label-has-associated-control -->
				<label
					>Dedupe Automix
					<span class="help"
						>Évite les doublons dans les mixes automatiques</span
					>
				</label>

				<input
					name="dedupe"
					id="dedupe"
					type="checkbox"
					bind:checked={$settings["playback"]["Dedupe Automix"]}
				/>
				<label
					for="dedupe"
					class="switch"
				/>
			</div>
			<div class="setting">
                <!-- Audit v7 item 10: the help sits under the title like the
                     other rows (was a full-width <p> under the switch). -->
                <label for="lasttrack"
                    >Remember Last Track
                    <span class="help"
                        >À la réouverture, la file et la position reviennent telles quelles, en pause</span
                    >
                </label>
                <input
                    name="lasttrack"
                    id="lasttrack"
                    type="checkbox"
                    bind:checked={$settings["playback"]["Remember Last Track"]}
                />
                <label
                    for="lasttrack"
                    class="switch"
                />
            </div>
		</section>
		<OfflineSettings />
		<section
			id="settings-app"
			aria-labelledby="app-heading"
		>
			<span
				class="h5"
				id="app-heading">Application</span
			>
			<div class="setting">
				<!-- svelte-ignore a11y-label-has-associated-control -->
				<label id="pwa-install-label">
					Installer l'application
					<span
						id="pwa-install-desc"
						aria-live="polite"
					>
						{#if $isInstalled}
							L'application est installée sur cet appareil.
						{:else if $installPrompt}
							Ajoute-la à l'écran d'accueil : elle s'ouvre en plein écran et
							garde ta musique hors ligne.
						{:else if $isIOS}
							Sur iPhone : Partager > Sur l'écran d'accueil.
						{:else}
							Si ton navigateur le propose, l'installation se fait depuis son
							menu (Chrome : « Installer l'application »).
						{/if}
					</span>
				</label>
				{#if !$isInstalled && $installPrompt}
					<button
						type="button"
						id="pwa-install"
						class="btn"
						aria-describedby="pwa-install-desc"
						disabled={installing}
						on:click={install}
					>
						{installing ? "Installation…" : "Installer l'application"}
					</button>
				{/if}
			</div>
		</section>
		<section
			id="settings-about"
			aria-labelledby="about-heading"
		>
			<span
				class="h5"
				id="about-heading">À propos</span
			>
			<div class="setting">
				<!-- svelte-ignore a11y-label-has-associated-control -->
				<label>
					État de l'application
					<span class="help">Taille de la bibliothèque, version, service worker, stockage persistant</span>
				</label>
				<a
					class="btn"
					href="/about"
					data-testid="settings-about">À propos / État</a
				>
			</div>
		</section>
	</main>
{/if}

<style lang="scss">
	button {
		background: unset;
		all: unset;
		margin-top: 0.5rem;
		$link-color: rgb(245, 245, 245);
		color: rgb(245, 245, 245) !important;

		text-decoration: none;
		transition: color 0.2s;
		display: block;
		&.link {
			font-weight: 500;
		}
		&:active,
		&:focus,
		&:hover {
			background: transparent !important;
			-webkit-text-decoration: underline 0.001em solid;
			text-decoration: underline 0.001em solid;
			text-underline-offset: 0.001em;
			color: darken($link-color, 15%);
			outline: none;
		}
		&:hover {
			cursor: pointer;
		}
	}
	label {
		display: inline-flex;
		flex-direction: column;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
			Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue",
			sans-serif;
		font-size: 1em;
		text-transform: none !important;
		font-variant: unset;
		gap: 0.125em;
		line-height: 1.4;
		:last-child {
			font-size: 0.875em;
			color: hsla(0, 0%, 100%, 0.7);
			line-height: 1.1;
		}

		@media screen and (min-width: 40em) {
			~ :last-child {
				margin-left: auto;
			}
		}
	}

	section {
		display: flex;
		flex-direction: column;
		margin-block-end: 1em;

		&:not(:last-child) {
			border-bottom: 0.01em solid rgb(218 218 218 / 8.2%);
		}
	}

	.setting {
		display: inline-flex;
		color: inherit;
		vertical-align: top;
		gap: 1em;
		flex-direction: column;
		margin-block: 1em;

		&:first-of-type {
			margin-block-start: 0;
		}

		&:last-of-type {
			margin-block-end: 2em;
		}

		@media screen and (min-width: 40em) {
			align-items: center;
			flex-direction: row;
		}
	}

	.switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		width: 3.8125em;
		height: 2em;
		cursor: pointer;
		overflow: hidden;
		background-color: rgb(109 109 109 / 35%);
		border-radius: 1.25rem;
		transition: background-color 0.3s;
	}

	.switch::after {
		--size: calc(2rem - (2px * 2));

		content: "";
		position: absolute;
		width: var(--size);
		height: var(--size);
		border-radius: 9999em;
		background-color: white;
		top: 50%;
		transform: translateY(-50%);
		left: 0.125em;
		transition: left 0.3s;
		box-shadow: 0 0 12px -3px rgb(0 0 0 / 38.4%);
	}

	[type="checkbox"]:checked + .switch::after {
		left: 2em;
	}

	[type="checkbox"]:checked + .switch {
		background-color: #00cd6a;
	}

	[type="checkbox"] {
		display: none;
	}

	/* Same button as Settings > Offline (OfflineSettings.svelte .btn). */
	.btn {
		all: unset;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 2.75rem;
		min-width: 2.75rem;
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		font: inherit;
		font-weight: 500;
		color: #f2f2f2 !important;
		background: rgb(255 255 255 / 10%);
		cursor: pointer;
		transition: background-color 0.15s;

		&:hover:not(:disabled) {
			background: rgb(255 255 255 / 18%);
			color: #fff !important;
		}
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
		&:disabled {
			opacity: 1;
			color: #9a9a9a !important;
			background: rgb(44, 44, 44) !important;
			border: 1px solid rgba(255, 255, 255, 0.25);
			cursor: not-allowed;
		}
	}
</style>
