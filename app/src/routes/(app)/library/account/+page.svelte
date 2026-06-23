<script lang="ts">
	import { whoami, login, logout } from "$lib/me";
	import { onMount } from "svelte";
	import CollectionNav from "../_CollectionNav.svelte";

	let name = "";
	let current = "";
	let loading = true;
	let busy = false;
	let msg = "";

	async function refresh() {
		const w = await whoami();
		current = w.name || "";
		loading = false;
	}
	onMount(refresh);

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

<main>
	<CollectionNav active="account" />
	<h1>Account</h1>

	{#if loading}
		<p class="state">Loading…</p>
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
			<button
				class="btn primary"
				type="submit"
				disabled={busy || !name.trim()}>{current ? "Switch profile" : "Sign in"}</button
			>
			{#if current}
				<button
					class="btn"
					type="button"
					on:click={doLogout}
					disabled={busy}>Sign out</button
				>
			{/if}
		</form>

		{#if msg}<p class="msg">{msg}</p>{/if}
		<p class="note">
			Profiles are name-based (no password) — same name = same library. Anyone on the instance can use any
			name; this is meant for a trusted/household instance.
		</p>
	{/if}
</main>

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
		max-width: 40rem;
	}
	.who {
		margin: 0.5rem 0 1rem;
		font-size: 1.05rem;
	}
	.row {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	input {
		flex: 1 1 12rem;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 0.4rem;
		color: inherit;
		padding: 0.5rem 0.7rem;
		font-size: 1rem;
	}
	.btn {
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 0.4rem;
		color: inherit;
		padding: 0.5rem 1rem;
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent, #1ed760);
		color: #000;
		border-color: transparent;
		font-weight: 600;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.msg {
		margin-top: 1rem;
		color: var(--accent, #1ed760);
	}
	.note {
		margin-top: 1.5rem;
		color: #999;
		font-size: 0.9rem;
	}
	.state {
		color: #999;
	}
</style>
