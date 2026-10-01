<script lang="ts">
	// Settings > Offline: auto-cache switch (settings.offline.autoCache), cached
	// audio summary, quota selector, clear cache (with confirmation) and re-sync.
	// Talks to the service worker only through the helpers of $lib/offline.
	import { onMount, tick } from "svelte";
	import { settings } from "$stores/settings";
	import {
		getOfflineTracks,
		listCachedAudio,
		reconcileOfflineList,
		removeOffline,
		setAudioQuota,
		swRequest,
		type AudioListEntry,
	} from "$lib/offline";

	const MB = 1024 * 1024;
	const GB = 1024 * MB;
	const QUOTA_OPTIONS: { label: string; bytes: number }[] = [
		{ label: "500 MB", bytes: 500 * MB },
		{ label: "1 GB", bytes: 1 * GB },
		{ label: "2 GB", bytes: 2 * GB },
		{ label: "5 GB", bytes: 5 * GB },
		{ label: "Unlimited", bytes: 0 },
	];
	const SW_UNAVAILABLE =
		"Offline cache unavailable: the service worker did not answer (first visit, private window, or reload needed).";

	let loading = true;
	let error = "";
	let message = "";
	let busy: "" | "quota" | "clear" | "resync" = "";
	let entries: AudioListEntry[] = [];
	let total = 0;
	let quota = 0; // <= 0 = unlimited
	let quotaValue = 2 * GB;
	let confirmClear = false;
	let localCount = 0; // tracks in the local offline list (localStorage)
	let confirmButton: HTMLButtonElement | null = null;
	let clearButton: HTMLButtonElement | null = null;

	$: customQuota = quota > 0 && !QUOTA_OPTIONS.some((o) => o.bytes === quota);
	$: cachedTracks = entries.length;
	// The status line shows "0 tracks": nothing to re-sync. Not when the SW
	// did not answer ("Unknown"): Re-sync stays available as a retry.
	$: nothingCached = !loading && !(error && !entries.length) && cachedTracks === 0;

	function fmtBytes(bytes: number): string {
		if (!(bytes > 0)) return "0 MB";
		if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
		return `${Math.max(1, Math.round(bytes / MB))} MB`;
	}
	function fmtQuota(q: number): string {
		return q > 0 ? fmtBytes(q) : "unlimited";
	}

	async function refresh() {
		loading = true;
		error = "";
		try {
			localCount = getOfflineTracks().length;
			const r = await listCachedAudio();
			if (!r || !Array.isArray(r.entries)) {
				error = SW_UNAVAILABLE;
			} else {
				entries = r.entries;
				total = r.total || 0;
				quota = typeof r.quota === "number" ? r.quota : 0;
				quotaValue = quota > 0 ? quota : 0;
			}
		} catch (e) {
			error = `Could not read the offline cache: ${(e as Error)?.message ?? e}`;
		} finally {
			loading = false;
		}
	}

	async function onQuotaChange() {
		if (busy) return;
		busy = "quota";
		error = "";
		message = "";
		try {
			const r = await setAudioQuota(Number(quotaValue));
			if (!r) {
				error = SW_UNAVAILABLE;
			} else {
				quota = typeof r.quota === "number" ? r.quota : Number(quotaValue);
				message = `Offline quota set to ${fmtQuota(quota)}.`;
				await refresh();
			}
		} catch (e) {
			error = `Could not change the quota: ${(e as Error)?.message ?? e}`;
		} finally {
			busy = "";
		}
	}

	async function askClear() {
		confirmClear = true;
		await tick();
		confirmButton?.focus();
	}
	async function cancelClear() {
		confirmClear = false;
		await tick();
		clearButton?.focus();
	}
	async function doClear() {
		if (busy) return;
		busy = "clear";
		error = "";
		message = "";
		try {
			// 1. Local list (localStorage) + uncache request for each listed track.
			const local = getOfflineTracks();
			for (const t of local) removeOffline(t);
			// 2. Entries the SW still holds (also covers tracks missing from the list).
			//    Sequential so each "audio-uncached" ack matches its request.
			let failed = 0;
			for (const e of entries) {
				const r = await swRequest<{ type: "audio-uncached"; ok: boolean }>(
					{ type: "uncache-audio", url: e.url || "", videoId: e.videoId || "" },
					"audio-uncached",
					5_000,
				);
				if (!r || !r.ok) failed++;
			}
			await reconcileOfflineList().catch(() => null);
			await refresh();
			message = failed
				? `Offline cache cleared, ${failed} entr${failed === 1 ? "y" : "ies"} could not be removed.`
				: "Offline cache cleared.";
		} catch (e) {
			error = `Could not clear the offline cache: ${(e as Error)?.message ?? e}`;
		} finally {
			busy = "";
			confirmClear = false;
			await tick();
			clearButton?.focus();
		}
	}

	async function doResync() {
		if (busy) return;
		busy = "resync";
		error = "";
		message = "";
		try {
			const l = await reconcileOfflineList();
			if (l === null) {
				error = SW_UNAVAILABLE;
			} else {
				await refresh();
				message = `Offline list re-synced: ${l.length} track${l.length === 1 ? "" : "s"} listed.`;
			}
		} catch (e) {
			error = `Could not re-sync the offline list: ${(e as Error)?.message ?? e}`;
		} finally {
			busy = "";
		}
	}

	onMount(() => {
		void refresh();
	});
</script>

<section
	id="settings-offline"
	aria-labelledby="offline-heading"
	aria-busy={loading || !!busy}
>
	<span
		class="h5"
		id="offline-heading">Offline</span
	>

	<div class="setting">
		<label
			for="offline-autocache"
			id="offline-autocache-label"
		>
			Save every played track for offline
			<span id="offline-autocache-desc"
				>Tracks you play are kept on this device so they play without a
				connection, within the quota below.</span
			>
		</label>
		<span class="switch-wrap">
			<input
				type="checkbox"
				role="switch"
				id="offline-autocache"
				name="offline-autocache"
				class="sr-only"
				aria-describedby="offline-autocache-desc"
				bind:checked={$settings.offline.autoCache}
			/>
			<label
				for="offline-autocache"
				class="switch"
				aria-hidden="true"
			/>
		</span>
	</div>

	<div class="setting">
		<!-- svelte-ignore a11y-label-has-associated-control -->
		<label id="offline-cache-label">
			Cached audio
			<span
				id="offline-cache-status"
				aria-live="polite"
			>
				{#if loading}
					Loading…
				{:else if error && !entries.length}
					Unknown
				{:else}
					{cachedTracks} track{cachedTracks === 1 ? "" : "s"} · {fmtBytes(total)} of {fmtQuota(
						quota,
					)}
				{/if}
			</span>
		</label>
		<span
			id="offline-resync-desc"
			class="sr-only"
			>Rebuilds the offline track list from what is really cached on this
			device.</span
		>
		<!-- Disabled while the status shows "0 tracks": there is nothing to
		     re-sync (audit v3 TOP 10 #10); the title says why. -->
		<button
			type="button"
			id="offline-resync"
			class="btn"
			aria-describedby="offline-resync-desc"
			disabled={loading || !!busy || nothingCached}
			title={nothingCached
				? "Aucune piste en cache : rien à resynchroniser"
				: "Reconstruit la liste hors-ligne à partir du cache de cet appareil"}
			on:click={doResync}
		>
			{busy === "resync" ? "Re-syncing…" : "Re-sync list"}
		</button>
	</div>

	<div class="setting">
		<label for="offline-quota">
			Offline storage limit
			<span id="offline-quota-desc"
				>Oldest tracks are removed first once the limit is reached.</span
			>
		</label>
		<div class="select">
			<select
				id="offline-quota"
				name="offline-quota"
				aria-describedby="offline-quota-desc"
				disabled={loading || !!busy || (!!error && !entries.length)}
				bind:value={quotaValue}
				on:change={onQuotaChange}
			>
				{#if customQuota}
					<option value={quota}>Custom ({fmtBytes(quota)})</option>
				{/if}
				{#each QUOTA_OPTIONS as opt}
					<option value={opt.bytes}>{opt.label}</option>
				{/each}
			</select>
		</div>
	</div>

	<div class="setting">
		<label
			for="offline-clear"
			id="offline-clear-label"
		>
			Clear offline cache
			<span id="offline-clear-desc"
				>Removes every cached track from this device. Your playlists and
				favorites are kept.</span
			>
		</label>
		{#if !confirmClear}
			<button
				type="button"
				id="offline-clear"
				class="btn danger"
				aria-describedby="offline-clear-desc"
				disabled={loading || !!busy || (cachedTracks === 0 && localCount === 0)}
				bind:this={clearButton}
				on:click={askClear}
			>
				Clear offline cache
			</button>
		{:else}
			<div
				class="confirm"
				role="group"
				aria-labelledby="offline-clear-confirm-text"
			>
				<span id="offline-clear-confirm-text"
					>Delete {cachedTracks} cached track{cachedTracks === 1 ? "" : "s"} ({fmtBytes(
						total,
					)})? This cannot be undone.</span
				>
				<div class="confirm-actions">
					<button
						type="button"
						id="offline-clear-confirm"
						class="btn danger"
						disabled={!!busy}
						bind:this={confirmButton}
						on:click={doClear}
					>
						{busy === "clear" ? "Clearing…" : "Yes, delete"}
					</button>
					<button
						type="button"
						id="offline-clear-cancel"
						class="btn"
						disabled={!!busy}
						on:click={cancelClear}
					>
						Cancel
					</button>
				</div>
			</div>
		{/if}
	</div>

	{#if error}
		<p
			id="offline-error"
			class="feedback error"
			role="alert"
		>
			{error}
			<button
				type="button"
				id="offline-retry"
				class="btn"
				disabled={loading || !!busy}
				on:click={refresh}>Retry</button
			>
		</p>
	{/if}
	<p
		id="offline-message"
		class="feedback"
		class:hidden={!message}
		aria-live="polite"
	>
		{message}
	</p>
</section>

<style lang="scss">
	section {
		display: flex;
		flex-direction: column;
		margin-block-end: 1em;
		border-bottom: 0.01em solid rgb(218 218 218 / 8.2%);
	}

	.setting {
		display: inline-flex;
		color: inherit;
		vertical-align: top;
		gap: 1em;
		flex-direction: column;
		margin-block: 1em;

		&:first-of-type {
			margin-block-start: 0;
		}

		@media screen and (min-width: 40em) {
			align-items: center;
			flex-direction: row;

			> :last-child:not(label) {
				margin-left: auto;
			}
		}
	}

	label {
		display: inline-flex;
		flex-direction: column;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
			Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue",
			sans-serif;
		font-size: 1em;
		text-transform: none !important;
		font-variant: unset;
		gap: 0.125em;
		line-height: 1.4;

		> span {
			font-size: 0.875em;
			color: hsla(0, 0%, 100%, 0.7);
			line-height: 1.2;
		}
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

	/* Switch: the checkbox stays focusable (visually hidden, not display:none). */
	.switch-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-height: max(2.75rem, 44px); /* 44px hit area, px floor (mobile root font 12px) */
		flex-shrink: 0;
	}

	.switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		width: 3.8125em;
		height: 2em;
		cursor: pointer;
		background-color: rgb(109 109 109 / 35%);
		border-radius: 1.25rem;
		transition: background-color 0.3s;

		&::before {
			/* extend the pointer target to the 44px wrapper */
			content: "";
			position: absolute;
			inset: -0.375rem -0.25rem;
		}
	}

	.switch::after {
		--size: calc(2rem - (2px * 2));

		content: "";
		position: absolute;
		width: var(--size);
		height: var(--size);
		border-radius: 9999em;
		background-color: white;
		top: 50%;
		transform: translateY(-50%);
		left: 0.125em;
		transition: left 0.3s;
		box-shadow: 0 0 12px -3px rgb(0 0 0 / 38.4%);
	}

	[type="checkbox"]:checked + .switch::after {
		left: 2em;
	}

	[type="checkbox"]:checked + .switch {
		background-color: #00cd6a;
	}

	[type="checkbox"]:focus-visible + .switch {
		outline: 2px solid #fff;
		outline-offset: 3px;
	}

	.btn {
		all: unset;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* 44px with a px floor: the mobile root font is 12px, so 2.75rem alone
		   gave 33px tall buttons / selects (audit v4 TOP 3). */
		min-height: max(2.75rem, 44px);
		min-width: max(2.75rem, 44px);
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		font: inherit;
		font-weight: 500;
		/* The global %button-base forces `color: #0f0f0f !important`, which made
		   "Re-sync list" 1.11:1 on this translucent background (audit 1.10).
		   #f2f2f2 on rgb(255 255 255 / 10%) over #121212 (= #2a2a2a) = 11.7:1. */
		color: #f2f2f2 !important;
		background: rgb(255 255 255 / 10%);
		cursor: pointer;
		transition: background-color 0.15s;

		&:hover:not(:disabled) {
			background: rgb(255 255 255 / 18%);
			color: #fff !important;
		}
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
		/* Disabled: inherit the shared readable style (global _button.scss):
		   #9a9a9a on #2c2c2c = 4.96:1, no opacity stacking. */
		&:disabled {
			opacity: 1;
			color: #9a9a9a !important;
			background: rgb(44, 44, 44) !important;
			border: 1px solid rgba(255, 255, 255, 0.25);
			cursor: not-allowed;
		}
		&.danger {
			background: rgb(220 53 69 / 25%);
			&:hover:not(:disabled) {
				background: rgb(220 53 69 / 45%);
			}
		}
	}

	.select select {
		min-height: max(2.75rem, 44px);
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}

	.confirm {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: 0.5rem;
		background: rgb(220 53 69 / 12%);
		border: 1px solid rgb(220 53 69 / 45%);
		font-size: 0.9375em;
		line-height: 1.3;
	}
	.confirm-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.feedback {
		margin: 0 0 1em;
		font-size: 0.9375em;
		line-height: 1.4;
		color: hsla(0, 0%, 100%, 0.85);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;

		&.error {
			color: #ffb3b3;
		}
		&.hidden {
			display: none;
		}
	}
</style>
