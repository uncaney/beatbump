/* eslint-disable @typescript-eslint/no-inferrable-types */
import { browser } from "$app/environment";
import { SessionListService } from "$stores/list/sessionList";
import type { UserSettings } from "$stores/settings";
import Hls, { type HlsConfig } from "hls.js";
import { tick } from "svelte";
import { tweened } from "svelte/motion";
import { writable } from "svelte/store";
import { APIClient } from "./api";
import { announceNowPlaying, cacheTrackOffline, getCachedUrl, verifyCached } from "./offline";
import { sort, type PlayerFormats } from "./parsers/player";
import { settings, type ISessionListProvider } from "./stores";
import { groupSession, type ConnectionState } from "./stores/sessions";
import { syncTabs } from "./tabSync";
import { WritableStore, notify, type ResponseBody } from "./utils";
import { objectKeys } from "./utils/collections/objects";
import { setWorkerInterval } from "./utils/workerTimeout";

let userSettings: UserSettings | undefined = undefined;

export type Callback<K extends keyof HTMLElementEventMap> = (
	this: HTMLElement,
	event: HTMLElementEventMap[K],
) => void;

export type Listeners = Map<string, Callback<keyof HTMLElementEventMap>[]>;

export interface IEventHandler {
	onEvent<K extends keyof HTMLElementEventMap>(type: K, cb: Callback<K>): void;
}

type SrcDict = { original_url: string; url: string; video_url?: string; duration?: number };

interface AudioPlayerEvents {
	play: unknown;
	"update:stream_type": { type: "HLS" | "HTTP" };
}

const setPosition = (currentTime: number, duration: number) => {
	if ("mediaSession" in navigator) {
		console.log({ currentTime, duration });
		navigator.mediaSession.setPositionState({
			duration: duration,
			position: currentTime,
		});
	}
};

function metaDataHandler({
	currentTime,
	duration,
	sessionList,
}: {
	currentTime: number;
	duration: number;
	sessionList: ISessionListProvider;
}) {
	if ("mediaSession" in navigator) {
		const position = sessionList.position;
		const currentTrack = sessionList.mix[position];

		const artwork = currentTrack?.thumbnails;

		console.debug({ currentTrack, position, mix: sessionList.mix });

		if (!currentTrack) return console.debug("no current track");
		navigator.mediaSession.metadata = new MediaMetadata({
			title: currentTrack?.title,
			artist: currentTrack?.artistInfo?.artist?.[0]?.text || "",
			album: currentTrack?.album?.title ?? undefined,
			artwork: artwork.reverse().map(({ url, width, height }) => ({
				src: url,
				sizes: `${width}x${height}`,
				type: "image/jpeg",
			})),
		});
		navigator.mediaSession.setActionHandler("play", () => {
			AudioPlayer.play();
		});
		navigator.mediaSession.setActionHandler("pause", () => AudioPlayer.pause());
		navigator.mediaSession.setActionHandler("seekto", (session) => {
			if (session.fastSeek && "fastSeek" in AudioPlayer) {
				session.seekTime && AudioPlayer.fastSeek(session.seekTime);
				setPosition(
					session.seekTime ?? AudioPlayer.currentTime,
					AudioPlayer.duration,
				);
				return;
			}
			session.seekTime && AudioPlayer.seek(session.seekTime);

			setPosition(
				session.seekTime ?? AudioPlayer.currentTime,
				AudioPlayer.duration,
			);
		});
		navigator.mediaSession.setActionHandler("previoustrack", () =>
			SessionListService.previous(),
		);
		navigator.mediaSession.setActionHandler("nexttrack", () =>
			SessionListService.next(),
		);
		setPosition(currentTime, duration);
	}
}

export const updateGroupState = (opts: {
	client: string;
	state: ConnectionState;
}): void => groupSession.sendGroupState(opts);

export const updateGroupPosition = (
	dir: "<-" | "->" | undefined,
	position: number,
): void =>
	groupSession.send(
		"PATCH",
		"state.update.position",
		{ dir, position } as never,
		groupSession.client,
	);

// Helper to generate a fallback URL if the current src fails to play
function createFallbackUrl(currentUrl: string) {
	if (typeof currentUrl !== "string")
		throw Error(
			`Expected parameter 'currentUrl' to be a string, received ${currentUrl}`,
		);
	const srcUrl = new URL(currentUrl, typeof location !== "undefined" ? location.origin : "http://localhost"); // relative same-origin stream URLs (A1)

	if (!srcUrl.hostname.includes("googlevideo.com")) return currentUrl;

	// example: [ rr4---sn-p5ql61yl , googlevideo , com ]
	const [subdomain, domain, ext] = srcUrl.hostname.split(".");

	const fvip = srcUrl.searchParams.get("fvip") ?? "";
	// comma-separated list of fallback server hosts
	const mn = srcUrl.searchParams.get("mn") ?? "";

	let [preDashes, postDashes] = subdomain.split("---");
	// step 1: replace digits in first part of subdomain with fvip
	preDashes = preDashes.replace(/\d/g, fvip);

	// step 2: use one of the fallback server names found in mn
	postDashes = mn.split(",")[1];

	/**  */
	srcUrl.hostname = `${`${preDashes}---${postDashes}`}.${domain}.${ext}`;

	return srcUrl.toString();
}

type EventCallbackFn<T> = (data: T) => void;

class EventEmitter<Events> {
	private listeners: Map<
		keyof Events,
		EventCallbackFn<Events[keyof Events]>[]
	> = new Map();

	constructor() {
		//
	}

	dispatch<Key extends keyof Events = keyof Events>(
		name: Key,
		data: Events[Key],
	) {
		const listeners = this.listeners.get(name) ?? [];

		for (const cb of listeners) {
			cb?.(data);
		}
	}

	off<Key extends keyof Events = keyof Events>(
		name: Key,
		callback: EventCallbackFn<Events[Key]>,
	) {
		const listeners = this.listeners.get(name) ?? [];
		const index = listeners.indexOf(callback as never);

		if (index > 0) {
			listeners.splice(index, 1);
		}
		this.listeners.set(name, listeners);
	}

	on<Key extends keyof Events = keyof Events & string>(
		name: Key,
		callback: EventCallbackFn<Events[Key]>,
	) {
		const listeners = this.listeners.get(name) ?? [];
		listeners.push(callback as never);
		this.listeners.set(name, listeners);
	}
}

const loadAndAttachHLS = async () => {
	const hls = await import("hls.js");
	const Hls = hls.default;
	if (Hls.isSupported() === false) return null;
	const hlsjsConfig: Partial<HlsConfig> = {
		lowLatencyMode: true,
		enableWorker: true,
		progressive: true,
		manifestLoadingMaxRetry: 2,
		backBufferLength: 90,
	};
	return new Hls(hlsjsConfig);
};

const loadVideo = (player: HTMLVideoElement) => {
	return new Promise((resolve, reject) => {
		player.onloadeddata = () => {
			resolve(player);
		};
		player.onerror = (e) => {
			reject(e);
		};

		player.load();
	});
};

const getPlayerVolumeFromLS = (player: WritableStore<number>) => {
	const storedLevel = localStorage.getItem("volume");
	const setDefaultVolume = () => {
		localStorage.setItem("volume", "0.5");
		player.set(0.5);
	};

	if (storedLevel !== null) {
		try {
			player.set(+storedLevel);
		} catch {
			setDefaultVolume();
		}
	} else {
		setDefaultVolume();
	}
};
class AudioPlayerImpl extends EventEmitter<AudioPlayerEvents> {
	private _currentTimeStore = new WritableStore<number>(0);
	private _durationStore = new WritableStore<number>(0);
	private _volumeStore = new WritableStore<number>(0);
	private _paused = writable(true);
	private _progress = tweened<number>(0);
	private _mode = new WritableStore<"audio" | "video">("audio");
	private _leechInterval: ReturnType<typeof setWorkerInterval> | null = null;
	private _taskQueue: [
		name: keyof AudioPlayerImpl,
		args: [...rest: unknown[]],
	][] = [];
	private hls: Hls | undefined;
	private _videoUrl = new WritableStore<string | undefined>(undefined);
	private audioNodeListeners: Record<string, () => void> = {};
	private invalidationTimer: ReturnType<typeof setTimeout> | null = null;
	private nextSrc: { stale: boolean; url: string | undefined } = {
		stale: false,
		url: "",
	};
	public async setType(type: "HLS" | "HTTP") {
		if (!this.player) {
			this.createAudioNode();
			window["_player"] = this.player;
		}
		// console.log(type);
		if (type === "HLS") {
			this.playerKind = Hls.isSupported() ? "hls" : "html5";
			if (this.playerKind !== "hls") return;
			if (!this.hls) {
				// console.log("loadHLS");
				await this.loadHLS();
			}
		}
		if (type === "HTTP") {
			this.playerKind = "html5";
			if (this.hls) {
				this.hls.destroy();
			}
		}
	}
	private declare player: HTMLAudioElement;
	private declare videoPlayer: HTMLVideoElement | undefined;
	private _repeat: string = "off";
	private playerKind: "hls" | "html5" = "html5";
	private declare unsubscriber: () => void;
	constructor() {
		super();
		if (browser) {
			const onUserInteractionCallback = () => {
				if (!this.player) {
					this.createAudioNode();
					window["_player"] = this.player;
				}
			};

			document.addEventListener("click", onUserInteractionCallback, {
				capture: true,
				once: true,
			});
		}
	}

	public get currentTimeStore() {
		return this._currentTimeStore;
	}
	public get currentTime() {
		return this._currentTimeStore.value;
	}

	public get mode() {
		return this._mode;
	}

	public get videoUrlStore() {
		return this._videoUrl;
	}

	public get videoNode() {
		return this.videoPlayer;
	}
	public set videoNode(node: HTMLVideoElement | undefined) {
		this.videoPlayer = node;
		if (this.videoPlayer && this._videoUrl.value) {
			this.videoPlayer.src = this._videoUrl.value;
			this.videoPlayer.load();
			this.videoPlayer.currentTime = this.currentTime;
			this.videoPlayer.play();
			this.videoPlayer.currentTime = this.currentTime;
		}
	}

	public repeat(state: "off" | "track" | "playlist") {
		if (state === "track") {
			this.player.loop = true;
		} else this.player.loop = false;

		this._repeat = state;
	}

	public get fastSeek() {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		return this.player
			? "fastSeek" in this.player
				? this.player.fastSeek
				: // eslint-disable-next-line @typescript-eslint/no-unused-vars
				(_number: number) => {
					//
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
				}
			: // eslint-disable-next-line @typescript-eslint/no-unused-vars
			(_number: number) => {
				//
			};
	}

	public get durationStore() {
		return this._durationStore;
	}

	public get duration() {
		return this._durationStore.value;
	}
	public get paused() {
		return this._paused;
	}

	public get progress() {
		return this._progress;
	}

	public set progress(value) {
		this._progress = value;
	}

	public get subscribe() {
		return () => {
			// eslint-disable-next-line @typescript-eslint/no-empty-function
			return () => {};
		};
	}

	public get volume() {
		return this._volumeStore;
	}

	public setVolume(value: number) {
		if (!this.player) return;
		this._volumeStore.set(value);
	}

	public dispose() {
		const keys = objectKeys(this.audioNodeListeners);
		for (const key of keys) {
			const callback = this.audioNodeListeners[key];
			this.player.removeEventListener(key, callback);
		}
	}

	public pause() {
		syncTabs.playback({
			state: "pause",
			currentTime: this.currentTime,
			duration: this.duration,
		});
		if (this._leechInterval) {
			this._leechInterval.clear()?.then(() => {
				this._leechInterval = null;
			});
			return;
		} else {
			if (!this.player) {
				this.addTaskToTaskQueue("pause");
				return;
			}
			this.paused.set(true);
			this.player.pause();
		}
	}

	public play() {
		this.paused.set(false);
		if (!this.player) {
			this.addTaskToTaskQueue("play");
			return;
		}
		syncTabs.playback({
			state: "play",
			currentTime: this.currentTime,
			duration: this.duration,
		});
		if (
			groupSession.initialized === true &&
			groupSession.hasActiveSession === true
		) {
			updateGroupState({
				client: groupSession.client.clientId,
				state: {
					finished: this.player.ended,
					paused: false,
					playing: true,
					pos: SessionListService.position,
					stalled: !!this.player.error,
				} as ConnectionState,
			});
		}
		const promise = this.player.play();
		if (promise) {
			promise
				.catch((e) => console.error("ERROR", e));
		}
	}

	public seek(to: number) {
		if (to < this.durationStore.value / 2) this.setStaleTimeout();

		this.player.currentTime = to;
		this._progress.set(this.player.currentTime, { duration: 10 });
	}

	public setNextTrackPrefetchedUrl(trackUrl: string) {
		this.nextSrc.url = trackUrl;
		this.nextSrc.stale = false;
	}

	/** Used when sync'ing a 'leech' tab */
	public async fakePlay(currentTime: number, duration: number) {
		if (this._leechInterval) await this._leechInterval.clear();
		this._paused.set(false);
		this._currentTimeStore.set(currentTime);
		this._durationStore.set(duration);

		this._leechInterval = setWorkerInterval(() => {
			this._currentTimeStore.set(this._currentTimeStore.value + 1);
		}, 1000);
	}

	public async updateSrc({
		url,
		videoUrl,
		duration
	}: {
		videoUrl?: string;
		url: string;
		duration?: number;
	}) {
		if (url === undefined) return;

		if (videoUrl && this.videoPlayer) {
			this.videoPlayer.src = videoUrl;
		}
		this._videoUrl.set(videoUrl);
		if (this.playerKind === "hls") {
			this.loadHLS(url);
		} else {
			this.player.src = url;
		}

        if (duration != undefined && duration != -1){
			this._durationStore.set(duration / 1000);
			setPosition(
				0,
				duration / 1000,
			);
		} else {
			this._durationStore.set(0);
		}

		this.nextSrc.url = undefined;
		this.setStaleTimeout();
	}

	private addTaskToTaskQueue(name: keyof AudioPlayerImpl, ...args: unknown[]) {
		this._taskQueue.push([name, args]);
	}

	private async loadHLS(source?: string) {
		if (this.hls) this.hls.destroy();
		const hls = await loadAndAttachHLS();
		if (!hls) return;
		this.hls = hls;

		this.hls.attachMedia(this.player);

		this.hls.on(Hls.Events.MEDIA_ATTACHED, () => {
			this.hls?.loadSource(source || this.player.src);
		});

		this.hls.on(Hls.Events.ERROR, (_event, data) => {
			const type = data.type;
			switch (type) {
				case Hls.ErrorTypes.MEDIA_ERROR:
					this.hls?.recoverMediaError();
					break;
				case Hls.ErrorTypes.NETWORK_ERROR:
					this.hls?.startLoad();
					break;
				default:
			}
		});
	}
	private errorCount = 0;
	private handleError() {
		if (++this.errorCount > 2) {
			this.errorCount = 0;
			this.updateSrc({
				url: createFallbackUrl(this.player.src),
			});
		}
	}

	private async handleRepeat() {
		if (
			this._repeat === "playlist" &&
			SessionListService.$.value.position >=
			SessionListService.$.value.mix.length - 1
		) {
			await SessionListService.updatePosition(1);
			await SessionListService.previous();
			return true;
		} else if (this._repeat === "track") {
			return false;
		}
	}

	private createAudioNode() {
		let locked = false;
		this.player = new Audio();
		this.player.autoplay = true;

		getPlayerVolumeFromLS(this._volumeStore);

		const modeSubscription = this._mode.subscribe(async (value) => {
			await tick();
			if (value === "audio") {
				if (this.videoPlayer) {
					this.videoPlayer.pause();
					this.videoPlayer.autoplay = false;
				}
			} else {
				if (this.videoPlayer) {
					await tick();
					this.videoPlayer.autoplay = true;
					await this.videoPlayer.play();
					this.videoPlayer.currentTime = this.player.currentTime;
				}
			}
		});
		const volumeSubscription = this._volumeStore.subscribe((value) => {
			this.player.volume = value;
			localStorage.setItem("volume", value.toString());
		});

		window.addEventListener("pagehide", ({ persisted }) => {
			if (persisted) return;
			this?.dispose?.();
			volumeSubscription();
			modeSubscription();
			this.player.remove();
			this.videoPlayer?.remove();
		});


		this.onEvent("loadedmetadata", async () => {
			this._paused.set(false);
			if (this.videoNode)
				await loadVideo(this.videoNode).then(async () => {
					await tick();
					if (this.videoNode)
						this.videoNode.currentTime = this.player.currentTime;
				});

			await this.videoPlayer?.play();
			this._paused.set(false);
			this.play();
			await tick();
			groupSession.resetAllCanPlay();

			this.setStaleTimeout();
			this.nextSrc.url = undefined;
			this._currentTimeStore.set(0);

			/*const duration = isAppleMobileDevice
				? this.player.duration / 2
				: this.player.duration;*/
			if (this._durationStore.value === 0) {
				this._durationStore.set(this.player.duration);
			}

			if (syncTabs.role === "host") {
				syncTabs.updatePosition(SessionListService.position);
				syncTabs.playback({
					state: "play",
					currentTime: this.currentTime,
					duration: this.duration,
				});
			}

			metaDataHandler({
				duration: this.duration,
				currentTime: this.player.currentTime,
				sessionList: SessionListService.$.value,
			});
		});

		this.onEvent("play", () => {
			this._paused.set(false);
			this.play();
		});

		this.onEvent("seeked", () => {
			if (this.videoPlayer && this._mode.value === "video") {
				this.videoPlayer.currentTime = this.player.currentTime;
			}
		});


		this.onEvent("durationchange", () => {
			const d = this.player.duration;
			if (isFinite(d) && d > 0) this._durationStore.set(d);
		});

		this.onEvent("timeupdate", async () => {
			this._currentTimeStore.set(this.player.currentTime);
			/*const duration = isAppleMobileDevice
				? this.player.duration / 2
				: this.player.duration;*/

			// We're at the end - get the next track!
			// Only auto-advance against a KNOWN duration: right after a source swap the store is 0
			// (prefetched / cached sources carry no duration) and `currentTime >= -1` would skip tracks.
			const knownDuration = this.duration > 0 ? this.duration : (isFinite(this.player.duration) ? this.player.duration : 0);
			if (knownDuration > 0 && this.player.currentTime >= knownDuration - 1.0 && !locked) {
				try {
					if (this._repeat !== "off") {
						const allowContinuation = await this.handleRepeat();
						if (allowContinuation === false) {
							return;
						}
					}
					if (!locked) locked = true;

					if (groupSession.initialized) {
						return await Promise.resolve(
							updateGroupState({
								client: groupSession.client.clientId,
								state: {
									finished: true,
									paused: true,
									playing: false,
									pos: SessionListService.position,
									stalled: !!this.player.error,
								} as ConnectionState,
							}),
						).then(() => {
							const [allCanPlay, fn] = groupSession.allCanPlay();
							if (allCanPlay) {
								fn();
								locked = false;
							}
						});
					}
					if (groupSession.hasActiveSession && !groupSession.allCanPlay) return;
					return await SessionListService.next(this.nextSrc.url).finally(() => {
						locked = false; // Unlock this 'if' block when finished
						this.nextSrc.url = undefined; // Set to undefined since e 'used' the value
					});
				} finally {
					locked = false;
					this.nextSrc.url = undefined; // Set to undefined since e 'used' the value
				}
			}
		});

		this.onEvent("error", () => {
			// Map HTMLMediaElement.error.code onto the structured PlayerRequestError
			// so the toast + guarded auto-skip (playerFailStreak) behave like the
			// /player.json contract instead of surfacing raw Chromium strings such as
			// "PIPELINE_ERROR_READ: FFmpegDemuxer: data source error". Never throws.
			try {
				const mediaError = this.player?.error;
				if (!mediaError) return;
				const code = mediaError.code;
				const message = String(mediaError.message || "");
				// 1 = MEDIA_ERR_ABORTED: user/app-initiated (src swap, stop), not a failure.
				if (code === 1) return;
				// Chromium fires code 4 "Empty src attribute" when src is reset on purpose.
				if (message.includes("Empty src")) return;
				console.error("[player] media element error", code, message);
				let err: PlayerRequestError;
				switch (code) {
					case 2: // MEDIA_ERR_NETWORK: stream fetch aborted mid-way (throttle, offline)
						err = new PlayerRequestError(0, "network", "MEDIA_ERR_NETWORK", "");
						break;
					case 3: // MEDIA_ERR_DECODE: data arrived but the browser cannot decode it
						err = new PlayerRequestError(0, "unplayable", "MEDIA_ERR_DECODE", "Format audio non supporté par ce navigateur");
						break;
					case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED: container/MIME rejected or 4xx/5xx on the source
						err = new PlayerRequestError(0, "unplayable", "MEDIA_ERR_SRC_NOT_SUPPORTED", "Source audio illisible");
						break;
					default:
						err = new PlayerRequestError(0, "unknown", "MEDIA_ERR_" + String(code), message);
				}
				handleError(err);
			} catch (e) {
				console.error("[player] media error handler failed", e);
			}
		});


		this.on("update:stream_type", async ({ type }) => {
			this.setType(type);
		});

		// If there's any actions (eg: set volume) that take place before
		// we're setup, they'll be put in the taskQueue - process them here
		if (this._taskQueue.length) {
			while (this._taskQueue.length) {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				const [name, args] = this._taskQueue.shift()!;
				const method = this[name];
				//@ts-expect-error It's fine
				if (typeof method === "function") method(...args);
			}
		}
	}
	private onEvent(name: keyof HTMLMediaElementEventMap, callback: () => void) {
		if (!this.player) this.createAudioNode();
		this.audioNodeListeners[name] = callback;
		this.player.addEventListener(name, callback);
	}

	private setStaleTimeout() {
		if (this.invalidationTimer) clearTimeout(this.invalidationTimer);

		const remainingTime = this.duration - this.player.currentTime;
		const halfwayTime = this.duration / 2;

		const timeoutDuration = Math.max(halfwayTime - remainingTime / 2, 0);
		this.invalidationTimer = setTimeout(() => {
			this.nextSrc.stale = true;
		}, timeoutDuration);
	}
}

export const AudioPlayer = new AudioPlayerImpl();

/** Updates the current track for the audio player */
export function updatePlayerSrc({ url, video_url,duration }: SrcDict): void {
	AudioPlayer.updateSrc({ url, videoUrl: video_url,duration });
	// The SW's LRU must never evict what is playing right now.
	if (browser) {
		const cur = SessionListService.value?.mix?.[SessionListService.value?.position ?? -1];
		announceNowPlaying(url, cur?.videoId);
	}
}

// Offline-first source: when the track is in our offline list as cached, ask
// the SW (light, ~ms; 1.5 s cap) whether it really holds it, then play the
// cached URL directly instead of re-resolving player.json (which would yield a
// fresh signed URL that misses the cache, and offline would fail outright).
async function offlineFormats(videoId?: string): Promise<PlayerFormats | null> {
	if (!browser || !videoId) return null;
	let url = getCachedUrl(videoId);
	if (!url) return null;
	const v = await verifyCached(videoId).catch(() => null);
	if (v && !v.cached) return null; // definitely gone (evicted): regular flow
	if (v && v.url) url = v.url;
	return {
		hls: "",
		dash: "",
		streams: [{ url, original_url: url, mimeType: "audio/mp4" }],
		video: "",
		duration: -1,
	};
}

// Get source URLs
export const getSrc = async (
	videoId?: string,
	playlistId?: string,
	params?: string,
	shouldAutoplay = true,
): Promise<
	| {
		body: ResponseBody | null;
		error: boolean;
	}
	| undefined
> => {

	const currentTrack = SessionListService.value.mix.find(t => t.videoId === videoId);
	if (currentTrack?.localUrl) {
		const formats = {
			hls: "",
			dash: "",
			streams: [{ url: currentTrack.localUrl	, original_url: currentTrack.localUrl, mimeType: "audio/mp4" }],
			video: "",
			duration: -1
		}
		return setTrack(formats, true, currentTrack);
	}

	const cached = await offlineFormats(videoId);
	if (cached) return setTrack(cached, shouldAutoplay, currentTrack || (videoId ? { videoId } : undefined));

	const res = await fetchPlayerJson(videoId, playlistId, params);
	if (res instanceof PlayerRequestError) {
		return handleError(res);
	}
	if (!res || (!res?.streamingData && res?.playabilityStatus?.status === "UNPLAYABLE")) {
		return handleError(new PlayerRequestError(404, "unplayable", "UNPLAYABLE", res?.playabilityStatus?.reason || ""));
	}
	const formats = sort({
		data: res,
		dash: false,
	});

	const src = setTrack(formats, shouldAutoplay, currentTrack || (videoId ? { videoId } : undefined));
	return src;
}

// Offline core: every track that actually starts playing is cached for offline
// playback by the service worker (settings.offline.autoCache, default on; only
// an explicit `false` disables it). Fire-and-forget, never blocks playback.
function autoCacheEnabled(): boolean {
	return userSettings?.offline?.autoCache !== false;
}
function autoCache(track: { videoId?: string } | undefined, url: string | undefined) {
	if (!browser || !track || !track.videoId || !url) return;
	if (!autoCacheEnabled()) return;
	try {
		void cacheTrackOffline(track, url).catch(() => {});
	} catch {
		/* never let offline caching affect playback */
	}
}

function setTrack(formats: PlayerFormats, shouldAutoplay: boolean, track?: { videoId?: string }) {
	let format = undefined;
	if (userSettings?.playback?.Stream === "HLS") {
		format = { original_url: formats?.hls || "", url: formats.hls || "" };
	} else {
		format = formats.streams?.[0];
	}
	if (format) playerFailStreak = 0;
	if (format && shouldAutoplay) {
		updatePlayerSrc({
			video_url: formats.video,
			original_url: format.original_url,
			url: format.url,
			duration: formats.duration
		});
		autoCache(track, format.url);
	}
	return {
		body: format
			? { original_url: format.original_url, url: format.url }
			: null,
		error: false,
	};
}

// Structured error contract of /api/v1/player.json (backend cycle 2):
// {error: bad_request|unplayable|upstream|timeout|internal, status, reason, videoId}.
export class PlayerRequestError extends Error {
	constructor(
		public code: number,
		public kind: string,
		public status: string,
		public reason: string,
	) {
		super(reason || kind);
	}
}

const PLAYER_RETRY_DELAY_MS = 1500;

async function fetchPlayerJson(videoId?: string, playlistId?: string, params?: string, attempt = 0): Promise<any> {
	let response: Response;
	try {
		response = await APIClient.fetch(`/api/v1/player.json?videoId=${videoId}&playlistId=${playlistId}&playerParams=${params}`);
	} catch (e) {
		// Network failure (offline, DNS): behaves like an unreachable upstream.
		if (attempt === 0) {
			await new Promise((r) => setTimeout(r, PLAYER_RETRY_DELAY_MS));
			return fetchPlayerJson(videoId, playlistId, params, 1);
		}
		return new PlayerRequestError(0, "network", "NETWORK", String((e as Error)?.message || e));
	}
	if (response.ok) {
		try {
			return await response.json();
		} catch {
			return new PlayerRequestError(502, "upstream", "INVALID_RESPONSE", "");
		}
	}
	// Non-200: parse the JSON contract defensively (older servers answered plain text).
	let err = new PlayerRequestError(response.status, response.status === 404 ? "unplayable" : "upstream", String(response.status), "");
	try {
		const text = await response.text();
		try {
			const j = JSON.parse(text);
			if (j && typeof j === "object" && typeof j.error === "string") {
				err = new PlayerRequestError(response.status, j.error, String(j.status || ""), String(j.reason || ""));
			} else {
				err.reason = text.slice(0, 200);
			}
		} catch {
			err.reason = text.slice(0, 200);
		}
	} catch {
		/* body unreadable */
	}
	if ((err.kind === "upstream" || err.kind === "timeout") && attempt === 0) {
		notify("Service lecteur indisponible, nouvelle tentative…", "error");
		await new Promise((r) => setTimeout(r, PLAYER_RETRY_DELAY_MS));
		return fetchPlayerJson(videoId, playlistId, params, 1);
	}
	return err;
}

// Auto-skip guard: skip to the next track on a failure, but never chain skips
// (a dead backend would otherwise race through the whole queue). The streak is
// reset by the next successful setTrack.
let playerFailStreak = 0;

function handleError(err: PlayerRequestError | string | undefined) {
	const e = typeof err === "string" || !err ? new PlayerRequestError(0, "unknown", "UNKNOWN", typeof err === "string" ? err : "") : err;
	console.error("[player] source error", e.code, e.kind, e.status, e.reason);
	let message: string;
	switch (e.kind) {
		case "unplayable":
			message = "Morceau indisponible" + (e.reason ? " : " + e.reason : "");
			break;
		case "bad_request":
			message = "Morceau invalide" + (e.reason ? " : " + e.reason : "");
			break;
		case "timeout":
			message = "Le service lecteur ne répond pas, réessaie dans un instant";
			break;
		case "upstream":
		case "network":
			message = "Service lecteur indisponible" + (e.reason ? " (" + e.reason + ")" : "");
			break;
		default:
			message = e.reason || "Lecture impossible pour ce morceau";
	}
	playerFailStreak += 1;
	const canSkip = playerFailStreak <= 1 && SessionListService.value.mix.length > 1;
	if (canSkip && (e.kind === "unplayable" || e.kind === "bad_request" || e.kind === "upstream" || e.kind === "timeout")) {
		notify(message + " · passage au suivant", "error", "getNextTrack");
		setTimeout(() => {
			void Promise.resolve(SessionListService.next()).catch(() => {});
		}, 600);
	} else {
		notify(message, "error");
	}
	return {
		body: null,
		error: true,
	};
}

if (browser && globalThis.self.name !== "IDB" && settings) {
	settings.subscribe((value) => {
		userSettings = value;
		if (userSettings?.playback?.Stream) {
			AudioPlayer.setType(userSettings.playback.Stream);
		}
	});
}
