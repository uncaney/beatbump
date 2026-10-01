<script lang="ts">
	// ON1: first-visit guided home. Replaces the awkward "looks broken" first
	// impression (PersonalRows already hides its empty rows, but hides them
	// into nothing) with concrete actions, shown only when the profile has
	// no history (me/stats/recent empty, including the anonymous/failed
	// case) AND no local "Remember Last Track" queue to resume. Hidden the
	// moment a play is recorded this session, and for good once dismissed or
	// acted on (localStorage `ytm-first-run-done`).
	//
	// c30a F11 + ON5 + L8-15: every action leads to something playable.
	// "Lancer un mix" plays a decade/genre mix of the library (local/mix) or,
	// when no slice is big enough, a random sample of the library (never the
	// empty offline page a new profile used to land on). "Dis-moi ton prénom"
	// is the name-only login (POST me/login) that unlocks the profile rows
	// (Redécouvrir, Jamais écouté, Ta semaine): PersonalRows reloads them
	// through the BroadcastChannel login() posts on. The dismissal is only
	// persisted when the block was really shown (a track restored on load
	// used to bury it unseen).
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	import { APIClient } from "$lib/api";
	import { getRecent, isAnonymousProfile, login } from "$lib/me";
	import { mixCardsFrom } from "$lib/mixes";
	import { playTracks } from "$components/PlayAllBar/PlayAllBar.svelte";
	import type { PlaybackContextInput } from "$lib/stores/list/playbackContext";
	import { readResumeState } from "$lib/stores/resumeState";
	import { settings } from "$lib/stores/settings";
	import { currentTrack } from "$lib/stores/list";
	import { get } from "svelte/store";

	const DONE_KEY = "ytm-first-run-done";
	const SAMPLE_SIZE = 40;

	let visible = false;
	let anonymous = false;
	let name = "";
	let nameBusy = false;
	let nameError = "";
	let mixBusy = false;
	let mixNote = "";

	/** L8-15: persist the dismissal only when the block was actually shown. */
	function dismiss() {
		if (!visible) return;
		visible = false;
		try {
			localStorage.setItem(DONE_KEY, "1");
		} catch {
			/* no storage: nothing to persist, just hide for this load */
		}
	}

	/** A random page of the library (local/songs), SAMPLE_SIZE titles; [] when empty or offline. */
	async function randomSample(): Promise<any[]> {
		try {
			const first = await (await APIClient.fetch(`/api/v1/local/songs?limit=${SAMPLE_SIZE}&sort=dateAdded:desc`)).json();
			let items: any[] = Array.isArray(first?.items) ? first.items : [];
			const total = Number(first?.total) || items.length;
			if (total > SAMPLE_SIZE) {
				const offset = Math.floor(Math.random() * (total - SAMPLE_SIZE));
				const r = await (await APIClient.fetch(`/api/v1/local/songs?limit=${SAMPLE_SIZE}&offset=${offset}&sort=album:asc`)).json();
				if (Array.isArray(r?.items) && r.items.length) items = r.items;
			}
			return items;
		} catch {
			return [];
		}
	}

	/** F11: a decade/genre mix of the library, else a random sample; the Mixes page only when the library is empty. */
	async function playMix() {
		if (mixBusy) return;
		mixBusy = true;
		mixNote = "";
		try {
			let items: any[] = [];
			let context: PlaybackContextInput = { kind: "queue", title: "Un peu de tout", href: "/library/albums" };
			try {
				const res = await APIClient.fetch("/api/v1/local/mixes");
				const card = res.ok ? mixCardsFrom(await res.json())[0] : undefined;
				if (card) {
					const r = await APIClient.fetch(`/api/v1/local/mix?${card.query}`);
					const d = r.ok ? await r.json() : null;
					items = Array.isArray(d?.items) ? d.items : [];
					context = { kind: card.kind, title: card.title, href: "/library/mixes" };
				}
			} catch {
				items = [];
			}
			if (!items.length) {
				items = await randomSample();
				context = { kind: "queue", title: "Un peu de tout", href: "/library/albums" };
			}
			if (!items.length) {
				mixNote = "La bibliothèque est vide pour l'instant.";
				await goto("/library/mixes");
				return;
			}
			const started = await playTracks(items, { shuffle: true, context });
			if (started > 0) dismiss();
			else mixNote = "Rien de jouable dans ce mix pour l'instant.";
		} finally {
			mixBusy = false;
		}
	}

	/** ON5: name-only login; PersonalRows reloads its rows on the profile channel. */
	async function submitName() {
		const n = name.trim();
		if (!n || nameBusy) return;
		nameBusy = true;
		nameError = "";
		try {
			await login(n);
			anonymous = false;
			dismiss();
		} catch {
			nameError = "Impossible d'enregistrer ce prénom pour l'instant. Réessaie dans un moment.";
		} finally {
			nameBusy = false;
		}
	}

	onMount(() => {
		(async () => {
			try {
				if (localStorage.getItem(DONE_KEY) === "1") return;
			} catch {
				/* no storage: treat as not-yet-dismissed */
			}
			let hasSavedQueue = false;
			try {
				hasSavedQueue =
					get(settings)?.playback?.["Remember Last Track"] === true && !!readResumeState(localStorage);
			} catch {
				hasSavedQueue = false;
			}
			if (hasSavedQueue) return;
			// PF3-6: the memoised whoami first (no request once known); the
			// history check then shares PersonalRows' me/stats/recent call
			// (getRecent memo) instead of issuing its own.
			const anon = await isAnonymousProfile();
			let recentCount = 0;
			try {
				const r = await getRecent(1);
				recentCount = Array.isArray(r?.items) ? r.items.length : 0;
			} catch {
				// Anonymous profile or a failed call both read as "no history".
				recentCount = 0;
			}
			if (recentCount > 0) return;
			anonymous = anon;
			visible = true;
		})();
		// A play starting (this session, from any source) means the "first
		// impression" moment has passed - if the block was shown (dismiss
		// checks `visible`, so a track restored on load never buries it unseen).
		return currentTrack.subscribe((t) => {
			if (t) dismiss();
		});
	});
</script>

{#if visible}
	<section
		class="first-run"
		data-testid="first-run"
	>
		<button
			type="button"
			class="btn-ghost dismiss"
			aria-label="Fermer"
			on:click={dismiss}
		>
			&times;
		</button>
		<p class="headline">Bienvenue</p>
		<p class="sub">Trouve ta musique en quelques gestes.</p>
		<div class="actions">
			<a
				class="btn-secondary"
				href="/library/albums"
				on:click={dismiss}>Explorer ma bibliothèque</a
			>
			<a
				class="btn-secondary"
				href="/home?search=1"
				on:click={dismiss}>Chercher un titre</a
			>
			<button
				type="button"
				class="btn-secondary"
				data-testid="first-run-mix"
				disabled={mixBusy}
				on:click={playMix}>{mixBusy ? "Préparation du mix…" : "Lancer un mix"}</button
			>
		</div>
		{#if mixNote}
			<p
				class="note"
				role="status"
			>
				{mixNote}
			</p>
		{/if}
		{#if anonymous}
			<form
				class="name-form"
				data-testid="first-run-name"
				on:submit|preventDefault={submitName}
			>
				<label
					class="name-label"
					for="first-run-name-input">Dis-moi ton prénom</label
				>
				<div class="name-row">
					<input
						id="first-run-name-input"
						class="name-input"
						type="text"
						autocomplete="given-name"
						maxlength="40"
						placeholder="ex. Camille"
						data-testid="first-run-name-input"
						bind:value={name}
						disabled={nameBusy}
					/>
					<button
						type="submit"
						class="btn-primary"
						data-testid="first-run-name-submit"
						disabled={nameBusy || !name.trim()}>{nameBusy ? "Un instant…" : "C'est moi"}</button
					>
				</div>
				<p class="name-hint">Le même prénom retrouve ta musique sur chaque appareil et débloque Redécouvrir et Jamais écouté.</p>
				{#if nameError}
					<p
						class="note error"
						role="alert"
					>
						{nameError}
					</p>
				{/if}
			</form>
		{/if}
	</section>
{/if}

<style lang="scss">
	.first-run {
		position: relative;
		margin: 0.75rem 0 1.25rem;
		padding: 1.1rem 1.1rem 1rem;
		border-radius: 0.9rem;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(255, 255, 255, 0.04);
	}
	.dismiss {
		position: absolute;
		top: 0.4rem;
		right: 0.4rem;
		min-width: max(2.75rem, 44px);
		min-height: max(2.75rem, 44px);
		display: grid;
		place-items: center;
		font-size: 1.2rem;
		line-height: 1;
	}
	.headline {
		margin: 0 2.5rem 0.2rem 0;
		font-size: 1.1rem;
		font-weight: 700;
	}
	.sub {
		margin: 0 2.5rem 0.75rem 0;
		color: #b3b3b3;
		font-size: var(--text-secondary-size);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.note {
		margin: 0.6rem 0 0;
		color: #b3b3b3;
		font-size: var(--text-secondary-size);
	}
	.note.error {
		color: #ff8a80;
	}
	// ON5: the inline name form. The input matches the 44px tap floor of the
	// buttons around it; the hint keeps the promise short.
	.name-form {
		margin-top: 0.9rem;
		padding-top: 0.9rem;
		border-top: 1px solid rgba(255, 255, 255, 0.1);
	}
	.name-label {
		display: block;
		margin-bottom: 0.4rem;
		font-weight: 600;
		/* U12-9: undo the global small caps of _forms.scss (original Beatbump forms only). */
		font-variant-caps: normal;
		letter-spacing: normal;
	}
	.name-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.name-input {
		flex: 1 1 12rem;
		min-width: 0;
		min-height: max(2.75rem, 44px);
		padding: 0 0.8rem;
		border-radius: 0.6rem;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font-size: 1rem;
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 1px;
		}
	}
	.name-hint {
		margin: 0.5rem 0 0;
		color: #b3b3b3;
		font-size: var(--text-secondary-size);
	}
</style>
