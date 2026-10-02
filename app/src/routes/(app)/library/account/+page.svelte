<script lang="ts">
	import MeOffline from "$components/Offline/MeOffline.svelte";
	import { migratedSummary, readMigration } from "$lib/identity";
	import { whoami, login, loginErrorText, logout } from "$lib/me";
	import { meLoadOffline } from "$lib/offline";
	import { DEVICE_NAME_MAX, guessedDeviceName, localDeviceName, saveLocalDeviceName } from "$lib/stores/nowPlayingSync";
	import { notify } from "$lib/utils/utils";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let name = "";
	let current = "";
	let loading = true;
	let busy = false;
	let msg = "";
	// H2: whoami unreachable offline; without this the page showed the guest
	// sign-in form as if the profile were gone.
	let offline = false;
	// 39A: what the last login moved from this device's anonymous history
	// (this page's login, or the identity prompt's, kept in localStorage).
	let attached = "";
	function readAttached(who: string) {
		const m = who ? readMigration() : null;
		attached = m && m.name.toLowerCase() === who.toLowerCase() ? migratedSummary(m.migrated, m.name) : "";
	}

	async function refresh() {
		let w: any = null;
		let err: unknown = undefined;
		try {
			w = await whoami();
		} catch (e) {
			err = e;
		}
		offline = meLoadOffline([w], err);
		if (!offline) {
			current = (w && w.name) || "";
			readAttached(current);
		}
		loading = false;
	}
	// 40A: the name of this device on the other devices' "Reprendre depuis"
	// card (localStorage, sent with each me/nowplaying push).
	let deviceName = "";
	let savedDeviceName = "";
	let guessedName = "";
	function saveDeviceName() {
		const r = saveLocalDeviceName(deviceName);
		if (r === null) {
			notify("Nom de l'appareil non enregistré : stockage indisponible.", "error");
			return;
		}
		if (r === savedDeviceName) {
			deviceName = r;
			return;
		}
		savedDeviceName = r;
		deviceName = r;
		notify(r ? `Cet appareil s'appelle maintenant « ${r} ».` : `Nom de l'appareil effacé : « ${guessedName} » sera affiché.`, "success");
	}

	onMount(() => {
		savedDeviceName = deviceName = localDeviceName();
		guessedName = guessedDeviceName();
		void refresh();
		const on = () => {
			if (offline) void refresh();
		};
		window.addEventListener("online", on);
		return () => window.removeEventListener("online", on);
	});

	async function doLogin() {
		if (busy || !name.trim()) return;
		busy = true;
		msg = "";
		try {
			const r = await login(name.trim());
			current = r.name;
			msg = `Connecté en tant que ${r.name}. Tes favoris, abonnements, playlists et ton historique suivent ce prénom sur tous tes appareils.`;
			// null (switching between two names): nothing was merged, keep the old line hidden.
			attached = r.migrated ? migratedSummary(r.migrated, r.name) : "";
			name = "";
		} catch (e) {
			// L14-6: a 503 busy (the name is being merged from another tab or
			// device, already retried once) says so; the name stays typed.
			msg = loginErrorText(e);
		}
		busy = false;
	}

	async function doLogout() {
		if (busy) return;
		busy = true;
		try {
			await logout();
			current = "";
			attached = "";
			msg = "Tu es passé sur un nouveau profil invité.";
		} catch (e) {
			// L10-8: the server kept the session: the profile stays as it was.
			console.error("logout failed", e);
			notify("Déconnexion impossible : vérifie le réseau et réessaie.", "error");
		}
		busy = false;
	}
</script>

<main class="resp-content-width">
	<CollectionNav active="account" />
	<h1>Compte</h1>
	<!-- Audit v8 TOP 9: the card belongs to this screen, under its h1. -->
	<a
		class="stats-card"
		href="/library/stats"
		data-testid="account-stats-link"
	>
		<span class="stats-title">Ton mois</span>
		<span class="stats-sub">Écoutes, minutes, top titres / artistes / albums sur 7, 30 ou 365 jours</span>
		<span class="stats-go" aria-hidden="true">›</span>
	</a>

	{#if loading}
		<p class="state">Chargement…</p>
	{:else if offline}
		<MeOffline text="Ton profil se lit sur le serveur : connexion et changement de profil reviennent avec le réseau." />
	{:else}
		<p class="who">
			{#if current}
				Connecté en tant que <strong>{current}</strong>.
			{:else}
				Tu es <strong>invité</strong> (cet appareil seulement). Choisis un prénom pour retrouver ta bibliothèque sur tous tes appareils.
			{/if}
		</p>

		<form
			class="row"
			on:submit|preventDefault={doLogin}
		>
			<input
				type="text"
				placeholder="Ton prénom (ex. paul)"
				bind:value={name}
				autocomplete="off"
			/>
			<!-- U11-2 (audit UX v11): the page's main action is the white
			     .btn-primary pill, the secondary one the translucent pill; the
			     local grey/green buttons looked disabled and sat outside the
			     button system. -->
			<button
				class="btn-primary"
				type="submit"
				disabled={busy || !name.trim()}>{current ? "Changer de profil" : "C'est moi"}</button
			>
			{#if current}
				<button
					class="btn-secondary"
					type="button"
					on:click={doLogout}
					disabled={busy}>Se déconnecter</button
				>
			{/if}
		</form>

		{#if msg}<p class="msg">{msg}</p>{/if}
		{#if current && attached}
			<p
				class="attached"
				data-testid="account-migrated"
			>
				<strong>Historique de cet appareil rattaché</strong> : {attached}.
			</p>
		{/if}
		<p class="note">
			Les profils reposent sur un prénom (sans mot de passe) · même prénom = même bibliothèque. Toute personne de l'instance peut
			utiliser n'importe quel prénom : c'est fait pour une instance de confiance (la maison, les amis).
		</p>
	{/if}

	<section
		class="device"
		aria-labelledby="device-title"
	>
		<h2 id="device-title">Cet appareil</h2>
		<form
			class="row"
			on:submit|preventDefault={saveDeviceName}
		>
			<label
				class="sr-only"
				for="device-name">Nom de cet appareil</label
			>
			<input
				id="device-name"
				type="text"
				data-testid="device-name"
				placeholder={`Ex. ${guessedName || "iPhone"} de ${current || "Camille"}`}
				maxlength={DEVICE_NAME_MAX}
				bind:value={deviceName}
				on:blur={saveDeviceName}
				autocomplete="off"
			/>
			<button
				class="btn-secondary"
				type="submit"
				data-testid="device-name-save">Enregistrer</button
			>
		</form>
		<p class="note">
			Ce nom s'affiche sur tes autres appareils : « Reprendre depuis {savedDeviceName || guessedName || "cet appareil"} ».
		</p>
	</section>

	<!-- B7-13: the install page, for a second phone or a friend (bare link, no PIN). -->
	<section
		class="device"
		aria-labelledby="bienvenue-title"
	>
		<h2 id="bienvenue-title">Chez un ami</h2>
		<p class="note">Les étapes d'installation sur iPhone et Android, un QR code et un bouton pour envoyer le lien.</p>
		<a
			class="btn-secondary bienvenue"
			href="/bienvenue"
			data-testid="account-bienvenue">Installer chez toi</a
		>
	</section>
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
		/* Same .resp-content-width column as the other library tabs (audit v8
		   TOP 9: the 40rem centred column read as another screen). */
	}
	.who {
		margin: 0.5rem 0 1rem;
		font-size: 1.05rem;
	}
	.stats-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas: "title go" "sub go";
		align-items: center;
		column-gap: 0.75rem;
		min-height: 44px;
		padding: 0.8rem 1rem;
		margin: 0 0 1.25rem;
		border-radius: 0.6rem;
		background: rgba(30, 215, 96, 0.12);
		border: 1px solid rgba(30, 215, 96, 0.35);
		color: inherit;
		text-decoration: none;
	}
	.stats-card:hover {
		background: rgba(30, 215, 96, 0.2);
	}
	.stats-title {
		grid-area: title;
		font-weight: 700;
		font-size: 1.1rem;
	}
	.stats-sub {
		grid-area: sub;
		color: #bbb;
		font-size: var(--text-secondary-size);
	}
	.stats-go {
		grid-area: go;
		font-size: 1.6rem;
		color: var(--accent, #1ed760);
	}
	.row {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	input {
		flex: 1 1 12rem;
		/* U11-6 (audit UX v11): 284x35 on mobile; same 44px floor as the pill. */
		box-sizing: border-box;
		min-height: max(2.75rem, 44px);
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 0.4rem;
		color: inherit;
		padding: 0.5rem 0.7rem;
		font-size: 1rem;
	}
	.msg {
		margin-top: 1rem;
		color: var(--accent, #1ed760);
	}
	.attached {
		margin-top: 0.75rem;
		color: #ccc;
	}
	.note {
		margin-top: 1.5rem;
		color: #999;
		font-size: var(--text-secondary-size);
	}
	.state {
		color: #999;
	}
	.device {
		margin-top: 2rem;
	}
	.device h2 {
		font-size: 1.1rem;
		margin: 0 0 0.5rem;
	}
	.device .note {
		margin-top: 0.5rem;
	}
	a.bienvenue {
		display: inline-flex;
		align-items: center;
		margin-top: 0.5rem;
		text-decoration: none;
	}
</style>
