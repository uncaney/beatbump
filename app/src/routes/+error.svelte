<script>
	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	import { page } from "$app/stores";

	// No forced redirect any more (audit 1.14 / TOP 10 #2): the user chooses
	// between going home and going back.
	$: status = $page?.status ?? 404;
	// Messages are chosen here (French, per status); a raw upstream statusText such as
	// "Internal Error" is never shown (audit UX v4 regression 1).
	// Our own messages carry the "fr:" marker (`error(500, "fr:Explorer est
	// indisponible...")`) and are shown whatever their first word (audit v4 H10);
	// the word whitelist only remains for older unmarked messages of other routes.
	const OURS = "fr:";
	$: rawMsg = ($page?.error?.message || "").trim();
	$: ours = rawMsg.startsWith(OURS);
	$: raw = ours ? rawMsg.slice(OURS.length).trim() : rawMsg;
	$: message =
		status === 404
			? /artiste/i.test(raw)
				? "Cet artiste n'existe pas ou n'est plus disponible."
				: ours && raw
					? raw
					: "Cette page n'existe pas ou n'est plus proposée."
			: (ours && raw) || /^(impossible|cette|ce |la |le |l')/i.test(raw)
				? raw
				: "Une erreur est survenue, réessaie dans un instant.";

	function back() {
		if (!browser) return;
		if (window.history.length > 1) window.history.back();
		else goto("/home");
	}
</script>

<main class="error-page">
	<a
		href="/home"
		class="logolink"
		aria-label="Accueil"
	>
		<div class="logo">
			<img
				src="/logo.svg"
				width="128"
				height="128"
				alt="logo"
			/>
		</div>
	</a>
	<h1>Oups !</h1>
	<h5>{message}</h5>

	<p>Pas de panique, on te ramène au bon endroit.</p>
	<div class="actions">
		<a
			href="/home"
			class="btn-primary home-link"
		>
			Accueil
		</a>
		<button
			type="button"
			class="btn-secondary back-button"
			on:click={back}
		>
			Retour
		</button>
	</div>
</main>

<style lang="scss">
	.logolink {
		display: inline-block;
	}

	main {
		text-align: center;
		align-items: center;
		/* The page must be readable immediately: never inherit a fading ancestor
		   (the layout transition captured the 404 at 19 % / 35 % opacity). */
		opacity: 1 !important;
		visibility: visible;
	}

	h1,
	h5,
	p {
		color: #fff;
		opacity: 1;
	}

	p {
		font-size: 1.125rem;
	}

	.logo {
		display: flex;
		place-content: center;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		justify-content: center;
		margin-top: 1.25rem;
	}

	/* U11-2 (audit UX v11): both actions come from the button system
	   (.btn-primary "Accueil", .btn-secondary "Retour": one pill shape, 44px
	   floor, no local colours). Only the shared minimum width lives here.
	   `.back-button` stays as the harness hook (buttons_readable probes it). */
	.home-link,
	.back-button {
		min-width: 8rem;
	}
</style>
