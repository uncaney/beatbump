<script lang="ts">
	// 39A (B6-7): compact invitation for an ANONYMOUS profile that already has
	// a history (>= IDENTITY_MIN_PLAYS plays): the plays live on this device
	// only until a first name is given; POST me/login then moves them onto
	// the named profile and the toast says what moved. "Plus tard" snoozes it
	// for 7 days (localStorage). `force` (the device-only banner's link)
	// shows it whatever the count and the snooze. Empty profiles keep the
	// FirstRun block (its own name form).
	import { createEventDispatcher, onMount } from "svelte";
	import { getStatsSummary, isAnonymousProfile, login } from "$lib/me";
	import { identitySnoozed, migratedSummary, readIdentitySnooze, shouldPromptIdentity, snoozeIdentity, type MigratedCounts } from "$lib/identity";
	import { notify } from "$lib/utils/utils";

	/** Show without the plays / snooze conditions (still anonymous only). */
	export let force = false;
	/** Read by the parent (bind:visible) to hide its own link while open. */
	export let visible = false;

	const dispatch = createEventDispatcher<{ named: { name: string; migrated: MigratedCounts | null }; later: void }>();

	let eligible = false;
	let anonymous = false;
	let checked = false;
	let name = "";
	let busy = false;
	let error = "";
	let done = false;

	// Re-opened from the banner after a "Plus tard": show again.
	$: if (force) done = false;
	$: visible = !done && anonymous && (force || eligible);

	onMount(() => {
		let alive = true;
		(async () => {
			const anon = await isAnonymousProfile();
			if (!alive) return;
			anonymous = anon;
			if (!anon) return;
			let plays = 0;
			if (!identitySnoozed(readIdentitySnooze(), Date.now())) {
				try {
					// all-time plays of this profile (harness plays are never stored)
					plays = Number((await getStatsSummary(0))?.plays) || 0;
				} catch {
					plays = 0;
				}
			}
			if (!alive) return;
			eligible = shouldPromptIdentity({ anonymous: true, plays, snoozedAt: readIdentitySnooze(), now: Date.now() });
			checked = true;
		})();
		return () => {
			alive = false;
		};
	});

	function later() {
		snoozeIdentity();
		done = true;
		dispatch("later");
	}

	async function submit() {
		const n = name.trim();
		if (!n || busy) return;
		busy = true;
		error = "";
		try {
			const r = await login(n);
			const shown = typeof r?.name === "string" && r.name ? r.name : n;
			const moved = migratedSummary(r?.migrated, shown);
			notify(moved || `C'est noté, ${shown} : ta musique te suit maintenant sur tous tes appareils.`, "success");
			done = true;
			anonymous = false;
			dispatch("named", { name: shown, migrated: r?.migrated ?? null });
		} catch {
			error = "Impossible d'enregistrer ce prénom pour l'instant. Réessaie dans un moment.";
		} finally {
			busy = false;
		}
	}
</script>

{#if visible}
	<section
		class="identity"
		data-testid="identity-prompt"
		data-checked={checked ? "1" : "0"}
		aria-label="Retrouver tes écoutes"
	>
		<p class="lead">Tes écoutes restent sur cet appareil. Dis-moi ton prénom pour les retrouver partout.</p>
		<form
			class="row"
			on:submit|preventDefault={submit}
		>
			<label
				class="sr-only"
				for="identity-name-input">Ton prénom</label
			>
			<input
				id="identity-name-input"
				class="name-input"
				type="text"
				autocomplete="given-name"
				maxlength="40"
				placeholder="ex. Camille"
				data-testid="identity-name-input"
				bind:value={name}
				disabled={busy}
			/>
			<button
				type="submit"
				class="btn-primary"
				data-testid="identity-name-submit"
				disabled={busy || !name.trim()}>{busy ? "Un instant…" : "C'est moi"}</button
			>
			<button
				type="button"
				class="btn-ghost"
				data-testid="identity-later"
				disabled={busy}
				on:click={later}>Plus tard</button
			>
		</form>
		{#if error}
			<p
				class="error"
				role="alert"
			>
				{error}
			</p>
		{/if}
	</section>
{/if}

<style lang="scss">
	.identity {
		margin: 0.75rem 0 1rem;
		padding: 0.8rem 0.9rem;
		border-radius: 0.8rem;
		border: 1px solid rgba(30, 215, 96, 0.35);
		background: rgba(30, 215, 96, 0.1);
	}
	.lead {
		margin: 0 0 0.6rem;
		font-weight: 600;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	.name-input {
		flex: 1 1 10rem;
		min-width: 0;
		box-sizing: border-box;
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
	.error {
		margin: 0.5rem 0 0;
		color: #ff8a80;
		font-size: var(--text-secondary-size);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
