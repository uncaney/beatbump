<script lang="ts">
	// ST2 "À propos / État": what this instance holds and how this device is
	// doing (served version, service worker, persistent storage), plus a way
	// to report a problem. Everything is best effort: a failed probe shows
	// "inconnu" rather than an error page.
	import { browser } from "$app/environment";
	import Header from "$components/Layouts/Header.svelte";
	import { APIClient } from "$lib/api";
	import { storageStatus } from "$lib/offline";
	import { onMount } from "svelte";

	interface LibraryStats {
		tracks: number;
		albums: number;
		artists: number;
		lastAdded: string;
		version: string;
	}

	let stats: LibraryStats | null = null;
	let statsError = false;
	let servedVersion = "";
	let swSupported = false;
	let swController = false;
	let swWaiting = false;
	let persisted: boolean | null = null;
	let usage = 0;
	let quota = 0;
	let probing = true;

	const fmtInt = (n: number) => new Intl.NumberFormat("fr-FR").format(Math.round(n || 0));
	const fmtBytes = (b: number) => {
		if (!b) return "0 Mo";
		const mb = b / (1024 * 1024);
		return mb >= 1024 ? `${(mb / 1024).toFixed(1)} Go` : `${Math.round(mb)} Mo`;
	};
	const fmtDate = (iso: string) => {
		if (!iso) return "inconnu";
		const d = new Date(iso);
		return isNaN(d.getTime()) ? iso : d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
	};

	async function loadStats() {
		try {
			const res = await APIClient.fetch("/api/v1/stats/library");
			if (!res.ok) throw new Error(String(res.status));
			stats = await res.json();
		} catch {
			statsError = true;
		}
	}

	async function loadServedVersion() {
		try {
			const res = await fetch("/_app/version.json", { cache: "no-store" });
			const j = res.ok ? await res.json() : null;
			servedVersion = typeof j?.version === "string" ? j.version : "";
		} catch {
			servedVersion = "";
		}
	}

	async function probeServiceWorker() {
		try {
			swSupported = "serviceWorker" in navigator;
			if (!swSupported) return;
			swController = !!navigator.serviceWorker.controller;
			const reg = await navigator.serviceWorker.getRegistration();
			swWaiting = !!reg?.waiting;
		} catch {
			/* unknown */
		}
	}

	async function probeStorage() {
		const s = await storageStatus();
		persisted = s.persisted;
		usage = s.usage;
		quota = s.quota;
	}

	onMount(async () => {
		await Promise.all([loadStats(), loadServedVersion(), probeServiceWorker(), probeStorage()]);
		probing = false;
	});
</script>

<Header
	title="À propos"
	url="/about"
	desc="État de l'application et de la bibliothèque"
/>

{#if browser}
	<main
		class="resp-content-width"
		data-testid="about-page"
	>
		<h1>À propos / État</h1>

		<section aria-labelledby="about-library">
			<h2 id="about-library">Bibliothèque</h2>
			{#if statsError}
				<p class="state">Impossible de lire l'état de la bibliothèque.</p>
			{:else if !stats}
				<p class="state">Chargement…</p>
			{:else}
				<div
					class="tiles"
					data-testid="about-library-stats"
				>
					<div class="tile">
						<span class="num">{fmtInt(stats.tracks)}</span>
						<span class="lbl">{stats.tracks > 1 ? "titres" : "titre"}</span>
					</div>
					<div class="tile">
						<span class="num">{fmtInt(stats.albums)}</span>
						<span class="lbl">{stats.albums > 1 ? "albums" : "album"}</span>
					</div>
					<div class="tile">
						<span class="num">{fmtInt(stats.artists)}</span>
						<span class="lbl">{stats.artists > 1 ? "artistes" : "artiste"}</span>
					</div>
				</div>
				<dl class="facts">
					<dt>Dernier ajout</dt>
					<dd data-testid="about-last-added">{fmtDate(stats.lastAdded)}</dd>
				</dl>
			{/if}
		</section>

		<section aria-labelledby="about-app">
			<h2 id="about-app">Application</h2>
			<dl
				class="facts"
				aria-busy={probing}
			>
				<dt>Version du serveur</dt>
				<dd data-testid="about-server-version">{stats?.version ?? (statsError ? "inconnue" : "…")}</dd>
				<dt>Version servie (app)</dt>
				<dd data-testid="about-served-version">{servedVersion || (probing ? "…" : "inconnue")}</dd>
				<dt>Service worker</dt>
				<dd data-testid="about-sw">
					{#if !swSupported}
						non pris en charge
					{:else if swWaiting}
						mise à jour en attente (recharge l'application pour l'appliquer)
					{:else if swController}
						actif
					{:else}
						pas encore actif (première visite ou mode privé)
					{/if}
				</dd>
				<dt>Stockage persistant</dt>
				<dd data-testid="about-storage">
					{#if persisted === true}
						protégé
					{:else if persisted === false}
						non protégé (le navigateur peut vider la musique hors-ligne)
					{:else}
						inconnu
					{/if}
					{#if quota > 0}
						<span class="muted">· {fmtBytes(usage)} utilisés sur {fmtBytes(quota)}</span>
					{/if}
				</dd>
			</dl>
			<p class="hint">Le stockage hors-ligne se règle dans <a href="/settings">Réglages</a>.</p>
		</section>

		<section aria-labelledby="about-help">
			<h2 id="about-help">Un souci ?</h2>
			<p class="hint">
				Les erreurs de lecture sont remontées automatiquement au serveur (sans donnée de profil). Pour le reste :
			</p>
			<a
				class="btn-secondary"
				data-testid="about-report"
				href="mailto:?subject={encodeURIComponent('music.ekaii.fr : problème')}&body={encodeURIComponent(
					`Version serveur : ${stats?.version ?? '?'}\nVersion app : ${servedVersion || '?'}\nPage : ${browser ? location.href : ''}\n\nDescription :\n`,
				)}">Signaler un problème</a
			>
		</section>
	</main>
{/if}

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	h1 {
		margin: 0 0 1rem;
	}
	h2 {
		margin: 1.25rem 0 0.5rem;
		font-size: 1.1rem;
	}
	section:not(:last-child) {
		padding-bottom: 1rem;
		border-bottom: 1px solid rgba(218, 218, 218, 0.08);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.6rem;
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.9rem 0.8rem;
		min-height: max(2.75rem, 44px);
		border-radius: 0.6rem;
		background: rgba(255, 255, 255, 0.07);
		border: 1px solid rgba(255, 255, 255, 0.1);
	}
	.num {
		font-size: 1.6rem;
		font-weight: 700;
		line-height: 1.1;
		overflow-wrap: anywhere;
	}
	.lbl {
		color: #bbb;
		font-size: 0.85rem;
	}
	.facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.4rem 1rem;
		margin: 0.75rem 0 0;
	}
	dt {
		color: #999;
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.muted {
		color: #999;
	}
	.state,
	.hint {
		color: #999;
		margin: 0.5rem 0;
	}
	.hint a {
		color: inherit;
		text-decoration: underline;
	}
	a.btn-secondary {
		text-decoration: none;
		margin-top: 0.5rem;
	}
	@media screen and (max-width: 37em) {
		.tiles {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.num {
			font-size: 1.25rem;
		}
		.facts {
			grid-template-columns: 1fr;
			gap: 0.15rem 0;
		}
		dd {
			margin-bottom: 0.5rem;
		}
	}
</style>
