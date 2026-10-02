<script lang="ts">
	// B7-13 (lane c45a) "Installer chez toi": the one page to send a friend so
	// they install the app on their phone. What the app is in two lines, the
	// three install steps for the detected platform (iPhone: Safari > Partager
	// > Sur l'écran d'accueil; Android: Chrome > menu > Installer l'application;
	// both on a desktop), a QR code of the site (client-side, $lib/utils/qr, no
	// dependency) and "Envoyer à un ami" through the native share sheet (else
	// the link is copied, toast "Lien copié"). A bare link only: no PIN, no
	// invitation (decision 7). Reuses the Réglages > Application install state
	// ($lib/stores/pwa): Chromium's captured prompt becomes a real button here.
	import { browser } from "$app/environment";
	import Header from "$components/Layouts/Header.svelte";
	import Icon from "$components/Icon/Icon.svelte";
	import { installPrompt, isInstalled, isIOS, promptInstall } from "$lib/stores/pwa";
	import { notify } from "$lib/utils";
	import { darkModules, encodeQr, type QrMatrix } from "$lib/utils/qr";
	import { shareLink } from "$lib/utils/shareLink";
	import { onMount } from "svelte";

	type Platform = "ios" | "android" | "desktop";
	let platform: Platform = "desktop";
	// "Et sur Android ?" / "Et sur iPhone ?": the other platform's steps, for
	// someone reading this on their own phone to help a friend.
	let showOther = false;
	$: showIos = platform !== "android" || showOther;
	$: showAndroid = platform !== "ios" || showOther;

	// The bare site URL (origin + "/"): what the QR encodes and what the share
	// sheet sends. The friend lands on the home page; the install bar does the rest.
	let baseUrl = "";
	let qr: QrMatrix | null = null;
	let qrError = false;
	const QUIET = 4;
	$: dark = qr ? darkModules(qr) : [];

	let sharing = false;
	async function share() {
		if (sharing || !baseUrl) return;
		sharing = true;
		try {
			await shareLink({ title: "La musique de la maison", text: "Installe la musique de la maison sur ton téléphone :", url: baseUrl });
		} finally {
			sharing = false;
		}
	}

	let installing = false;
	async function install() {
		if (installing) return;
		installing = true;
		try {
			const outcome = await promptInstall();
			if (outcome === "accepted") notify("Application installée", "success");
		} finally {
			installing = false;
		}
	}

	onMount(() => {
		const ua = navigator.userAgent;
		platform = $isIOS ? "ios" : /Android/i.test(ua) ? "android" : "desktop";
		baseUrl = `${location.origin}/`;
		try {
			qr = encodeQr(baseUrl);
		} catch {
			qrError = true;
		}
	});
</script>

<Header
	title="Installer chez toi"
	url="/bienvenue"
	desc="La musique de la maison sur ton téléphone, hors-ligne, sans compte"
/>

{#if browser}
	<main
		class="resp-content-width"
		data-testid="bienvenue-page"
		data-platform={platform}
	>
		<h1>Installer chez toi</h1>
		<p class="pitch">
			Toute la musique de la maison, sur ton téléphone.<br />
			Elle s'écoute hors-ligne, sans compte ni mot de passe.
		</p>

		{#if $isInstalled}
			<p
				class="installed"
				role="status"
				data-testid="bienvenue-installed"
			>
				L'application est déjà installée sur cet appareil. Pour un ami : le QR code et le bouton plus bas.
			</p>
		{/if}

		{#if showIos}
			<section
				aria-labelledby="bienvenue-ios"
				data-testid="steps-ios"
			>
				<h2 id="bienvenue-ios">Sur iPhone</h2>
				<ol class="steps">
					<li><span class="n">1</span><span>Ouvre cette page dans <strong>Safari</strong>.</span></li>
					<li>
						<span class="n">2</span><span>Touche <strong>Partager</strong> (le carré avec la flèche, en bas de l'écran).</span>
					</li>
					<li><span class="n">3</span><span>Choisis <strong>Sur l'écran d'accueil</strong>, puis <strong>Ajouter</strong>.</span></li>
				</ol>
			</section>
		{/if}

		{#if showAndroid}
			<section
				aria-labelledby="bienvenue-android"
				data-testid="steps-android"
			>
				<h2 id="bienvenue-android">Sur Android</h2>
				{#if !$isInstalled && $installPrompt}
					<!-- Chromium already offered the install: one tap instead of three steps. -->
					<button
						type="button"
						class="btn-primary install"
						data-testid="bienvenue-install"
						disabled={installing}
						on:click={install}>{installing ? "Installation…" : "Installer l'application"}</button
					>
					<p class="hint">Ou à la main :</p>
				{/if}
				<ol class="steps">
					<li><span class="n">1</span><span>Ouvre cette page dans <strong>Chrome</strong>.</span></li>
					<li><span class="n">2</span><span>Touche le <strong>menu ⋮</strong> en haut à droite.</span></li>
					<li>
						<span class="n">3</span><span
							>Choisis <strong>Installer l'application</strong> (ou <strong>Ajouter à l'écran d'accueil</strong>).</span
						>
					</li>
				</ol>
			</section>
		{/if}

		{#if platform !== "desktop" && !showOther}
			<button
				type="button"
				class="btn-reset link-btn"
				data-testid="bienvenue-other"
				on:click={() => (showOther = true)}
			>
				{platform === "ios" ? "Et sur Android ?" : "Et sur iPhone ?"}
			</button>
		{/if}

		<section
			class="friend"
			aria-labelledby="bienvenue-friend"
		>
			<h2 id="bienvenue-friend">Chez un ami</h2>
			<p class="hint">Fais scanner ce code avec l'appareil photo du téléphone, ou envoie-lui le lien.</p>
			{#if qr}
				<svg
					class="qr"
					viewBox={`0 0 ${qr.size + QUIET * 2} ${qr.size + QUIET * 2}`}
					role="img"
					aria-label={`QR code vers ${baseUrl}`}
					data-testid="bienvenue-qr"
					data-size={qr.size}
					data-modules={qr.size * qr.size}
					shape-rendering="crispEdges"
				>
					<rect
						width={qr.size + QUIET * 2}
						height={qr.size + QUIET * 2}
						fill="#fff"
					/>
					{#each dark as p}
						<rect
							class="module"
							x={p.x + QUIET}
							y={p.y + QUIET}
							width="1"
							height="1"
							fill="#000"
						/>
					{/each}
				</svg>
			{:else if qrError}
				<p class="hint">QR code indisponible : envoie le lien.</p>
			{/if}
			<p
				class="url"
				data-testid="bienvenue-url"
			>
				{baseUrl}
			</p>
			<button
				type="button"
				class="btn-primary send"
				data-testid="bienvenue-share"
				disabled={sharing || !baseUrl}
				on:click={share}
			>
				<Icon
					name="share"
					size="1.1em"
				/>
				<span>Envoyer à un ami</span>
			</button>
		</section>

		<p class="hint foot">Rien à créer : pas de compte, pas de mot de passe. Un prénom suffit, plus tard, pour retrouver ses favoris.</p>
	</main>
{/if}

<style lang="scss">
	main {
		min-height: 100%;
		padding-bottom: 5rem;
	}
	h1 {
		margin: 0 0 0.75rem;
	}
	h2 {
		margin: 1.25rem 0 0.5rem;
		font-size: 1.1rem;
	}
	.pitch {
		margin: 0 0 1rem;
		font-size: 1.05rem;
		line-height: 1.45;
	}
	.installed {
		margin: 0 0 0.5rem;
		padding: 0.6rem 0.8rem;
		border-radius: 0.6rem;
		background: rgba(30, 215, 96, 0.12);
		border: 1px solid rgba(30, 215, 96, 0.35);
	}
	section {
		padding-bottom: 0.75rem;
	}
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.steps li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 44px;
		padding: 0.4rem 0.6rem;
		border-radius: 0.6rem;
		background: rgba(255, 255, 255, 0.07);
		border: 1px solid rgba(255, 255, 255, 0.1);
		line-height: 1.35;
		overflow-wrap: anywhere;
	}
	.n {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		background: var(--accent, #1ed760);
		color: #000;
		font-weight: 700;
	}
	.install {
		margin: 0 0 0.5rem;
	}
	.hint {
		color: #999;
		margin: 0.5rem 0;
		/* 12px floor at the 12px mobile root, shared token (c32a). */
		font-size: var(--text-secondary-size);
	}
	.foot {
		margin-top: 1.25rem;
	}
	// "Et sur Android ?": a plain text link, 44px tall for the thumb.
	.link-btn {
		all: unset;
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 0.25rem;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
	.friend {
		margin-top: 0.5rem;
		border-top: 1px solid rgba(218, 218, 218, 0.08);
	}
	.qr {
		display: block;
		width: min(60vw, 14rem);
		height: auto;
		margin: 0.75rem 0;
		border-radius: 0.5rem;
	}
	.url {
		margin: 0 0 0.75rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		overflow-wrap: anywhere;
		user-select: all;
	}
	.send {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
</style>
