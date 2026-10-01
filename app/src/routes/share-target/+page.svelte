<script lang="ts">
	// HL5: Android "Partager vers Beatbump" lands here (manifest share_target,
	// GET /share-target?title&text&url). The shared link is turned into the
	// in-app route ($lib/shareTarget) and replaced in the history: a track
	// opens the /listen preview (no acquisition before "Écouter", F12), a
	// playlist its page. Anything else: "Lien non reconnu" + a link home.
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/stores";
	import { parseSharedLink, type SharedTarget } from "$lib/shareTarget";

	let state: "resolving" | "unrecognized" = "resolving";
	let target: SharedTarget | null = null;
	let shared = "";

	onMount(() => {
		const q = $page.url.searchParams;
		const params = { title: q.get("title") ?? "", text: q.get("text") ?? "", url: q.get("url") ?? "" };
		shared = params.url || params.text || params.title;
		target = parseSharedLink(params);
		try {
			(window as Window & { __ytmShareTarget?: unknown }).__ytmShareTarget = { params, target };
		} catch {
			/* harness only */
		}
		if (target) {
			void goto(target.href, { replaceState: true });
		} else {
			state = "unrecognized";
		}
	});
</script>

<svelte:head>
	<title>{state === "unrecognized" ? "Lien non reconnu" : "Ouverture…"} | Beatbump</title>
	<meta
		name="robots"
		content="noindex"
	/>
</svelte:head>

<main
	class="share-target"
	data-testid="share-target"
	data-state={state}
	data-kind={target?.kind ?? ""}
>
	{#if state === "resolving"}
		<p
			class="hint"
			aria-live="polite"
		>
			Ouverture du lien partagé…
		</p>
	{:else}
		<div
			class="card"
			data-testid="share-unrecognized"
			role="status"
		>
			<span class="title h4">Lien non reconnu</span>
			<p class="hint">
				Partage un lien YouTube ou YouTube Music (morceau ou playlist) pour l'ouvrir ici.
			</p>
			{#if shared}
				<p
					class="shared"
					data-testid="share-raw"
				>
					{shared.slice(0, 200)}
				</p>
			{/if}
			<a
				class="home"
				href="/home"
				data-testid="share-home">Retour à l'accueil</a
			>
		</div>
	{/if}
</main>

<style lang="scss">
	.share-target {
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 2rem 1rem;
		min-height: 40vh;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 32rem;
		width: 100%;
		padding: 1.25rem;
		border-radius: 0.75rem;
		background: rgb(255 255 255 / 6%);
		border: 1px solid rgb(255 255 255 / 15%);
	}
	.title {
		margin: 0;
	}
	.hint {
		margin: 0;
		color: hsla(0, 0%, 100%, 0.75);
		line-height: 1.4;
	}
	.shared {
		margin: 0;
		font-size: 0.875em;
		color: hsla(0, 0%, 100%, 0.55);
		word-break: break-all;
	}
	.home {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		align-self: flex-start;
		min-height: max(2.75rem, 44px);
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		background: rgb(255 255 255 / 10%);
		color: #f2f2f2;
		text-decoration: none;
		font-weight: 500;

		&:hover {
			background: rgb(255 255 255 / 18%);
		}
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
</style>
