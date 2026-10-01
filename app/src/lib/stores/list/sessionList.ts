/* eslint-disable @typescript-eslint/no-explicit-any */
import { APIParams } from "$lib/constants";
// eslint-disable-next-line import/no-cycle
import { getSrc, updateGroupPosition, updatePlayerSrc } from "$lib/player";
import type {
    Artist,
    ArtistInfo,
    Item,
    Song,
    Subtitle,
    Thumbnail,
} from "$lib/types";
import type { VssLoggingContext } from "$lib/types/innertube/internals";
import {
    Logger,
    WritableStore,
    addToQueue,
    notify,
    seededShuffle,
    type ResponseBody,
} from "$lib/utils";
import { splice } from "$lib/utils/collections/array";
import { objectKeys } from "$lib/utils/collections/objects";
import { Mutex } from "$lib/utils/sync";
import { tick } from "svelte";
// eslint-disable-next-line import/no-cycle
import { syncTabs } from "$lib/tabSync";
import { derived } from "svelte/store";
import { groupSession } from "../sessions";
import { filterAutoPlay, playerLoading } from "../stores";
import type { ISessionListProvider } from "./types.list";
import { fetchNext, filterList } from "./utils.list";
import { APIClient } from "$lib/api";
import { SERVER_DOMAIN } from "../../../env";

const mutex = new Mutex();

interface AutoMixArgs {
    clickedItem?: Item;
    clickTracking?: string;
    config?: { playerParams?: string; type?: string };
    keyId?: number;
    loggingContext?: { vssLoggingContext: { serializedContextData: string } };
    playlistId?: string;
    playlistSetVideoId?: string;
    videoId?: string;
    visitorData?: string;
    mode?: "local" | "remote";
    localItems?: Item[];
}

function togglePlayerLoad() {
    playerLoading.set(true);
    return () => playerLoading.set(false);
}

type MixListAppendOp = [op: "append" | "set", data: Item[]];

/**
 * Owned-library (local) track id: 11 lowercase hex chars, the same rule as the
 * backend's `isLid()`. Such an id is not a YouTube videoId and must never be
 * sent to `get_queue.json`.
 */
export function isLocalTrackId(id: string | undefined | null): boolean {
    return typeof id === "string" && /^[0-9a-f]{11}$/.test(id);
}

const VALID_KEYS = [
    "clickTrackingParams",
    "continuation",
    "currentMixId",
    "currentMixType",
    "visitorData",
    "related",
    "mix",
    "position",
] as const;

export class ListService {
    private isLocal = false;
    // Instant-start URL for position + 1, with an expiry (signed stream URLs
    // die; a long pause must not make next() play a dead URL).
    private nextTrackUrl: { url: string; expiresAt: number } | null = null;
    private restricted = false;

    _$: WritableStore<ISessionListProvider> =
        new WritableStore<ISessionListProvider>({
            clickTrackingParams: "",
            continuation: "",
            currentMixId: "",
            currentMixType: null,
            visitorData: "",
            mix: [],
            position: 0,
            related: null,
        });

    constructor() {
        this._$.set(this._state);
    }

    public get $() {
        return this._$;
    }

    public get clickTrackingParams(): string | null {
        return this._$.value.clickTrackingParams;
    }

    public get continuation() {
        return this._$.value.continuation;
    }

    public get currentMixId(): string {
        return this._$.value.currentMixId;
    }

    public get mix() {
        return this._$.value.mix.slice();
    }

    public get position() {
        return this._$.value.position;
    }

    public get set() {
        return this._$.set;
    }

    public get subscribe() {
        return this._$.subscribe;
    }

    public get isLocalPlaylist() {
        return this.isLocal;
    }

    public get value() {
        return this._state;
    }

    private get _state() {
        return this._$.value;
    }

    private clearNextTrack() {
        this.nextTrackUrl = null;
    }

    private findIndexForTrack({
        originalVideoId,
        originalIndex,
        originalPlaylistId,
        mix,
    }: {
        originalIndex?: number;
        originalVideoId?: string;
        originalPlaylistId?: string;
        mix: Item[];
    }): number {
        return mix.findIndex((item, index) => {
            // find the index of the item that matches the videoId and optionally the playlist id OR the index property (or array index) that matches the keyId OR  matches both previous condiitions
            const isSameVideoAndPlaylist =
                item.videoId === originalVideoId &&
                item.playlistId === originalPlaylistId;
            const isSameIndex = index === originalIndex;

            if (isSameVideoAndPlaylist || isSameIndex) {
                return true;
            }

            if (isSameVideoAndPlaylist && isSameIndex) {
                return true;
            }

            return false;
        });
    }

    public async getMoreLikeThis({
        playlistId,
    }: {
        playlistId?: string;
    }): Promise<void> {
        const toggle = togglePlayerLoad();
        await tick();

        try {
            const response = await fetchNext({
                params: APIParams.finite,
                playlistId:
                    playlistId != null && !!playlistId
                        ? playlistId?.startsWith("RDAMPL")
                            ? playlistId
                            : "RDAMPL" + playlistId
                        : this._$.value.currentMixId,
            });

            if (!response || !response.results.length) {
                throw new Error("Invalid response returned by `next` endpoint");
            }

            if (this._$.value.mix.length) {
                response.results.shift();
            }

            const state = await this.#sanitizeAndUpdate("APPLY", {
                ...response,
                mix: ["append", response.results],
            });

            if (groupSession?.initialized && groupSession?.hasActiveSession) {
                groupSession.updateGuestTrackQueue(state);
            }

            await getSrc(
                this._$.value.mix[state.position + 1].videoId,
                this._$.value.mix[state.position + 1].playlistId,
                undefined,
                false,
            );
        } catch (err) {
            Logger.err(err);
            notify(err as string, "error");
        } finally {
            toggle();
        }
    }

    public async getSessionContinuation(
        {
            playlistSetVideoId,
            clickTrackingParams,
            ctoken,
            key,
            playlistId,
            playerParams,

            videoId,
            loggingContext,
        }: {
            itct?: string;
            videoId: string;
            playlistId: string | undefined;
            ctoken: string;
            clickTrackingParams: string;
            loggingContext?: { vssLoggingContext: { serializedContextData: string } };
            key: number;
            playerParams?: string;
            playlistSetVideoId?: string;
        },
        autoPlay = true,
    ): Promise<ResponseBody | void> {
        const toggle = togglePlayerLoad();
        await tick();

        if (key < this._$.value.mix.length - 1) {
            const nextIndex = await this.updatePosition(key);
            if (groupSession.initialized && groupSession.hasActiveSession) {
                updateGroupPosition("->", nextIndex);
            }
            const nextTrack = this._$.value.mix[nextIndex];
            await getSrc(nextTrack?.videoId, nextTrack?.playlistId, undefined, true);
            // prefetch of nextIndex + 1 is scheduled by updatePosition() above
            syncTabs.updatePosition(nextIndex);
            toggle();
            return;
        }

        try {
            if (!clickTrackingParams && !ctoken) {
                playlistId = `RDAMPL${playlistId ? playlistId : this.currentMixId ?? ""
                    }`;
            }

            const params: Parameters<typeof fetchNext>["0"] = {
                ...(this._$.value?.visitorData && {
                    visitorData: this._$.value?.visitorData,
                }),
                params: playerParams ?? encodeURIComponent("OAHyAQIIAQ=="),
                playlistSetVideoId:
                    playlistSetVideoId ?? this._$.value.mix[key]?.playlistSetVideoId,
                loggingContext:
                    loggingContext?.vssLoggingContext?.serializedContextData,
                videoId,
                playlistId,
                index: key ?? undefined,
                ...(ctoken && { continuation: ctoken }),
                clickTracking: clickTrackingParams,
            };
            const data = await fetchNext(params);

            if (!data || !Array.isArray(data.results)) {
                await this.getMoreLikeThis({ playlistId });
                return;
            }

            const results = data.results;

            const state = await this.#sanitizeAndUpdate("APPLY", {
                ...data,
                mix: ["append", results],
            });
            if (groupSession?.initialized && groupSession?.hasActiveSession) {
                groupSession.updateGuestContinuation(state);
            }

            syncTabs.updateSessionList(state);
            if (autoPlay) {
                const src = await getSrc(state.mix[key].videoId);

                return src?.body ?? ({} as ResponseBody);
            }
        } catch (err) {
            Logger.err(err);
            if (playlistId?.startsWith("RDAMPL")) return;
            return this.getSessionContinuation(
                {
                    clickTrackingParams,
                    ctoken,
                    key,
                    videoId,
                    playlistId: `RDAMPL${playlistId}`,
                    loggingContext,
                    playerParams,
                    playlistSetVideoId,
                },
                autoPlay,
            );
        } finally {
            toggle();
        }
    }

    public async initAutoMixSession(args: AutoMixArgs) {
        const toggle = togglePlayerLoad();
        this.isLocal = false;
        try {
            const {
                clickedItem,
                loggingContext,
                keyId,
                clickTracking,
                config,
                playlistId,
                visitorData,
                playlistSetVideoId,
                videoId,
                mode = "remote",
            } = args;
            // Wait for the DOM to update
            await tick();
            console.log(args);
            let willRevert = false;
            this.clearNextTrack();

            if (mode === "local") {
                const itemsToPlay = args.localItems || (clickedItem ? [clickedItem] : []);
                if (itemsToPlay.length === 0) {
                    throw new Error("clickedItem or localItems is required for local playback");
                }
                this.isLocal = true;
                await this.setMix(itemsToPlay, "local");
                await getSrc(videoId, playlistId, undefined, true);
                this.schedulePrefetch();
                return;
            }

            // Reset the current mix state
            if (
                this._$.value.mix.length &&
                this._$.value.currentMixId !== playlistId
            ) {
                willRevert = true;
                this.#revertState();
            }

            if (
                this._$.value.currentMixId !== undefined &&
                (this._$.value.currentMixId !== playlistId ||
                    `RDAMPL${this._$.value.currentMixId}` !== playlistId)
            ) {
                this._$.value.currentMixType = "auto";

                const data = await fetchNext({
                    params: config?.playerParams ? config?.playerParams : undefined,
                    videoId,
                    ...(visitorData && { visitorData }),
                    playlistId: playlistId ? playlistId : `RDAMVM${videoId}`,
                    loggingContext: loggingContext
                        ? loggingContext.vssLoggingContext?.serializedContextData
                        : undefined,
                    playlistSetVideoId: playlistSetVideoId
                        ? playlistSetVideoId
                        : undefined,
                    clickTracking,
                    configType: config?.type || undefined,
                });

                if (!data || !Array.isArray(data.results)) {
                    throw new Error(
                        "Invalid response was returned from `next` endpoint.",
                    );
                }

                if (videoId != "" && clickedItem != undefined && data.results[0].videoId != videoId) {
                    data.results.unshift(clickedItem);
                }

                const playbackIndex =
                    keyId === 0
                        ? 0
                        : this.findIndexForTrack({
                            originalVideoId: videoId,
                            originalPlaylistId: playlistId,
                            mix: data.results,
                            originalIndex: keyId,
                        }) ||
                        keyId ||
                        0;
                const item = data.results[playbackIndex ?? 0];

                const state = await this.#sanitizeAndUpdate(
                    willRevert ? "SET" : "APPLY",
                    {
                        ...this._state,
                        ...data,
                        position: Math.max(0, playbackIndex),
                        mix: ["append", data.results],
                    },
                );
                await tick();
                const selectedVideoId = videoId ||
                    item?.videoId ||
                    data.results[0]?.videoId;

                if (!selectedVideoId) {
                    throw new Error("No valid videoId found for playback");
                }

                await getSrc(
                    selectedVideoId,
                    item?.playlistId || playlistId,
                    config?.playerParams,
                );
                // Position was set through #sanitizeAndUpdate (not
                // updatePosition), so warm position + 1 explicitly.
                this.schedulePrefetch(state.position);
                syncTabs.updateSessionList(state);

                if (groupSession?.initialized && groupSession?.hasActiveSession) {
                    groupSession.expAutoMix(state);
                }
            } else {
                return await this.getSessionContinuation({
                    ...args,
                    clickTrackingParams: args.clickTracking!,
                    key: args.keyId!,
                    ctoken: "",
                } as never);
            }
        } catch (err) {
            Logger.err(err);
        } finally {
            toggle();
        }
    }

    public async initPlaylistSession(args: {
        playlistId: string;
        index: number;
        clickTrackingParams?: string;
        params?: string;
        videoId?: string;
        loggingContext?: string;
        visitorData?: string;
        playlistSetVideoId?: string;
    }): Promise<{ body: ResponseBody; error?: boolean } | undefined> {
        const toggle = togglePlayerLoad();
        this.isLocal = false;

        try {
            const {
                playlistId = "",
                index = 0,
                clickTrackingParams = "",
                params = "",
                videoId = "",
                loggingContext,
                playlistSetVideoId = "",
                visitorData = "",
            } = args;

            await tick();

            if (this._$.value.currentMixId !== playlistId) {
                this.clearNextTrack();

                this.#revertState();
            }
            const data = await fetchNext({
                params,
                playlistId: playlistId.startsWith("VL")
                    ? playlistId.slice(2)
                    : playlistId,
                loggingContext,
                clickTracking: clickTrackingParams,
                visitorData,
                playlistSetVideoId,
                videoId,
            });

            if (!data || !Array.isArray(data.results)) {
                throw new Error("Invalid response returned from `next` endpoint.");
            }

            if (!data.results.length) {
                Logger.dev("NO RESULTS LENGTH!!!");
                this.getMoreLikeThis({ playlistId });
            } else {
                const state = await this.#sanitizeAndUpdate("APPLY", {
                    ...data,
                    mix: ["set", data.results],
                    currentMixType: "playlist",
                });

                const playbackIndex =
                    index === 0
                        ? 0
                        : this.findIndexForTrack({
                            originalVideoId: videoId,
                            originalPlaylistId: playlistId,
                            mix: state.mix,
                            originalIndex: index,
                        }) ||
                        index ||
                        0;
                await this.updatePosition(playbackIndex);
                Logger.mark("wow");
                await tick();
                syncTabs.updateSessionList(state);
                if (groupSession?.initialized && groupSession?.hasActiveSession) {
                    groupSession.expAutoMix(state);
                }

                return (await getSrc(
                    state.mix[playbackIndex]?.videoId,
                    playlistId,
                    undefined,
                    true,
                )) as any;
            }
        } catch (err) {
            Logger.err(err);
            notify("Error starting playlist playback.", "error");
        } finally {
            toggle();
        }
    }

    public lockedSet(_mix: ISessionListProvider): Promise<ISessionListProvider> {
        return mutex.do(async () => {
            this._$.set(_mix);
            return Promise.resolve(this._state);
        });
    }

    public async next(nextSrc: string | undefined = undefined, update = false) {
        const currentPosition = this._$.value.position;
        const nextTrack = this._$.value.mix[this._$.value.position + 1];

        if (!nextTrack) {
            if (this.isLocal) return; // Don't fetch more for local
            const currentTrack = this._$.value.mix[this._$.value.position];
            Logger.dev("No next track", { nextSrc, _$: this._$ });
            await this.getSessionContinuation(
                {
                    videoId: currentTrack?.videoId,
                    key: this._$.value.position + 1,
                    playlistId: currentTrack?.playlistId,
                    loggingContext: currentTrack?.loggingContext,
                    playerParams: currentTrack?.playerParams,
                    playlistSetVideoId:
                        APIParams.lt100 === currentTrack?.playerParams
                            ? undefined
                            : currentTrack?.playlistSetVideoId,

                    ctoken: this.continuation,
                    clickTrackingParams: this.clickTrackingParams!,
                },
                true,
            )
                .then(() => {
                    syncTabs.updatePosition(currentPosition + 1);
                    return this.updatePosition("next");
                })
                .then((data) => {
                    return data;
                });

            return;
        } else {
            // A stale (expired) prefetched URL is dropped: the regular
            // getSrc() path below re-resolves the stream.
            const warm = this.freshNextTrackUrl();
            if (nextSrc || warm) {
                Logger.dev("next track Cond A", {
                    nextSrc,
                    _$: this._$,
                    nextTrack,
                    thisNextTrackURL: warm,
                });
                // Capture before updatePosition(): it clears `nextTrackUrl`
                // and schedules the prefetch of the new position + 1.
                const url = nextSrc ? (nextSrc as string) : (warm as string);
                this.nextTrackUrl = null;
                await this.updatePosition("next");
                updatePlayerSrc({ original_url: url, url });
            } else {
                let position = await this.updatePosition("next");
                if (position >= this._$.value.mix.length) {
                    position = this._$.value.position;
                }

                if (this.isLocal) {
                    await getSrc(
                        this._$.value.mix[position].videoId,
                        this._$.value.mix[position].playlistId,
                        undefined,
                        true,
                    );
                } else {
                    const currentTrack = this.#currentTrack(position);
                    const data = await fetchNext({
                        ...(this._$.value?.visitorData && {
                            visitorData: this._$.value.visitorData,
                        }),
                        params: "gAQBiAQB",
                        playlistSetVideoId: currentTrack?.playlistSetVideoId,
                        index: position,
                        loggingContext:
                            currentTrack?.loggingContext?.vssLoggingContext
                                ?.serializedContextData,
                        videoId: currentTrack?.videoId,
                        playlistId: this.currentMixId,
                        ...(this?.clickTrackingParams && {
                            clickTracking: this.clickTrackingParams,
                        }),
                    });
                    if (!data) return console.log("no data on next", { data });

                    const state = await this.#sanitizeAndUpdate("APPLY", data);
                    await getSrc(
                        state.mix[currentPosition + 1].videoId,
                        state.mix[currentPosition + 1].playlistId,
                        undefined,
                        true,
                    );
                    // The mix was just extended: position + 1 may only exist now.
                    this.schedulePrefetch(state.position);
                }
            }
            const position = this._$.value.position;
            if (update) {
                updateGroupPosition("->", position);
            }

            syncTabs.updatePosition(position);
        }
    }

    /**
     * Prefetch bookkeeping. `_prefetched` maps videoId -> resolved audio URL
     * (dedupe + short-lived URL cache so a track prefetched as "+2" is promoted
     * to "next" without a second round-trip). Stream URLs expire, hence the TTL.
     */
    private _prefetched = new Map<string, { url: string; at: number; expiresAt: number }>();
    private _prefetchInflight = new Set<string>();
    private _prefetchTimer: ReturnType<typeof setTimeout> | null = null;
    private _prefetchGen = 0;
    /** Default lifetime of a resolved stream URL when it carries no `expire=`. */
    private static readonly PREFETCH_TTL_MS = 20 * 60 * 1000;
    /** Safety margin before a googlevideo `expire=` deadline. */
    private static readonly EXPIRE_MARGIN_MS = 60 * 1000;

    /**
     * When a resolved URL stops being playable. Googlevideo URLs (direct or
     * wrapped in `/vp?u=…`) carry `expire=<unix seconds>`; everything else
     * (local files, `/aud/<id>`) gets the default TTL.
     */
    private static audioUrlExpiry(url: string, now = Date.now()): number {
        const fallback = now + ListService.PREFETCH_TTL_MS;
        try {
            let target = url;
            const u = new URL(url, "https://music.invalid/");
            const wrapped = u.searchParams.get("u");
            if (wrapped) target = wrapped;
            const m = /[?&]expire=(\d{9,11})(?:&|$)/.exec(target);
            if (!m) return fallback;
            const exp = parseInt(m[1], 10) * 1000 - ListService.EXPIRE_MARGIN_MS;
            return exp > now ? Math.min(exp, fallback) : now;
        } catch {
            return fallback;
        }
    }

    /** The instant-start URL for position + 1 if it has not expired (else null, and forgotten). */
    private freshNextTrackUrl(): string | null {
        const n = this.nextTrackUrl;
        if (!n) return null;
        if (Date.now() >= n.expiresAt) {
            this.nextTrackUrl = null;
            return null;
        }
        return n.url;
    }
    private static readonly PREFETCH_CACHE_MAX = 64;
    /** Let the current track's own player.json go out first. */
    private static readonly PREFETCH_NEXT_DELAY_MS = 250;
    /** Lower priority: position + 2 only once "next" is settled. */
    private static readonly PREFETCH_AHEAD_DELAY_MS = 4000;

    private cancelScheduledPrefetch() {
        this._prefetchGen++;
        if (this._prefetchTimer) {
            clearTimeout(this._prefetchTimer);
            this._prefetchTimer = null;
        }
    }

    /** Forget every cached prefetch URL (the queue was replaced). */
    private invalidatePrefetch() {
        this.cancelScheduledPrefetch();
        this._prefetched.clear();
        this._prefetchInflight.clear();
        this.clearNextTrack();
    }

    /**
     * Fire-and-forget, called whenever a track starts or the queue around the
     * current position changes: prefetch `position + 1` almost immediately
     * (this is what lets `next()` start instantly via `nextTrackUrl`), then
     * `position + 2` at a lower priority. Any newer call supersedes it.
     * Never awaited by playback code paths.
     */
    private schedulePrefetch(position = this._$.value.position) {
        this.cancelScheduledPrefetch();
        if (typeof setTimeout === "undefined") return;
        const gen = this._prefetchGen;
        const live = () => gen === this._prefetchGen && this._$.value.position === position;

        this._prefetchTimer = setTimeout(() => {
            this._prefetchTimer = null;
            if (!live()) return;
            void this.prefetchTrackAtIndex(position + 1).finally(() => {
                if (!live()) return;
                this._prefetchTimer = setTimeout(() => {
                    this._prefetchTimer = null;
                    if (!live()) return;
                    void this.prefetchTrackAtIndex(position + 2);
                }, ListService.PREFETCH_AHEAD_DELAY_MS);
            });
        }, ListService.PREFETCH_NEXT_DELAY_MS);
    }

    public async prefetchNextTrack() {
        return this.prefetchTrackAtIndex(this.position + 1);
    }

    /**
     * Pick the audio stream URL out of a `player.json` response. Same rule as
     * `resolveAudioUrl` in `$lib/offline` (kept in sync by hand, not imported):
     * first adaptive format whose mimeType starts with `audio` and has a url.
     * URLs are passed through verbatim (same-origin `/localf`, `/vp`, `/aud/…`
     * or transitional absolute `https://ytify.ekaii.fr/…`).
     */
    private static pickAudioUrl(player: any): string {
        const fmts: any[] = player?.streamingData?.adaptiveFormats;
        if (!Array.isArray(fmts)) return "";
        const audio = fmts.find(
            (f) => f && typeof f.url === "string" && f.url && /^audio/i.test(f.mimeType || ""),
        );
        return (audio && audio.url) || "";
    }

    /**
     * Hand a resolved next-track URL to the offline layer (`$lib/offline`
     * listens to `ytm:prefetched` and is the ONLY caller of the service
     * worker's `cache-audio`, so a prefetch never downloads a track twice).
     * Best-effort, no-op on SSR.
     */
    private static announcePrefetched(item: Item, url: string) {
        try {
            if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
                window.dispatchEvent(
                    new CustomEvent("ytm:prefetched", { detail: { item, url } }),
                );
            }
        } catch {
            /* listeners are optional */
        }
    }

    private rememberPrefetched(vid: string, url: string) {
        if (this._prefetched.size >= ListService.PREFETCH_CACHE_MAX) {
            const oldest = this._prefetched.keys().next().value;
            if (oldest !== undefined) this._prefetched.delete(oldest);
        }
        const at = Date.now();
        this._prefetched.set(vid, { url, at, expiresAt: ListService.audioUrlExpiry(url, at) });
    }

    /**
     * If `vid` is (still) the track right after the current one, make it the
     * instant-start URL consumed by `next()`.
     */
    private promoteIfNext(index: number, vid: string, url: string) {
        const nextIdx = this._$.value.position + 1;
        if (index === nextIdx && this._$.value.mix?.[nextIdx]?.videoId === vid) {
            const known = this._prefetched.get(vid);
            this.nextTrackUrl = {
                url,
                expiresAt: known && known.url === url ? known.expiresAt : ListService.audioUrlExpiry(url),
            };
        }
    }

    /**
     * Prefetch the track at `index`: resolve `player.json`, extract the audio
     * URL, ask the service worker to cache it, notify the offline layer, and
     * (when `index` is position + 1) remember it so `next()` starts instantly.
     * Best-effort: never throws, never blocks playback, deduped by videoId.
     */
    public async prefetchTrackAtIndex(index: number) {
        try {
            const track = this._$.value.mix?.[index];
            const vid = track?.videoId;
            if (!vid || this._prefetchInflight.has(vid)) return;

            const cached = this._prefetched.get(vid);
            if (cached && Date.now() < cached.expiresAt) {
                // Already resolved (and already handed to the SW): only promote.
                this.promoteIfNext(index, vid, cached.url);
                return;
            }
            this._prefetched.delete(vid);

            let url = "";
            if (track.localUrl) {
                url = track.localUrl;
            } else {
                this._prefetchInflight.add(vid);
                try {
                    // Direct fetch (APIClient.fetch takes no headers): the
                    // `X-Ytm-Prefetch: 1` header tells the backend this is a
                    // prefetch, not a play, so it triggers no acquisition.
                    const res = await fetch(
                        `${SERVER_DOMAIN}/api/v1/player.json?videoId=${encodeURIComponent(vid)}`,
                        { headers: { "X-Ytm-Prefetch": "1" }, credentials: "same-origin" },
                    );
                    if (res && res.ok) {
                        url = ListService.pickAudioUrl(await res.json());
                    }
                } catch {
                    url = "";
                } finally {
                    this._prefetchInflight.delete(vid);
                }
            }
            if (!url) return;

            this.rememberPrefetched(vid, url);
            ListService.announcePrefetched(track, url);
            this.promoteIfNext(index, vid, url);
        } catch {
            /* prefetch is best-effort */
        }
    }

    public async previous() {
        let position = await this.updatePosition("back");
        if (position >= this._$.value.mix.length) {
            position = this._$.value.position;
        }

        if (this.isLocal) {
            await getSrc(
                this._$.value.mix[position].videoId,
                this._$.value.mix[position].playlistId,
                undefined,
                true,
            );
        } else {
            const data = await fetchNext({
                ...(this._$.value?.visitorData && {
                    visitorData: this._$.value?.visitorData,
                }),
                params: "OAHyAQIIAQ==",
                playlistSetVideoId: this._$.value.mix[this.position]?.playlistSetVideoId,
                index: this._$.value.position,
                loggingContext: this.#currentTrack(this.position)?.loggingContext
                    ?.vssLoggingContext?.serializedContextData,
                videoId: this.#currentTrack(this.position)?.videoId,
                playlistId: this.currentMixId,
                ...(this.continuation && { continuation: this?.continuation }),
                ...(this.clickTrackingParams && {
                    clickTracking: this.clickTrackingParams,
                }),
            });
            if (!data) return;
            if (data.related) this._$.value.related = data.related;
            const state = await this.#sanitizeAndUpdate("APPLY", data);
            await getSrc(
                state.mix[position].videoId,
                state.mix[position].playlistId,
                undefined,
                true,
            );
        }

        syncTabs.updatePosition(position);
    }

    /**
     * Remove the row at `index`. The cursor keeps pointing at the playing
     * track (it shifts left by one when a row before it is removed); removing
     * the current row leaves the cursor on the row that took its place.
     */
    public removeTrack(index: number) {
        const { mix, position } = this._$.value;
        if (index < 0 || index >= mix.length) return;
        const next = [...mix.slice(0, index), ...mix.slice(index + 1)];
        const newPosition =
            index < position
                ? position - 1
                : Math.min(position, Math.max(next.length - 1, 0));
        this._$.update((u) => ({ ...u, mix: next, position: newPosition }));
        // The track after the current one may have changed.
        this.clearNextTrack();
        this.schedulePrefetch();
        syncTabs.updateSessionList(this._$.value);
    }

    /**
     * "Vider la file": keep only the current track (it becomes row 0 and keeps
     * playing). No-op when the queue has at most one row. The playlist
     * continuation is dropped so the old list does not refill the queue.
     */
    public async clearQueue(): Promise<boolean> {
        const { mix, position } = this._$.value;
        if (mix.length <= 1) return false;
        const current = mix[Math.min(Math.max(position, 0), mix.length - 1)];
        this.invalidatePrefetch();
        const state = await this.#sanitizeAndUpdate("APPLY", {
            mix: ["set", [current]] satisfies MixListAppendOp,
            position: 0,
            continuation: "",
        });
        this.clearNextTrack();
        syncTabs.updateSessionList(state);
        if (groupSession?.initialized && groupSession?.hasActiveSession) {
            groupSession.send(
                "PUT",
                "state.set.mix",
                JSON.stringify(state),
                groupSession.client,
            );
        }
        return true;
    }

    /**
     * Queue row "Lire ensuite": move the track at `index` right after the
     * current one. The cursor keeps pointing at the playing track (it shifts
     * left by one when a row before it is moved). No-op for the current track,
     * the one already next, or an out-of-range index.
     */
    public async moveTrackNext(index: number): Promise<boolean> {
        const mix = this._$.value.mix.slice();
        const position = this._$.value.position;
        if (index < 0 || index >= mix.length) return false;
        if (index === position || index === position + 1) return false;
        const [track] = mix.splice(index, 1);
        const newPosition = index < position ? position - 1 : position;
        mix.splice(newPosition + 1, 0, track);
        const state = await this.#sanitizeAndUpdate("APPLY", {
            mix: ["set", mix] satisfies MixListAppendOp,
            position: newPosition,
        });
        this.clearNextTrack();
        this.schedulePrefetch(state.position);
        syncTabs.updateSessionList(state);
        if (groupSession?.initialized && groupSession?.hasActiveSession) {
            groupSession.send("PUT", "state.update.mix", this.toJSON(), groupSession.client);
        }
        notify(`« ${track?.title ?? "Le morceau"} » sera lu ensuite`, "success");
        return true;
    }

    public async setMix(mix: Item[], type?: "auto" | "playlist" | "local") {
        this.invalidatePrefetch();
        const guard = await mutex.do(async () => {
            await tick();
            return new Promise<ISessionListProvider>((resolve) => {
                this.#sanitizeAndUpdate("SET", {
                    ...this._state,
                    mix: ["set", mix],
                    currentMixType: type,
                }),
                    resolve(this._state);
            });
        });
        this.isLocal = type === "local";
        if (groupSession?.initialized && groupSession?.hasActiveSession) {
            groupSession.send(
                "PUT",
                "state.set.mix",
                JSON.stringify(guard),
                groupSession.client,
            );
        }
        syncTabs.updateSessionList(guard);
    }

    /**
     * Tracks to insert for a row: local / offline items are inserted as-is (a
     * lid is not a YouTube id; the row already carries title, thumbnails and
     * videoId, and getSrc() plays a lid or a `localUrl` directly). YouTube
     * items go through `get_queue.json` (a playlist/album row expands to its
     * tracks); when that returns nothing the row itself is inserted so a
     * flaky endpoint never silently drops the action.
     */
    private async resolveQueueItems(item: Item): Promise<Item[]> {
        if (item.localUrl || isLocalTrackId(item.videoId)) return [{ ...item }];
        const fetched = await addToQueue(item);
        if (Array.isArray(fetched) && fetched.length) return fetched as Item[];
        if (item.videoId) return [item];
        return [];
    }

    /**
     * "Lire ensuite": insert `item` right after the current track. Empty
     * queue: becomes the first (and playing) track.
     */
    public playNext(item: Item): Promise<boolean> {
        const key = this._$.value.mix.length ? this._$.value.position : -1;
        return this.setTrackWillPlayNext(item, key);
    }

    /**
     * "Ajouter à la file": append `item` at the end of the queue. Empty queue:
     * becomes the first (and playing) track.
     */
    public addToQueueEnd(item: Item): Promise<boolean> {
        return this.setTrackWillPlayNext(item, this._$.value.mix.length - 1);
    }

    /**
     * Insert `item` (or the tracks it expands to) at `key + 1`. Resolves to
     * true when something was inserted; errors are notified (in French) and
     * resolve to false so callers can skip their success toast.
     */
    public async setTrackWillPlayNext(item: Item, key: number): Promise<boolean> {
        await tick();
        if (!item) {
            notify("Aucun morceau à ajouter à la file", "error");
            return false;
        }
        try {
            const itemToAdd = await this.resolveQueueItems(item);
            if (!itemToAdd.length) {
                notify("Impossible d'ajouter ce morceau à la file", "error");
                return false;
            }
            const oldLength = this._$.value.mix.length;

            splice(this._$.value.mix, key + 1, 0, ...itemToAdd);

            const state = await this.#sanitizeAndUpdate("APPLY", {
                mix: ["set", this._$.value.mix] satisfies MixListAppendOp,
            });

            if (!oldLength) {
                await getSrc(
                    this._$.value.mix[0].videoId,
                    this._$.value.mix[0].playlistId,
                    undefined,
                    true,
                );
            }
            // "Play next" inserts right after the current track: re-warm.
            this.clearNextTrack();
            this.schedulePrefetch(state.position);
            syncTabs.updateSessionList(state);
            return true;
        } catch (err) {
            console.error(err);
            notify(`Impossible d'ajouter à la file : ${err}`, "error");
            return false;
        }
    }

    public shuffle(index: number, preserveBeforeActive = true) {
        if (typeof index !== "number") return;
        if (!preserveBeforeActive) {
            this._$.value.mix = seededShuffle(
                this._$.value.mix.slice(),
                crypto
                    .getRandomValues(new Uint8Array(8))
                    .reduce((prev, cur) => (prev += cur), 0),
            );
        } else {
            this._$.value.mix = [
                ...this._$.value.mix.slice().slice(0, index),
                this._$.value.mix[index],
                ...seededShuffle(
                    this._$.value.mix.slice().slice(index + 1),
                    crypto
                        .getRandomValues(new Uint8Array(8))
                        .reduce((prev, cur) => (prev += cur), 0),
                ),
            ];
        }
        // console.log(mix)
        this.#sanitizeAndUpdate("APPLY", { mix: this._$.value.mix }).then(
            (state) => {
                this.clearNextTrack();
                this.schedulePrefetch(state.position);
                if (groupSession?.initialized && groupSession?.hasActiveSession) {
                    groupSession.updateGuestTrackQueue(state);
                }
                syncTabs.updateSessionList(state);
            },
        );
    }

    public shuffleRandom(
        items: ({
            subtitle: { text?: string; pageType?: string; browseId?: string }[] &
            Subtitle[];
            artistInfo: {
                pageType?: string;
                artist?: Artist[];
                browseId?: string;
            } & ArtistInfo;
            explicit: boolean;
            title: string;
            aspectRatio: string;
            playerParams?: string;
            playlistSetVideoId?: string;
            clickTrackingParams?: string;
            endpoint?: { browseId: string; pageType: string };
            musicVideoType?: string;
            params?: string;
            index?: number;
            length?: string & { text?: string };
            videoId: string;
            playlistId: string;
            loggingContext?: { vssLoggingContext: VssLoggingContext };
            thumbnails: Thumbnail[];
            type?: string;
        } & Song)[],
    ): void {
        this._$.value.mix = seededShuffle(
            items,
            crypto
                .getRandomValues(new Uint8Array(8))
                .reduce((prev, cur) => (prev += cur), 0),
        );

        this.#sanitizeAndUpdate("SET", { mix: this._$.value.mix }).then((state) => {
            this.clearNextTrack();
            this.schedulePrefetch(state.position);
            if (groupSession?.initialized && groupSession?.hasActiveSession) {
                groupSession.updateGuestTrackQueue(state);
            }
        });
    }

    public toJSON(): string {
        return JSON.stringify(this._state);
    }

    /** Update the track position based on a keyword or number */
    public async updatePosition(
        direction: "next" | "back" | number,
    ): Promise<number> {
        let position: number;
        if (typeof direction === "number") {
            position = direction;
        } else if (direction === "next") {
            position = this._$.value.position + 1;
        } else if (direction === "back") {
            position = this._$.value.position - 1;
        } else {
            return this._$.value.position;
        }

        const state = await this.#sanitizeAndUpdate("APPLY", { position });

        // Every "a track starts" path (initial play, next, previous, queue
        // click, group/tab sync) goes through here: the old `nextTrackUrl`
        // no longer points at position + 1, and the new one must be warmed.
        this.clearNextTrack();
        this.schedulePrefetch(state.position);

        return state.position;
    }

    #currentTrack(position = 0) {
        return this._$.value.mix[position];
    }

    #revertState(): ISessionListProvider {
        this.invalidatePrefetch();
        this._$.set({
            clickTrackingParams: "",
            continuation: "",
            currentMixId: "",
            currentMixType: null,
            mix: [],
            visitorData: "",
            position: 0,
            related: null,
        });
        return this._state;
    }

    /** Sanitize (diff) and update the state */
    async #sanitizeAndUpdate(
        kind: "APPLY" | "SET",
        to: {
            [Key in keyof ISessionListProvider]?: ISessionListProvider[Key] extends any[]
            ? MixListAppendOp | Item[]
            : ISessionListProvider[Key];
        },
    ) {
        const value = await this._$.updateAsync(
            (old) =>
                new Promise((resolve) => {
                    if (kind === "APPLY") {
                        let key;
                        let item;
                        for (key of objectKeys(to)) {
                            item = to[key];
                            if (!(item != undefined && item != null)) continue;

                            if (!VALID_KEYS.includes(key)) {
                                continue;
                            }
                            if (key === "visitorData" && !to[key]) {
                                continue;
                            }
                            if (key === "related") {
                                if (old[key]?.browseId === to[key]?.browseId) {
                                    old.related = null;
                                    continue;
                                }
                            }
                            // Skip if same value
                            if (old[key] === to[key]) {
                                // console.log("SKIPPING UNCHANGED", key);
                                continue;
                            }

                            if (key === "position" && (to[key] as number) < 0) {
                                old[key] = 0;
                            }

                            // `mix` has a slightly altered type here
                            if (key === "mix") {
                                if (!Array.isArray(to.mix)) continue;
                                // index 0 = operation
                                // index 1 = data
                                if (to.mix[0] === "append") {
                                    old.mix.push(...(to.mix[1] as Item[]));
                                    old.mix = filterList(old.mix);
                                } else if (to.mix[0] === "set") {
                                    old.mix = (to.mix as MixListAppendOp)[1];
                                }
                                if (filterAutoPlay.value) {
                                    old.mix = filterList(old.mix);
                                }
                            } else if (to[key] !== undefined && to[key] !== null) {
                                old[key] = to[key] as never;
                            }
                        }

                        Object.assign(this._state, old);

                        resolve({ ...old, ...this._state } as ISessionListProvider);
                    } else {
                        let { mix } = to;
                        const toKeys = objectKeys(to);

                        if (!mix) mix = [];
                        for (const key of toKeys) {
                            if (!VALID_KEYS.includes(key as any))
                                delete to[key as keyof typeof to];
                        }
                        Object.assign(this._state, old);
                        resolve({
                            ...to,
                            mix: mix[1] ? mix[1] : old["mix"],
                        } as ISessionListProvider);
                    }
                }),
        );
        return value;
    }
}

export const SessionListService = new ListService();
export default SessionListService;

/**
 * A derived store for read-only access to the current mix
 */
const queue = derived(SessionListService, ($list) => $list.mix);
/**
 * A derived store for read-only access to the current track
 */
const currentTrack = derived(
    SessionListService,
    ($list) => $list.mix[Math.max(0, $list.position)],
);
/**
 * A derived store for read-only access to the current position
 */
const queuePosition = derived<typeof SessionListService, number>(
    SessionListService,
    ($list, set) => {
        set($list.position);
    },
);

const related = (() => {
    const prevPosition = undefined;
    const {subscribe} = derived<
        typeof SessionListService,
        RelatedEndpointResponse
    >(SessionListService, ($list, set) => {
        try {
            (async () => {
                if ($list.position === prevPosition) return;
                if ($list.related !== null) {
                    await APIClient.fetch(
                        `/api/v1/related.json?browseId=${$list.related?.browseId}`,
                    )
                        .then((res) => res.json())
                        .then(set);
                }
            })();
        } catch (err) {
            Logger.err(err);
        }
    });
    return {subscribe};
})();

export { currentTrack, queue, queuePosition, related };
