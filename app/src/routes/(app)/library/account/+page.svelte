<script lang="ts">
	import MeOffline from "$components/Offline/MeOffline.svelte";
	import { whoami, login, logout } from "$lib/me";
	import { meLoadOffline } from "$lib/offline";
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

	async function refresh() {
		let w: any = null;
		let err: unknown = undefined;
		try {
			w = await whoami();
		} catch (e) {
			err = e;
		}
		offline = meLoadOffline([w], err);
		if (!offline) current = (w && w.name) || "";
		loading = false;
	}
	onMount(() => {
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
			msg = `Signed in as ${r.name}. Your favourites, follows, playlists and history are now tied to this name on any device.`;
			name = "";
		} catch (e) {
			msg = "Login failed.";
		}
		busy = false;
	}

	async function doLogout() {
		busy = true;
		await logout();
		current = "";
		msg = "Switched to a fresh guest profile.";
		busy = false;
	}
</script>

<main class="resp-content-width">
	<CollectionNav active="account" />
	<h1>Account</h1>
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
		<p class="state">Loading…</p>
	{:else if offline}
		<MeOffline text="Ton profil se lit sur le serveur : connexion et changement de profil reviennent avec le réseau." />
	{:else}
		<p class="who">
			{#if current}
				Signed in as <strong>{current}</strong>.
			{:else}
				You're a <strong>guest</strong> (this device only). Pick a name to sync your library across devices.
			{/if}
		</p>

		<form
			class="row"
			on:submit|preventDefault={doLogin}
		>
			<input
				type="text"
				placeholder="Your name (e.g. paul)"
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
				disabled={busy || !name.trim()}>{current ? "Switch profile" : "Sign in"}</button
			>
			{#if current}
				<button
					class="btn-secondary"
					type="button"
					on:click={doLogout}
					disabled={busy}>Sign out</button
				>
			{/if}
		</form>

		{#if msg}<p class="msg">{msg}</p>{/if}
		<p class="note">
			Profiles are name-based (no password) · same name = same library. Anyone on the instance can use any
			name; this is meant for a trusted/household instance.
		</p>
	{/if}
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
	.note {
		margin-top: 1.5rem;
		color: #999;
		font-size: var(--text-secondary-size);
	}
	.state {
		color: #999;
	}
</style>
