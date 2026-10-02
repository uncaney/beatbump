// @vitest-environment jsdom
// c56a: an owned-library id (lid, 11 lowercase hex chars) that reaches getSrc()
// without a `localUrl` and without a service-worker copy must never be sent
// through the YouTube resolver path (`player.json?videoId=<lid>&playlistId=
// undefined&playerParams=undefined`, as seen in the prod log of 2026-10-02
// 13:59:27). It is resolved through the local library player; offline, no
// request at all and a French toast.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const notify = vi.fn();
const mixState = { mix: [] as any[], position: 0 };

vi.mock("$app/environment", () => ({ browser: true, dev: false }));
vi.mock("$stores/list/sessionList", () => ({
	SessionListService: {
		get value() {
			return mixState;
		},
		$: { value: mixState },
		next: vi.fn(),
	},
	isLocalTrackId: (id: unknown) => typeof id === "string" && /^[0-9a-f]{11}$/.test(id),
}));
vi.mock("$lib/api", () => ({
	APIClient: { fetch: (...a: unknown[]) => fetchMock(...a) },
	PREFETCH_INIT: { headers: { "X-Ytm-Prefetch": "1" } },
}));
vi.mock("./api", () => ({
	APIClient: { fetch: (...a: unknown[]) => fetchMock(...a) },
	PREFETCH_INIT: { headers: { "X-Ytm-Prefetch": "1" } },
}));
vi.mock("./offline", () => ({
	announceNowPlaying: vi.fn(),
	cacheTrackOffline: vi.fn(async () => ({ ok: true })),
	getCachedUrl: () => "",
	getOfflineTracks: () => [],
	isLocalUrl: () => false,
	isStableAudioUrl: () => false,
	listCachedAudio: vi.fn(async () => null),
	swRequest: vi.fn(async () => null),
	verifyCached: vi.fn(async () => null),
}));
vi.mock("./utils", async (importOriginal) => {
	const orig = (await importOriginal()) as Record<string, unknown>;
	return { ...orig, notify: (...a: unknown[]) => notify(...a) };
});
vi.mock("./clientLog", () => ({ reportClientError: vi.fn() }));
// The timer worker needs a browser Worker; plain timers do for this guard.
vi.mock("./utils/workerTimeout", () => ({
	setWorkerInterval: (cb: () => void, ms: number) => {
		const id = setInterval(cb, ms);
		return { clear: async () => clearInterval(id) };
	},
	setWorkerTimeout: (cb: () => void, ms: number) => {
		const id = setTimeout(cb, ms);
		return { clear: async () => clearTimeout(id) };
	},
}));
vi.mock("./stores/sleepTimer", () => ({ shouldStopAtTrackEnd: () => false, sleepTimeUpdate: vi.fn(), sleepTrackSkipped: vi.fn(), trackEnded: vi.fn() }));
vi.mock("./stores/nowPlayingSync", () => ({ markMediaSessionGesture: vi.fn() }));
vi.mock("./stores", () => ({ settings: { subscribe: () => () => {} } }));
vi.mock("./stores/sessions", () => ({ groupSession: { initialized: false, hasActiveSession: false } }));
vi.mock("./tabSync", () => ({ syncTabs: { updatePosition: vi.fn(), updateSessionList: vi.fn() } }));
vi.mock("./me", () => ({ recordSkip: vi.fn() }));

function jsonResponse(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
const localPlayerBody = (lid: string) => ({
	playabilityStatus: { status: "OK" },
	videoDetails: { videoId: lid, title: "Global Warming", author: "Sasha Alex Sloan", lengthSeconds: "180" },
	streamingData: { expiresInSeconds: "21600", formats: [], adaptiveFormats: [{ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, url: "/localf?p=lidarr%2FSasha%2FGlobal+Warming.flac", approxDurationMs: "180000" }] },
});

/** The audio node is created on the first click in the real app; give the player one. */
async function loadPlayer() {
	const mod = await import("./player");
	(mod.AudioPlayer as unknown as { player: HTMLMediaElement }).player = document.createElement("audio");
	return mod;
}

describe("getSrc local id guard (c56a)", () => {
	let onLine = true;
	beforeEach(() => {
		fetchMock.mockReset();
		notify.mockReset();
		mixState.mix = [];
		mixState.position = 0;
		onLine = true;
		Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => onLine });
	});
	afterEach(async () => {
		// A test that toasted "passage au suivant" scheduled SessionListService.next()
		// 600 ms later: let it fire here, not during the next test (L15-1 asserts no next()).
		if (notify.mock.calls.some((c) => /passage au suivant/.test(String(c[0])))) {
			await new Promise((r) => setTimeout(r, 700));
		}
		vi.restoreAllMocks();
	});

	it("resolves a lid through the local library player, never with playlistId=undefined&playerParams=undefined", async () => {
		const lid = "19d6b21c8ae";
		mixState.mix = [{ videoId: lid, title: "Global Warming" }]; // restored row: no localUrl
		fetchMock.mockResolvedValueOnce(jsonResponse(200, localPlayerBody(lid)));
		const { getSrc } = await loadPlayer();
		const res = await getSrc(lid, undefined, undefined, true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toBe(`/api/v1/player.json?videoId=${lid}`);
		expect(url).not.toMatch(/playlistId=undefined|playerParams=undefined/);
		expect(res?.error).toBe(false);
		expect(res?.body?.url).toMatch(/\/localf\?p=/);
	});

	it("offline: no request, French toast 'Titre local non disponible hors-ligne'", async () => {
		onLine = false;
		const lid = "1b3ffc43b6e";
		mixState.mix = [{ videoId: lid, title: "x" }, { videoId: "a9505c1dc34", title: "y" }];
		const { getSrc } = await loadPlayer();
		const res = await getSrc(lid, undefined, undefined, true);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(res?.error).toBe(true);
		expect(String(notify.mock.calls[0]?.[0])).toMatch(/^Titre local non disponible hors-ligne/);
	});

	it("unknown lid (404 LOCAL_NOT_FOUND): 'Titre local introuvable', nothing else requested", async () => {
		const lid = "0000000000a";
		mixState.mix = [{ videoId: lid, title: "x" }];
		fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "unplayable", status: "LOCAL_NOT_FOUND", reason: "Titre local introuvable", videoId: lid }));
		const { getSrc } = await loadPlayer();
		const res = await getSrc(lid, undefined, undefined, true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(res?.error).toBe(true);
		expect(String(notify.mock.calls[0]?.[0])).toMatch(/^Titre local introuvable/);
	});

	// L15-1: navigator.onLine true without a real network (one bar of 4G, a
	// captive portal): the service worker answers {"offline":true} with a 200.
	it("SW body {offline:true} on a lid: 'non disponible hors-ligne', never 'introuvable'", async () => {
		const lid = "2c4ffc43b6e";
		mixState.mix = [{ videoId: lid, title: "x" }, { videoId: "a9505c1dc34", title: "y" }];
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { offline: true }));
		const { getSrc } = await loadPlayer();
		const res = await getSrc(lid, undefined, undefined, true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(res?.error).toBe(true);
		expect(String(notify.mock.calls[0]?.[0])).toMatch(/^Titre local non disponible hors-ligne/);
		expect(String(notify.mock.calls[0]?.[0])).not.toMatch(/introuvable/);
	});

	// L15-1: the paused startup restoration (+layout -> restoreResumeState ->
	// getSrc(..., {prefetch, deferToPlay})) of a queue whose current title is
	// not cached: no toast, no "passage au suivant", nothing plays by itself.
	it("startup restore (deferToPlay) offline: no toast, no next(), error returned", async () => {
		onLine = false;
		const lid = "3d5ffc43b6e";
		mixState.mix = [{ videoId: lid, title: "x" }, { videoId: "a9505c1dc34", title: "y" }];
		const { getSrc } = await loadPlayer();
		const { SessionListService } = await import("$stores/list/sessionList");
		(SessionListService.next as ReturnType<typeof vi.fn>).mockClear();
		const res = await getSrc(lid, undefined, undefined, true, { prefetch: true, deferToPlay: true });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(res).toEqual({ body: null, error: true });
		// handleError would schedule SessionListService.next() 600 ms later.
		await new Promise((r) => setTimeout(r, 750));
		expect(notify).not.toHaveBeenCalled();
		expect(SessionListService.next).not.toHaveBeenCalled();
	});

	it("startup restore (deferToPlay) with the SW's {offline:true}: same, quiet", async () => {
		const lid = "4e6ffc43b6e";
		mixState.mix = [{ videoId: lid, title: "x" }, { videoId: "a9505c1dc34", title: "y" }];
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { offline: true }));
		const { getSrc } = await loadPlayer();
		const { SessionListService } = await import("$stores/list/sessionList");
		(SessionListService.next as ReturnType<typeof vi.fn>).mockClear();
		const res = await getSrc(lid, undefined, undefined, true, { prefetch: true, deferToPlay: true });
		expect(res).toEqual({ body: null, error: true });
		await new Promise((r) => setTimeout(r, 750));
		expect(notify).not.toHaveBeenCalled();
		expect(SessionListService.next).not.toHaveBeenCalled();
	});

	it("a YouTube id keeps the regular resolver path", async () => {
		mixState.mix = [{ videoId: "B9TEdLaVWdI", title: "yt" }];
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { ...localPlayerBody("B9TEdLaVWdI"), streamingData: { formats: [], adaptiveFormats: [{ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 1, url: "https://rr1.googlevideo.com/videoplayback?x=1" }] } }));
		const { getSrc } = await loadPlayer();
		await getSrc("B9TEdLaVWdI", "RDAMPL", undefined, true);
		expect(String(fetchMock.mock.calls[0][0])).toMatch(/videoId=B9TEdLaVWdI&playlistId=RDAMPL/);
	});
});
