<script lang="ts">
    import Nav from "$components/Nav/Nav.svelte";
    import Alert from "$lib/components/Alert/Alert.svelte";
    import Player from "$lib/components/Player/Player.svelte";
    import InstallHint from "$lib/components/InstallHint/InstallHint.svelte";
    import Wrapper from "$lib/components/Wrapper/Wrapper.svelte";
    import {showAddToPlaylistPopper} from "$stores/stores";

    import {Popper} from "$lib/components/Popper";

	import "@fontsource-variable/commissioner";

    import {browser, dev} from "$app/environment";
    import {afterNavigate} from "$app/navigation";
    import {page} from "$app/stores";
    import {fullscreenStore} from "$lib/components/Player/channel";
    import {lazyComponent} from "$lib/lazyComponent";
    import {AudioPlayer} from "$lib/player";
    import {groupSession, settings, showGroupSessionCreator} from "$lib/stores";
    import {initPwa} from "$lib/stores/pwa";
    import {currentTrack, queue} from "$lib/stores/list";
    import {syncTabs} from "$lib/tabSync.js";
    import {Logger, notify} from "$lib/utils";
    import {SessionListService} from "$stores/list/sessionList";
    import {restoreResumeState, resumeShortcutClaimed, slimLastTrack, startResumePersistence} from "$lib/stores/resumeState";
    import {startNowPlayingSync} from "$lib/stores/nowPlayingSync";
    import {initClientLog} from "$lib/clientLog";
    import {onDestroy, onMount} from "svelte";
    import {get} from "svelte/store";

    export let data;

    // Capture `beforeinstallprompt` as early as possible (before onMount) so
    // Settings > Application can offer the install button.
    if (browser) initPwa();

    // K1 (audit perf v2): the Wrapper keys its content on `key`. It used to
    // start as '' and get the pathname in onMount, which recreated the whole
    // page once after its first mount (every entry page's onMount ran twice:
    // me/mix, me/stats/recent, local/albums, me/nowplaying each x2 per GET /).
    // $page is populated synchronously (SSR/hydration), so the first value is
    // already the final one: no extra remount at startup.
    //
    // L17 (audit v7, P2): `key` used to be set once from `location.pathname`
    // and never updated again, so the Back button (Nav.svelte, keyed off
    // `!key.includes("home")`) reflected the page the app was OPENED on, not
    // the current one, and the K1 150ms transition never replayed on
    // navigation. Deriving it from `$page.url.pathname` keeps the synchronous
    // first value AND makes both correct per-navigation (the Wrapper's
    // `{#key key}` now remounts its slot on every route change - that is the
    // point of K1's transition, not a regression).
    $: key = $page.url.pathname;
    let main: HTMLElement;

    // L16 (audit v7, P1): reload-on-update shared with the lazyComponent error
    // handler below (a chunk 404 after a SW update offers the same action).
    let reloading = false;
    const reloadNow = () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
    };

    // L16 (audit v7, P1): a deferred chunk 404s when the SW just activated a
    // new shell and dropped the old one (lazyComponent already retried once).
    // Reset whatever store triggered the load so the page isn't left locked
    // under `no-scroll` / a dead popper state, then offer the same reload
    // action as the SW-update toast.
    const handleChunkLoadError = (e: unknown, attempt: number, reset: () => void) => {
        Logger.err(e);
        if (attempt === 0) return; // lazyComponent's single retry is still in flight
        reset();
        notify("Le chargement d'une partie de l'app a échoué.", "error", {
            label: "Recharger maintenant",
            run: reloadNow,
        });
    };

    // K7 (audit perf v2): the fullscreen player, the group-session creator and
    // the add-to-playlist popper only serve on demand; their chunks (and what
    // only they import: DraggableList, CreatePlaylist, Description…) leave the
    // layout node and are fetched on the first open, then stay mounted.
    const Fullscreen = lazyComponent(() => import("$lib/components/Player/Fullscreen.svelte"), {
        onError: (e, attempt) => handleChunkLoadError(e, attempt, () => fullscreenStore.set("closed")),
    });
    const GroupSessionCreator = lazyComponent(() => import("$lib/components/GroupSessionCreator/GroupSessionCreator.svelte"), {
        onError: (e, attempt) => handleChunkLoadError(e, attempt, () => showGroupSessionCreator.set(false)),
    });
    const PlaylistPopper = lazyComponent(() => import("$lib/components/PlaylistPopper/PlaylistPopper.svelte"), {
        onError: (e, attempt) => handleChunkLoadError(e, attempt, () => showAddToPlaylistPopper.set({ state: false, item: undefined })),
    });
    $: if (browser && $fullscreenStore === "open") void Fullscreen.load().catch(() => {});
    $: if (browser && $showGroupSessionCreator) void GroupSessionCreator.load().catch(() => {});
    $: if (browser && $showAddToPlaylistPopper?.state) void PlaylistPopper.load().catch(() => {});

    // L16 (audit v7, P1): warm the Fullscreen + PlaylistPopper chunks at the
    // first play so the common path (tap the player bar right after opening
    // the app) never races a SW update - closes the deployment-window gap
    // without delaying startup (idle callback, not on the critical path).
    let warmedDeferredChunks = false;
    const warmDeferredChunks = () => {
        if (warmedDeferredChunks || !browser) return;
        warmedDeferredChunks = true;
        const run = () => {
            void Fullscreen.load().catch(() => {});
            void PlaylistPopper.load().catch(() => {});
        };
        if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
        else setTimeout(run, 500);
    };

    let isFullscreen = false;

    // Mirror the store into `isFullscreen` with ONE live timer: every store change
    // cancels the pending one, "open" waits 425 ms (enter animation) and "closed"
    // applies immediately. Two uncancelled timers let a late "open" (425 ms)
    // overwrite an earlier-resolved "closed" (0 ms), leaving the player painted
    // over a "closed" store that no further set("closed") could ever notify.
    let fsTimer: ReturnType<typeof setTimeout> | undefined;
    const syncFullscreen = (state: "open" | "closed") => {
        clearTimeout(fsTimer);
        fsTimer = undefined;
        if (state === "open") {
            fsTimer = setTimeout(() => {
                fsTimer = undefined;
                isFullscreen = true;
            }, 425);
        } else {
            isFullscreen = false;
        }
    };
    $: syncFullscreen($fullscreenStore);
    onDestroy(() => clearTimeout(fsTimer));

    let queueAlreadyPopulated = false;

    const setAppHeightWithPlayer = () => {
        if (queueAlreadyPopulated) return true;
        const appElm = document.querySelector<HTMLDivElement>("#app");
        if (appElm) {
            queueAlreadyPopulated = true;
            appElm.style.marginBlockEnd = "var(--player-bar-height)";
        }
        return true;
    };

    $: hasplayer = $queue.length
        ? setAppHeightWithPlayer()
        : queueAlreadyPopulated;

    $: if (hasplayer && browser) setAppHeightWithPlayer();
    // Setup dev debugging logs
    $: if (dev && browser) {
        console.log($SessionListService);
        if (page && !window.$page) {
            Object.defineProperty(window, "$page", {
                get() {
                    return get(page);
                },
                configurable: true,
            });
        }
    }

    $: if (
        browser &&
        $settings["playback"]["Remember Last Track"] === true &&
        $currentTrack
    ) {
        // PF3-12: slim row (one thumbnail, no tracking blobs).
        const slim = slimLastTrack($currentTrack);
        if (slim) localStorage.setItem("lastTrack", JSON.stringify(slim));
    }

    $: if ($fullscreenStore && browser) {
        $fullscreenStore === "open"
            ? document.documentElement.classList.add("no-scroll")
            : document.documentElement.classList.remove("no-scroll");
    }

    afterNavigate(() => {
        if (!browser) return;
        if (main) main.scrollTo({top: 0});
    });

    let stopResumePersistence: (() => void) | undefined;
    onDestroy(() => stopResumePersistence?.());
    // C2: push this device's resume state to me/nowplaying (named profile, online).
    let stopNowPlayingSync: (() => void) | undefined;
    onDestroy(() => stopNowPlayingSync?.());

    let scrollTop = 0;
    // ST3: uncaught errors / unhandled rejections -> POST /api/v1/client-log
    // (once per distinct message per session; media errors report from player.ts).
    onMount(() => initClientLog());
    // Offline banner: the service worker answers API calls with {"offline":true}
    // when the network is gone, which leaves pages empty without explanation.
    let online = true;
    onMount(() => {
        online = navigator.onLine !== false;
        const goOnline = () => (online = true);
        const goOffline = () => (online = false);
        window.addEventListener("online", goOnline);
        window.addEventListener("offline", goOffline);
        return () => {
            window.removeEventListener("online", goOnline);
            window.removeEventListener("offline", goOffline);
        };
    });
    onMount(() => {
        // L16: first play (AudioPlayer.paused false after its initial true/false
        // value) warms the deferred chunks - see warmDeferredChunks above.
        let firstPausedValue = true;
        return AudioPlayer.paused.subscribe((paused) => {
            if (firstPausedValue) {
                firstPausedValue = false;
                return;
            }
            if (!paused) warmDeferredChunks();
        });
    });
    onMount(() => {
        // C1 exact resume: the saved queue comes back as it was, PAUSED at the
        // saved position (no YouTube radio, works offline for a local queue).
        // `lastTrack` alone (state saved before C1) keeps the old behaviour.
        const remember = () => get(settings)?.playback?.["Remember Last Track"] === true;
        stopResumePersistence = startResumePersistence(remember);
        stopNowPlayingSync = startNowPlayingSync();
        if (remember()) {
            void restoreResumeState({autoplay: false})
                .then((restored) => {
                    // I3: the ?resume=1 shortcut handles its own fallback.
                    if (restored || resumeShortcutClaimed() || !localStorage["lastTrack"]) return;
                    const track = JSON.parse(
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        localStorage.getItem("lastTrack")! as string,
                    ) as unknown as typeof $currentTrack;

                    SessionListService.setTrackWillPlayNext(track, 0);
                    SessionListService.getMoreLikeThis({
                        playlistId: track?.playlistId ?? track?.autoMixList,
                    });
                })
                .catch((err) => Logger.err(err));
        }
        syncTabs.connect();

        // When a new build's service worker takes control, reload ONCE so the
        // page picks up the fresh app shell. Without this, iOS/PWA keeps showing
        // the old UI (stale buttons, broken back/lyrics/view-artist) indefinitely.
        try {
            if ("serviceWorker" in navigator) {
                const hadController = !!navigator.serviceWorker.controller;
                navigator.serviceWorker.addEventListener("controllerchange", () => {
                    // first install (no prior controller) shouldn't reload
                    if (!hadController || reloading) return;
                    // Playing: don't cut the music. Reload when the track ends or the
                    // user pauses (the paused store flips to true in both cases).
                    if (get(AudioPlayer.paused)) return reloadNow();
                    // Playing: offer an immediate reload, otherwise it happens at track end/pause.
                    notify("Nouvelle version installée, elle s'appliquera à la fin du morceau", "success", {
                        label: "Recharger maintenant",
                        run: reloadNow,
                    });
                    const unsub = AudioPlayer.paused.subscribe((paused) => {
                        if (!paused) return;
                        unsub();
                        // Let the player finish its end-of-track bookkeeping (lastTrack).
                        setTimeout(reloadNow, 250);
                    });
                });
                // proactively check for an update on every app open
                navigator.serviceWorker.getRegistration().then((reg) => reg && reg.update()).catch(() => {});
            }
        } catch (err) {
            Logger.err(err);
        }
    });
    let info: Record<string, any> = {};

    // QR1: a global `aria-live=polite` region announcing the track change, for
    // screen readers (today only `queue-count` and the shortcuts sheet have
    // one). Debounced 1 s so a fast skip-skip-skip only speaks the last
    // track; the very first value a session ever sees (the restored "last
    // track" on load, or the first track of a fresh queue) is never
    // announced, only actual changes afterwards.
    let nowPlayingMessage = "";
    let announcedVideoId: string | undefined;
    let skipNextAnnouncement = true;
    let nowPlayingTimer: ReturnType<typeof setTimeout> | undefined;
    onDestroy(() => clearTimeout(nowPlayingTimer));
    $: if (browser && $currentTrack) {
        const track = $currentTrack as any;
        const id = track?.videoId ?? track?.id;
        if (id !== announcedVideoId) {
            announcedVideoId = id;
            if (skipNextAnnouncement) {
                skipNextAnnouncement = false;
            } else {
                clearTimeout(nowPlayingTimer);
                nowPlayingTimer = setTimeout(() => {
                    const title = track?.title ?? "";
                    const artist = track?.artistInfo?.artist?.[0]?.text ?? track?.artist ?? "";
                    if (!title) return;
                    nowPlayingMessage = artist ? `Lecture : ${title} · ${artist}` : `Lecture : ${title}`;
                }, 1000);
            }
        }
    }
</script>

<svelte:body class={$fullscreenStore === "open" ? "no-scroll" : ""}/>
<svelte:window
    on:popstate={() => {
		if (browser) {
			const { state } = history;
			if (state) {
				const { info: _info } = state;
				console.log({ _info, state });
				if (_info) {
					info = _info;
				}
			}
		}
	}}
    on:pagehide={({ persisted }) => {
		if (persisted) return console.log(persisted);
		if (!browser) return;
		if (groupSession.initialized && groupSession.hasActiveSession) {
			groupSession.disconnect();
		}

		AudioPlayer?.dispose?.();
	}}
/>
{#if info}
    <div
        class="info"
        style="position: fixed; z-index: 10000000000; top: 0;
left: 0; background: var(--base-bg); font-size: 1.1rem; display: flex; flex-direction: column;"
    >
        {#each Object.entries(info) as [key, value]}
            <p><strong>{key}</strong> - {value}</p>
        {/each}
    </div>
{/if}
<Nav
    {key}
    --top-bar-width={isFullscreen
		? "calc(100%)"
		: "calc(100% - var(--scrollbar-width) + 0.05em)"}
    bind:fullscreen={isFullscreen}
    bind:opacity={scrollTop}
/>
<Popper {main}/>
<div
    class="wrapper app-content-m"
    {hasplayer}
    id="wrapper"
>
    <Wrapper
        on:scrolled={(e) => {
			scrollTop = !e.detail ? 100 : 0;
		}}
        {key}
        animate={!$page.error}
        bind:main
    >
        <slot/>
    </Wrapper>
</div>
<svelte:component
    this={$PlaylistPopper}
    on:close={() => {
		showAddToPlaylistPopper.set({ state: false, item: {} });
	}}
/>
<svelte:component this={$GroupSessionCreator} />

<div class="sr-only" role="status" aria-live="polite" data-testid="now-playing-live">{nowPlayingMessage}</div>
{#if !online && !$page.url.pathname.startsWith("/library/downloads-offline")}
    <div class="offline-banner" role="status" aria-live="polite">
        <span class="offline-dot" aria-hidden="true"></span>
        <span>Hors connexion : les pages en ligne ne se chargent pas.</span>
        <a href="/library/downloads-offline">Écouter ma musique hors-ligne</a>
    </div>
{/if}
<InstallHint />
<Alert --alert-bottom={hasplayer ? "5.75em" : "0rem"} />
<svelte:component this={$Fullscreen} state={isFullscreen ? "open" : "closed"} />
<footer
    class="footer-container"
    class:show-player={hasplayer}
>
    <!-- <GroupSessionManager /> -->
    <Player/>
</footer>

<style
    lang="scss"
    global
>
    @import "../global/redesign/main.scss";

    .footer-container {
        transition: transform cubic-bezier(0.165, 0.84, 0.44, 1) 350ms,
        opacity cubic-bezier(0.165, 0.84, 0.44, 1) 350ms;
        opacity: 0;
        will-change: transform;
        transform: translate3d(0, var(--player-bar-height), 0);
    }

    .show-player {
        will-change: initial;
        opacity: 1;
        transform: translate3d(0, 0, 0);
    }

    .wrapper {
        -webkit-overflow-scrolling: touch;
    }

    .offline-banner {
        position: fixed;
        left: 50%;
        transform: translateX(-50%);
        bottom: calc(var(--player-bar-height, 5.75em) + 0.75rem);
        z-index: 60;
        display: flex;
        align-items: center;
        gap: 0.6rem;
        max-width: calc(100vw - 2rem);
        padding: 0.55rem 0.9rem;
        border-radius: 999px;
        background: rgba(20, 20, 24, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #eee;
        font-size: 0.85rem;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
    }

    .offline-banner a {
        color: #7ee0a5;
        font-weight: 600;
        text-decoration: underline;
        white-space: nowrap;
    }

    .offline-dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 50%;
        background: #f0b429;
        flex: none;
    }
</style>
