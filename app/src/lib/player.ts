/* eslint-disable @typescript-eslint/no-inferrable-types */
import { browser } from "$app/environment";
import { SessionListService } from "$stores/list/sessionList";
import type { UserSettings } from "$stores/settings";
import type HlsType from "hls.js";
import type { HlsConfig } from "hls.js";
import { tick } from "svelte";
import { tweened } from "svelte/motion";
import { writable } from "svelte/store";
import { APIClient, PREFETCH_INIT } from "./api";
import {
	announceNowPlaying,
	cacheTrackOffline,
	getCachedUrl,
	getOfflineTracks,
	isLocalUrl,
	isStableAudioUrl,
	listCachedAudio,
	swRequest,
	verifyCached,
} from "./offline";
import { sort, type PlayerFormats } from "./parsers/player";
import { settings, type ISessionListProvider } from "./stores";
import { groupSession, type ConnectionState } from "./stores/sessions";
import { shouldStopAtTrackEnd, trackEnded as sleepTimerTrackEnded } from "./stores/sleepTimer";
import { syncTabs } from "./tabSync";
import { WritableStore, notify, type ResponseBody } from "./utils";
import { objectKeys } from "./utils/collections/objects";
import { claimMediaRetryAttempt, planMediaRetry, type MediaRetryRecord } from "./utils/mediaRetry";
import { reportClientError } from "./clientLog";
import { setWorkerInterval } from "./utils/workerTimeout";
import { resumeKeptFor } from "./stores/resumeState";
import { recordSkip } from "./me";
import type { SkipSource } from "./skips";
import {
	mediaArtwork,
	mediaMetadataFields,
	mediaSessionSeekTarget,
	positionState,
	previousAction,
	seekTarget,
} from "./stores/list/mediaSession";

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

// C3: never throws (setPositionState rejects an unknown duration or a
// position past it), carries the playback rate.
const setPosition = (currentTime: number, duration: number, playbackRate = 1) => {
	if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
	if (typeof navigator.mediaSession.setPositionState !== "function") return;
	const state = positionState(currentTime, duration, playbackRate);
	if (!state) return;
	try {
		navigator.mediaSession.setPositionState(state);
	} catch {
		/* unsupported value: the lock screen keeps its last position */
	}
};

/** setActionHandler throws for actions a browser does not support. */
const setMediaAction = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
	try {
		navigator.mediaSession.setActionHandler(action, handler);
	} catch {
		/* action not supported here */
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

		if (!currentTrack) return console.debug("no current track");
		// C3: local tracks show the library cover (`/cover?lid=`, 512 px) on the
		// lock screen; thumbnails are copied, never reversed in place (F14/G14).
		// c39c B6-26: every artist, the album (row or album queue), sharp artwork.
		const fields = mediaMetadataFields(currentTrack, sessionList.context);
		navigator.mediaSession.metadata = new MediaMetadata({
			title: fields.title,
			artist: fields.artist,
			album: fields.album,
			artwork: mediaArtwork(currentTrack, typeof location !== "undefined" ? location.origin : ""),
		});
		navigator.mediaSession.setActionHandler("play", () => {
			AudioPlayer.play();
		});
		navigator.mediaSession.setActionHandler("pause", () => AudioPlayer.pause());
		// c39c B6-8: seekto 0 is a real seek; the action name is set here so a
		// handler called with a bare `{ seekTime }` still resolves.
		const onSeek = (action: "seekto" | "seekbackward" | "seekforward") =>
			(details?: MediaSessionActionDetails) => {
				const target = mediaSessionSeekTarget(
					{ ...(details ?? {}), action },
					AudioPlayer.currentTime,
					AudioPlayer.duration,
				);
				if (target === null) return;
				AudioPlayer.seekTo(target, action === "seekto" && details?.fastSeek === true);
			};
		setMediaAction("seekto", onSeek("seekto"));
		navigator.mediaSession.setActionHandler("previoustrack", () =>
			AudioPlayer.previousOrRestart(),
		);
		// c40b B6-10: an early lock-screen "next" is recorded as a skip.
		navigator.mediaSession.setActionHandler("nexttrack", () =>
			AudioPlayer.skipNext("mediasession"),
		);
		// C3: headset / lock screen ±10 s.
		setMediaAction("seekbackward", onSeek("seekbackward"));
		setMediaAction("seekforward", onSeek("seekforward"));
		setPosition(currentTime, duration, AudioPlayer.playbackRate);
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

// hls.js (398 KB raw / 123 KB gzip) is only needed when the Stream setting is HLS:
// load it on demand instead of shipping it with the player on every page.
let hlsModule: Promise<typeof HlsType> | undefined;
const loadHlsModule = () => (hlsModule ??= import("hls.js").then((m) => m.default));

const loadAndAttachHLS = async () => {
	const Hls = await loadHlsModule();
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
	private hls: HlsType | undefined;
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
			const Hls = await loadHlsModule();
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
	// Sleep timer "fin du morceau": set when playback was paused at the end of
	// the track so the (still satisfied) end-of-track test does not auto-advance
	// on the trailing timeupdate; cleared by the next play().
	private _sleepHold = false;
	// C1 exact resume: the next loadedmetadata seeks here and, unless
	// `autoplay`, stays paused (the restored queue waits for the user).
	// I2: `videoId` = the restored track; a source for any other track clears it.
	private _resumeAt: { time: number; duration: number; autoplay: boolean; videoId?: string } | null = null;
	// I5: work a startup restore (prefetch load) postpones to the first play:
	// the normal player.json (server acquisition) and the SW audio caching.
	private _onFirstPlay: { videoId: string; run: () => void } | null = null;
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

	/**
	 * Transient volume (sleep-timer fade): drives the media element only, so
	 * neither the volume store nor `localStorage.volume` records the fade (a
	 * tab closed mid-fade used to reopen near silent, G11). `setVolume()`
	 * restores the persisted level afterwards.
	 */
	public fadeTo(value: number) {
		if (!this.player) return;
		this.player.volume = Math.min(1, Math.max(0, value));
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
		this._sleepHold = false;
		const deferred = this._onFirstPlay;
		this._onFirstPlay = null;
		if (deferred) {
			try {
				deferred.run();
			} catch {
				/* never block playback */
			}
		}
		this.paused.set(false);
		// A restored (paused) track: the user asked to play, keep the seek.
		if (this._resumeAt) this._resumeAt.autoplay = true;
		if (this.player && !this.player.autoplay) this.player.autoplay = true;
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

	/** C3: relative seek (lock screen / headset ±10 s), kept inside the track. */
	public seekBy(delta: number) {
		if (!this.player) return;
		const duration = this.duration > 0 ? this.duration : this.player.duration;
		const target = seekTarget(this.currentTime || this.player.currentTime || 0, delta, duration);
		this.seekTo(target);
	}

	/**
	 * c39c B6-8: absolute seek from the lock screen / headset (0 included);
	 * the time store and the Media Session position follow at once.
	 */
	public seekTo(target: number, fast = false) {
		if (!this.player || !isFinite(target)) return;
		const t = Math.max(0, target);
		if (fast && typeof this.player.fastSeek === "function") {
			if (t < this.durationStore.value / 2) this.setStaleTimeout();
			this.player.fastSeek(t);
			this._progress.set(t, { duration: 10 });
		} else {
			this.seek(t);
		}
		this._currentTimeStore.set(t);
		const duration = this.duration > 0 ? this.duration : this.player.duration;
		setPosition(t, duration, this.player.playbackRate);
	}

	/**
	 * c39c B6-8: player button, keyboard and lock-screen "previous": restart
	 * the track after 3 s, otherwise step back in the queue.
	 */
	public async previousOrRestart(): Promise<void> {
		const t = this.player && isFinite(this.player.currentTime) ? this.player.currentTime : this.currentTime;
		if (previousAction(t, SessionListService.position) === "restart") {
			if (this.player) this.seekTo(0);
			return;
		}
		await SessionListService.previous();
	}

	/**
	 * c40b B6-10: a USER "next" (player / fullscreen buttons, keyboard,
	 * lock screen). Records a skip when the press comes early (skips.ts),
	 * then advances exactly like SessionListService.next(nextSrc, update).
	 * The track-end auto-advance and a tap on a queue row do not come here.
	 */
	public skipNext(source: SkipSource, update = false): Promise<void> {
		try {
			const track = SessionListService.mix?.[SessionListService.position];
			const t = this.player && isFinite(this.player.currentTime) ? this.player.currentTime : this.currentTime;
			const d = this.duration > 0 ? this.duration : this.player && isFinite(this.player.duration) ? this.player.duration : 0;
			recordSkip(track, t, d, source);
		} catch {
			/* never block "next" on the skip log */
		}
		return SessionListService.next(undefined, update);
	}

	/** Media element playback rate (1 before the element exists). */
	public get playbackRate(): number {
		return this.player ? this.player.playbackRate : 1;
	}

	/** C3: refresh the lock-screen position (seeked / ratechange / durationchange). */
	private updatePositionState() {
		if (!this.player) return;
		const duration = this.duration > 0 ? this.duration : this.player.duration;
		setPosition(this.player.currentTime, duration, this.player.playbackRate);
	}

	public setNextTrackPrefetchedUrl(trackUrl: string) {
		this.nextSrc.url = trackUrl;
		this.nextSrc.stale = false;
	}

	/**
	 * C1: the source about to be loaded is a restored track. Seek it to
	 * `time` on loadedmetadata and stay paused unless `autoplay`. Call before
	 * getSrc() so the flag is set when the metadata arrives.
	 */
	public primeResume(time: number, duration: number, autoplay = false, videoId?: string) {
		if (!this.player) this.createAudioNode();
		const t = isFinite(time) && time > 0 ? time : 0;
		const d = isFinite(duration) && duration > 0 ? duration : 0;
		this._resumeAt = { time: t, duration: d, autoplay, videoId };
		if (!autoplay) {
			this.player.autoplay = false;
			this._paused.set(true);
		}
		this._currentTimeStore.set(t);
		if (d) this._durationStore.set(d);
	}

	/**
	 * I2: drop a pending restore (the restored source failed, or another
	 * track is loading) so the next source starts at 0 and plays.
	 */
	public clearResume() {
		if (!this._resumeAt) return;
		this._resumeAt = null;
		if (this.player) this.player.autoplay = true;
	}

	/** I4: the element holds a source that did not fail. */
	public hasSource(): boolean {
		return !!this.player && !!(this.player.currentSrc || this.player.src) && !this.player.error;
	}

	/** I2: a source for `videoId` is about to load; keep the restore only for its own track. */
	public sourceLoading(videoId?: string) {
		if (!resumeKeptFor(this._resumeAt, videoId)) this.clearResume();
		if (this._onFirstPlay && videoId && this._onFirstPlay.videoId !== videoId) this._onFirstPlay = null;
	}

	/** I5: run `run` at the first play() of `videoId` (dropped if another track loads). */
	public deferUntilPlay(videoId: string, run: () => void) {
		this._onFirstPlay = { videoId, run };
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
		const Hls = await loadHlsModule();

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
			const resume = this._resumeAt;
			this._resumeAt = null;
			if (resume) {
				const d = this.player.duration;
				if (resume.time > 0 && (!isFinite(d) || resume.time < d - 2)) {
					try {
						this.player.currentTime = resume.time;
					} catch {
						/* not seekable yet: starts at 0 */
					}
				}
				if (!resume.autoplay) {
					if (this._durationStore.value === 0) {
						this._durationStore.set(isFinite(d) && d > 0 ? d : resume.duration);
					}
					this._currentTimeStore.set(this.player.currentTime || resume.time);
					this._paused.set(true);
					metaDataHandler({
						duration: this.duration,
						currentTime: this.player.currentTime,
						sessionList: SessionListService.$.value,
					});
					return;
				}
			}
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
			// 0 for a new track; the resume seek above otherwise.
			this._currentTimeStore.set(this.player.currentTime || 0);

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
			this.updatePositionState();
		});

		this.onEvent("ratechange", () => this.updatePositionState());

		this.onEvent("durationchange", () => {
			const d = this.player.duration;
			if (isFinite(d) && d > 0) this._durationStore.set(d);
			this.updatePositionState();
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
				// Sleep timer "fin du morceau" (P4): this track is the last one. Pause
				// instead of advancing; repeat / shuffle state is left untouched and the
				// normal auto-advance resumes on the next play().
				if (this._sleepHold) return;
				// c39c B6-9: "album" / "tracks" modes stop after a queue index.
				if (shouldStopAtTrackEnd(SessionListService.position)) {
					this._sleepHold = true;
					this.nextSrc.url = undefined;
					this.pause();
					sleepTimerTrackEnded();
					return;
				}
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
					case 4: {
						// MEDIA_ERR_SRC_NOT_SUPPORTED: container/MIME rejected or 4xx/5xx on the source.
						// The first play of a fresh browser context fails ~1 run in 8 with
						// PIPELINE_ERROR_READ and succeeds on retry: up to two automatic
						// attempts per track per 10 min window (G21, H1) before giving up
						// (toast + guarded auto-skip). Attempt 1 reloads the same source,
						// attempt 2 re-resolves it (see retryMediaSource for the purge rules).
						err = new PlayerRequestError(0, "unplayable", "MEDIA_ERR_SRC_NOT_SUPPORTED", "Source audio illisible");
						const cur = SessionListService.$.value.mix?.[SessionListService.$.value.position];
						const vid = cur?.videoId ? String(cur.videoId) : "";
						const attempt = vid ? claimMediaRetryAttempt(mediaRetryAttempts, vid) : 0;
						if (attempt > 0) {
							const raw = String(this.player?.currentSrc || this.player?.src || "");
							// MSE (HLS) sources are blob: URLs: not reloadable as such.
							const failedSrc = raw.startsWith("blob:") ? "" : raw;
							const giveUpErr = err;
							console.warn("[player] source read error, retry attempt", attempt, vid, message);
							setTimeout(() => {
								void retryMediaSource(vid, cur?.playlistId, attempt, failedSrc)
									.then((retried) => {
										if (!retried) handleError(giveUpErr);
									})
									.catch(() => {});
							}, 400);
							return;
						}
						break;
					}
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
export function updatePlayerSrc({ url, video_url,duration }: SrcDict, videoId?: string): void {
	const cur = browser ? SessionListService.value?.mix?.[SessionListService.value?.position ?? -1] : undefined;
	AudioPlayer.sourceLoading(videoId ?? cur?.videoId);
	AudioPlayer.updateSrc({ url, videoUrl: video_url,duration });
	// The SW's LRU must never evict what is playing right now.
	if (browser) {
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
	opts?: { prefetch?: boolean; bypassCache?: boolean; deferToPlay?: boolean },
): Promise<
	| {
		body: ResponseBody | null;
		error: boolean;
	}
	| undefined
> => {
	// Not a playback start (getMoreLikeThis warm-up, guest continuation of a
	// track the host already played): tell the backend so it serves the stream
	// without acquiring the track (F12). A real play keeps the default path.
	const prefetch = opts?.prefetch ?? !shouldAutoplay;

	const currentTrack = SessionListService.value.mix.find(t => t.videoId === videoId);
	if (currentTrack?.localUrl) {
		const formats = {
			hls: "",
			dash: "",
			streams: [{ url: currentTrack.localUrl	, original_url: currentTrack.localUrl, mimeType: "audio/mp4" }],
			video: "",
			duration: -1
		}
		// J1/J12: a restored queue (deferToPlay) loads the local source paused
		// and only caches it at the first play, like the player.json path below.
		const src = setTrack(formats, true, currentTrack, !!opts?.deferToPlay);
		if (opts?.deferToPlay && videoId) {
			const url = currentTrack.localUrl;
			AudioPlayer.deferUntilPlay(videoId, () => autoCache(currentTrack, url));
		}
		return src;
	}

	// bypassCache (media-error retry, G2): the SW entry is the source that just
	// failed, so re-resolve from player.json even when the track is cached.
	const cached = opts?.bypassCache ? null : await offlineFormats(videoId);
	if (cached) return setTrack(cached, shouldAutoplay, currentTrack || (videoId ? { videoId } : undefined));

	const res = await fetchPlayerJson(videoId, playlistId, params, 0, prefetch);
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

	const track = currentTrack || (videoId ? { videoId } : undefined);
	if (opts?.deferToPlay && prefetch && shouldAutoplay && videoId) {
		// I5 startup restore: the source is loaded (paused) from a prefetch
		// player.json; the normal load (acquisition) and the SW caching only
		// happen if the user actually plays it.
		const src = setTrack(formats, shouldAutoplay, track, true);
		const url = src.body?.url;
		AudioPlayer.deferUntilPlay(videoId, () => {
			void fetchPlayerJson(videoId, playlistId, params, 1, false).catch(() => {});
			autoCache(track, url);
		});
		return src;
	}
	const src = setTrack(formats, shouldAutoplay, track);
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

function setTrack(formats: PlayerFormats, shouldAutoplay: boolean, track?: { videoId?: string }, deferAutoCache = false) {
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
		}, track?.videoId);
		if (!deferAutoCache) autoCache(track, format.url);
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

async function fetchPlayerJson(videoId?: string, playlistId?: string, params?: string, attempt = 0, prefetch = false): Promise<any> {
	let response: Response;
	try {
		response = await APIClient.fetch(
			`/api/v1/player.json?videoId=${videoId}&playlistId=${playlistId}&playerParams=${params}`,
			prefetch ? PREFETCH_INIT : undefined,
		);
	} catch (e) {
		// Network failure (offline, DNS): behaves like an unreachable upstream.
		if (attempt === 0) {
			await new Promise((r) => setTimeout(r, PLAYER_RETRY_DELAY_MS));
			return fetchPlayerJson(videoId, playlistId, params, 1, prefetch);
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
		return fetchPlayerJson(videoId, playlistId, params, 1, prefetch);
	}
	return err;
}

// Automatic media-error attempts per track per 10 min window (G21, H1):
// videoId -> {first attempt time, attempts used}.
const mediaRetryAttempts = new Map<string, MediaRetryRecord>();

/** Pinned state of `videoId`: offline list `_pinned`, else the SW meta; null = unknown. */
async function offlinePinned(videoId: string): Promise<boolean | null> {
	const local = getOfflineTracks().find((t) => t.videoId === videoId);
	if (local?._pinned === true) return true;
	const list = await listCachedAudio().catch(() => null);
	if (!list || !Array.isArray(list.entries)) return null;
	return list.entries.some((e) => e.videoId === videoId && e.pinned === true);
}

/**
 * Media-error retry (G2, H1); decision rules in `planMediaRetry`:
 * - attempt 1: reload the very source that failed (cache-busted unless it is
 *   a stable /localf or /aud URL); never touches the offline copy, since the
 *   error is mostly transient (PIPELINE_ERROR_READ on a fresh context).
 * - attempt 2 (second failure within the window): offline, give up and keep
 *   the copy; online, re-resolve from player.json bypassing the SW copy, and
 *   drop that SW entry first (`uncache-audio`) only when it is known not
 *   pinned and is not a /localf library file.
 * Resolves false when the caller must surface the error (no attempt made).
 */
async function retryMediaSource(videoId: string, playlistId: string | undefined, attempt: number, failedSrc: string): Promise<boolean> {
	// The user moved on during the 400 ms delay: never hijack the new track.
	const cur = SessionListService.$.value.mix?.[SessionListService.$.value.position];
	if (String(cur?.videoId || "") !== videoId) return true;
	const cachedUrl = getCachedUrl(videoId);
	const online = typeof navigator === "undefined" || navigator.onLine !== false;
	const pinned = attempt >= 2 && cachedUrl && online ? await offlinePinned(videoId) : null;
	const step = planMediaRetry({
		attempt,
		failedSrc,
		failedSrcStable: isStableAudioUrl(failedSrc),
		cachedUrl,
		localCopy: isLocalUrl(cachedUrl) || isLocalUrl(failedSrc),
		pinned,
		online,
	});
	if (step.kind === "give_up") return false;
	if (step.kind === "reload") {
		updatePlayerSrc({ url: step.url, original_url: step.url });
		return true;
	}
	if (step.purge) {
		try {
			await swRequest({ type: "uncache-audio", url: cachedUrl, videoId }, "audio-uncached", 3_000);
			await verifyCached(videoId, 1_000);
		} catch {
			/* purge is best-effort */
		}
	}
	await getSrc(videoId, playlistId, undefined, true, { bypassCache: step.bypassCache });
	return true;
}

// Auto-skip guard: skip to the next track on a failure, but never chain skips
// (a dead backend would otherwise race through the whole queue). The streak is
// reset by the next successful setTrack.
let playerFailStreak = 0;

function handleError(err: PlayerRequestError | string | undefined) {
	const e = typeof err === "string" || !err ? new PlayerRequestError(0, "unknown", "UNKNOWN", typeof err === "string" ? err : "") : err;
	console.error("[player] source error", e.code, e.kind, e.status, e.reason);
	// ST3: one report per distinct failure per session (media element errors
	// and player.json failures both end here), no profile data.
	reportClientError(
		String(e.status).startsWith("MEDIA_ERR") ? "media" : "player",
		`${e.kind}/${e.status}${e.code ? " " + e.code : ""}${e.reason ? ": " + e.reason : ""}`,
	);
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
