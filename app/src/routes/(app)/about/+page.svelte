<script lang="ts">
	// ST2 "À propos / État": what this instance holds and how this device is
	// doing (served version, service worker, persistent storage), plus a way
	// to report a problem. Everything is best effort: a failed probe shows
	// "inconnu" rather than an error page.
	import { browser } from "$app/environment";
	import Header from "$components/Layouts/Header.svelte";
	import { APIClient } from "$lib/api";
	import { requestPersistentStorage, storageStatus } from "$lib/offline";
	import { formatBytesFr, formatIntFr } from "$lib/utils/formatFr";
	import { onMount } from "svelte";

	interface LibraryStats {
		tracks: number;
		albums: number;
		artists: number;
		lastAdded: string;
		version: string;
		/** F13: YTM_REPORT_EMAIL on the server; absent = no recipient. */
		reportEmail?: string;
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
	// UX6: "Protéger le stockage" (same call as Réglages > Hors-ligne,
	// OfflineSettings.svelte). `protectResult` is the last answer of the
	// browser, shown under the button: "" = not asked yet.
	let protectBusy = false;
	let protectResult: "" | "granted" | "denied" | "unsupported" = "";
	// F13: "Copier le diagnostic" feedback (no recipient configured).
	let copied: "" | "ok" | "fail" = "";
	let copiedTimer: ReturnType<typeof setTimeout>;

	/** The diagnostic block: what a report needs, no profile data. */
	const diagText = () =>
		`Version serveur : ${stats?.version ?? "?"}\nBuild app : ${servedVersion || "?"}\nPage : ${
			browser ? location.pathname : ""
		}\nService worker : ${!swSupported ? "non pris en charge" : swWaiting ? "mise à jour en attente" : swController ? "actif" : "inactif"}\nStockage persistant : ${
			persisted === null ? "inconnu" : persisted ? "oui" : "non"
		}\nNavigateur : ${browser ? navigator.userAgent : ""}\n\nDescription :\n`;

	$: reportHref = stats?.reportEmail
		? `mailto:${stats.reportEmail}?subject=${encodeURIComponent("music.ekaii.fr : problème")}&body=${encodeURIComponent(diagText())}`
		: "";

	async function copyDiag() {
		const text = diagText();
		let ok = false;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				ok = true;
			}
		} catch {
			ok = false;
		}
		if (!ok) {
			// Fallback (http origin, old WebView): a hidden textarea + execCommand.
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.setAttribute("readonly", "");
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				ok = document.execCommand("copy");
				ta.remove();
			} catch {
				ok = false;
			}
		}
		copied = ok ? "ok" : "fail";
		clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied = ""), 2500);
	}

	// c31a: one French formatter for sizes and numbers ("1,2 Go", "1 234").
	const fmtInt = formatIntFr;
	const fmtBytes = formatBytesFr;
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

	async function protectStorage() {
		if (protectBusy) return;
		protectBusy = true;
		try {
			const r = await requestPersistentStorage(true);
			await probeStorage();
			protectResult = r === true || persisted === true ? "granted" : r === null ? "unsupported" : "denied";
		} finally {
			protectBusy = false;
		}
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
				<!-- UX6: the server short SHA (stats/library `version`, main.version)
				     is THE version; the SvelteKit build id (/_app/version.json, a
				     timestamp) is only a secondary "build" line. -->
				<dt>Version</dt>
				<dd>
					<span data-testid="about-server-version">{stats?.version ?? (statsError ? "inconnue" : "…")}</span>
					<span class="build muted"
						>build <span data-testid="about-served-version">{servedVersion || (probing ? "…" : "inconnu")}</span></span
					>
				</dd>
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
			{#if persisted === false || protectResult}
				<div
					class="protect"
					data-testid="about-protect-block"
				>
					<p class="hint">
						Sans protection, le navigateur peut effacer la musique hors-ligne quand l'appareil manque de place.
					</p>
					{#if persisted !== true}
						<button
							type="button"
							class="btn-secondary"
							data-testid="about-protect"
							disabled={protectBusy}
							on:click={protectStorage}>{protectBusy ? "Demande en cours…" : "Protéger le stockage"}</button
						>
					{/if}
					{#if protectResult}
						<p
							class="protect-state"
							data-testid="about-protect-state"
							data-result={protectResult}
							role="status"
						>
							{#if protectResult === "granted"}
								Stockage protégé : la musique hors-ligne ne sera plus effacée.
							{:else if protectResult === "denied"}
								Le navigateur a refusé : installe l'app sur l'écran d'accueil puis réessaie.
							{:else}
								Ce navigateur ne permet pas de protéger le stockage.
							{/if}
						</p>
					{/if}
				</div>
			{/if}
			<p class="hint">Le stockage hors-ligne se règle dans <a href="/settings">Réglages</a>.</p>
		</section>

		<section aria-labelledby="about-help">
			<h2 id="about-help">Un souci ?</h2>
			<p class="hint">
				Les erreurs de lecture sont remontées automatiquement au serveur (sans donnée de profil). Pour le reste :
			</p>
			{#if reportHref}
				<!-- F13: a recipient is configured (YTM_REPORT_EMAIL): a real mailto. -->
				<a
					class="btn-secondary"
					data-testid="about-report"
					href={reportHref}>Signaler un problème</a
				>
			{:else}
				<!-- No recipient: copy the diagnostic block to paste wherever the
				     user reaches the operator (message, chat), instead of a mailto
				     that opens an empty composer. -->
				<button
					type="button"
					class="btn-secondary"
					data-testid="about-copy-diag"
					aria-live="polite"
					on:click={copyDiag}
				>
					{#if copied === "ok"}
						Diagnostic copié
					{:else if copied === "fail"}
						Copie impossible, sélectionne le texte ci-dessous
					{:else}
						Copier le diagnostic
					{/if}
				</button>
				{#if copied === "fail"}
					<pre
						class="diag"
						data-testid="about-diag-text">{diagText()}</pre>
				{/if}
			{/if}
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
		/* U12-11: 0.85rem was 10.2 px at the 12 px mobile root. */
		font-size: var(--text-secondary-size);
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
	.build {
		display: block;
		font-size: var(--text-secondary-size);
	}
	.protect {
		margin-top: 0.75rem;
	}
	.protect-state {
		margin: 0.5rem 0 0;
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
	a.btn-secondary,
	button.btn-secondary {
		text-decoration: none;
		margin-top: 0.5rem;
	}
	.diag {
		margin: 0.75rem 0 0;
		padding: 0.75rem;
		border-radius: 0.5rem;
		background: rgba(255, 255, 255, 0.06);
		font-size: var(--text-secondary-size);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		user-select: all;
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
