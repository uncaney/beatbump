<script>
	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	import { page } from "$app/stores";

	// No forced redirect any more (audit 1.14 / TOP 10 #2): the user chooses
	// between going home and going back.
	$: status = $page?.status ?? 404;
	$: message =
		status === 404
			? "Looks like you hit a dead end!"
			: $page?.error?.message || "Something went wrong.";

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
	<h1>Uh-Oh!</h1>
	<h5>{message}</h5>

	<p>Don't worry though, we got you covered.</p>
	<div class="actions">
		<a
			href="/home"
			class="button home-link"
		>
			Accueil
		</a>
		<button
			type="button"
			class="outlined back-button"
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

	/* Both actions are >= 44 px tall and keep the shared button look
	   (white on dark for the link; outlined white for the back button). */
	.home-link,
	.back-button {
		min-height: 44px;
		min-width: 8rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		text-decoration: none;
		opacity: 1;
	}
	.home-link {
		color: #0f0f0f !important;
		background: hsl(0deg 0% 98%) !important;
	}
	.back-button {
		color: #fff !important;
		border-color: rgba(255, 255, 255, 0.6) !important;
	}
</style>
