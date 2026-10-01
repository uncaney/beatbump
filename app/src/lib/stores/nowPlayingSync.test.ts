import { describe, expect, it, vi } from "vitest";
import {
	DEVICE_ID_KEY,
	REMOTE_CONSUMED_KEY,
	REMOTE_LIVE_NEWER_MS,
	REMOTE_NEWER_MS,
	REMOTE_REFRESH_THROTTLE_MS,
	clockLabel,
	consumedMarker,
	DEVICE_NAME_KEY,
	DEVICE_NAME_MAX,
	deviceNameFromUA,
	normalizeDeviceName,
	readDeviceName,
	writeDeviceName,
	fitResumeState,
	getDeviceId,
	makeNowPlayingPusher,
	makeRemoteRefresher,
	shouldOfferRemote,
	TAKE_GUARD_MS,
	takeRemoteResume,
	takenAway,
	takenToast,
	wireForegroundRefresh,
	type NowPlayingBody,
	type NowPlayingPusherDeps,
	remoteResumeOffer,
	restoreRemoteResume,
	stripDeviceUrls,
	type RestoreRemoteDeps,
	type ProfileChannelLike,
	wireProfileChannel,
} from "./nowPlayingSync";
import { RESUME_KEY, buildResumeState } from "./resumeState";

const track = (i: number, pad = 0) => ({
	videoId: "0123456789" + (i % 10),
	title: "T" + i + "x".repeat(pad),
	playlistId: "PL",
});
const stateOf = (n: number, position = 0, pad = 0) =>
	buildResumeState({ mix: Array.from({ length: n }, (_, i) => track(i, pad)), position, currentMixType: "local" }, 30, 200, 1000)!;

const memStorage = () => {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		m,
	};
};

describe("deviceNameFromUA", () => {
	it.each([
		["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "iPhone"],
		["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile", "Android"],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", "Mac"],
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128", "Windows"],
		["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128", "Linux"],
		["curl/8.0", "Appareil"],
		["", "Appareil"],
	])("%s -> %s", (ua, want) => {
		expect(deviceNameFromUA(ua)).toBe(want);
	});
	it("handles a missing UA", () => {
		expect(deviceNameFromUA(undefined)).toBe("Appareil");
	});
});

describe("device name (40A)", () => {
	it("normalizes: trim, collapse spaces, cap the length", () => {
		expect(normalizeDeviceName("  iPhone   de\tPaul ")).toBe("iPhone de Camille");
		expect(normalizeDeviceName("x".repeat(80))).toHaveLength(DEVICE_NAME_MAX);
		expect(normalizeDeviceName(null)).toBe("");
	});
	it("saves, reads back and forgets", () => {
		const st = memStorage();
		expect(writeDeviceName(st, " Mac du salon ")).toBe("Mac du salon");
		expect(st.m.get(DEVICE_NAME_KEY)).toBe("Mac du salon");
		expect(readDeviceName(st)).toBe("Mac du salon");
		expect(writeDeviceName(st, "  ")).toBe("");
		expect(st.m.has(DEVICE_NAME_KEY)).toBe(false);
		expect(readDeviceName(st)).toBe("");
	});
	it("survives a missing or throwing storage", () => {
		expect(writeDeviceName(undefined, "x")).toBeNull();
		const bad = {
			getItem: () => {
				throw new Error("no");
			},
			setItem: () => {
				throw new Error("no");
			},
		};
		expect(writeDeviceName(bad, "x")).toBeNull();
		expect(readDeviceName(bad)).toBe("");
	});
	it("the pusher reads the device at each push (a renamed device is sent at once)", async () => {
		let name = "iPhone";
		let t = 0;
		const put = vi.fn(async (_b: NowPlayingBody, _k: boolean) => 200);
		const push = makeNowPlayingPusher({
			device: () => ({ deviceId: "me", deviceName: name }),
			snapshot: () => ({ list: { mix: [track(0)], position: 0, currentMixType: "local" }, currentTime: t, duration: 200 }),
			loggedIn: async () => true,
			put,
		});
		await push();
		name = "iPhone de Camille";
		t = 30;
		await push();
		expect(put.mock.calls.map((c) => c[0].deviceName)).toEqual(["iPhone", "iPhone de Camille"]);
	});
});

describe("getDeviceId", () => {
	it("creates once then stays stable", () => {
		const s = memStorage();
		let n = 0;
		const make = () => "id-" + ++n;
		expect(getDeviceId(s, make)).toBe("id-1");
		expect(getDeviceId(s, make)).toBe("id-1");
		expect(s.m.get(DEVICE_ID_KEY)).toBe("id-1");
	});
	it("still returns an id when storage throws", () => {
		const bad = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {},
		};
		expect(getDeviceId(bad, () => "tmp")).toBe("tmp");
	});
});

describe("remoteResumeOffer", () => {
	const now = 10_000_000;
	const remote = (over: Record<string, unknown> = {}) => ({
		deviceId: "other",
		deviceName: "Mac",
		position: 42,
		payload: stateOf(5, 2),
		updatedAt: now,
		...over,
	});
	it("offers a newer state from another device, at the server position", () => {
		const s = remoteResumeOffer(remote(), "me", now - REMOTE_NEWER_MS - 1, null);
		expect(s).not.toBeNull();
		expect(s!.position).toBe(2);
		expect(s!.currentTime).toBe(42);
		expect(s!.mix[2].title).toBe("T2");
	});
	it("offers when there is no local state", () => {
		expect(remoteResumeOffer(remote(), "me", null, null)).not.toBeNull();
	});
	it("ignores this device's own state", () => {
		expect(remoteResumeOffer(remote({ deviceId: "me" }), "me", 0, null)).toBeNull();
	});
	it("needs more than 10 s over the local state", () => {
		expect(remoteResumeOffer(remote(), "me", now - REMOTE_LIVE_NEWER_MS, null)).toBeNull();
		expect(remoteResumeOffer(remote(), "me", now - REMOTE_LIVE_NEWER_MS - 1, null)).not.toBeNull();
		expect(remoteResumeOffer(remote(), "me", now + 5000, null)).toBeNull();
	});
	it("is silent while this device listens (live savedAt = now)", () => {
		expect(remoteResumeOffer(remote(), "me", now, null)).toBeNull();
	});
	it("is not offered again once consumed (per device, for 2 minutes)", () => {
		expect(remoteResumeOffer(remote(), "me", 0, consumedMarker("other", now))).toBeNull();
		// the same device pushed again 15 s later: still consumed
		expect(remoteResumeOffer(remote({ updatedAt: now + 15_000 }), "me", 0, consumedMarker("other", now))).toBeNull();
		// 2 minutes past the consumed push: offered again
		expect(
			remoteResumeOffer(remote({ updatedAt: now + REMOTE_NEWER_MS }), "me", 0, consumedMarker("other", now)),
		).not.toBeNull();
		// another device is not affected by that consumption
		expect(remoteResumeOffer(remote(), "me", 0, consumedMarker("third", now))).not.toBeNull();
	});
	it("honours a legacy consumed marker (bare updatedAt)", () => {
		expect(remoteResumeOffer(remote(), "me", 0, String(now))).toBeNull();
		expect(remoteResumeOffer(remote(), "me", 0, String(now - 1))).not.toBeNull();
		expect(remoteResumeOffer(remote(), "me", 0, "garbage")).not.toBeNull();
	});
	it("rejects missing / corrupt rows", () => {
		expect(remoteResumeOffer(null, "me", 0, null)).toBeNull();
		expect(remoteResumeOffer(remote({ payload: { v: 1, mix: [] } }), "me", 0, null)).toBeNull();
		expect(remoteResumeOffer(remote({ payload: "not json" }), "me", 0, null)).toBeNull();
		expect(remoteResumeOffer(remote({ updatedAt: 0 }), "me", 0, null)).toBeNull();
		expect(remoteResumeOffer(remote({ deviceId: "" }), "me", 0, null)).toBeNull();
	});
});

describe("stripDeviceUrls", () => {
	const withUrls = () => {
		const s = stateOf(4, 1);
		s.mix[0] = { ...s.mix[0], localUrl: "/aud/abc", IS_LOCAL: true };
		s.mix[2] = { ...s.mix[2], _offlineUrl: "/vp?u=signed", localUrl: "/vp?u=signed" };
		return s;
	};
	it("removes localUrl / _offlineUrl from every row and keeps the rest", () => {
		const s = withUrls();
		const out = stripDeviceUrls(s)!;
		expect(out.mix.some((r) => "localUrl" in r || "_offlineUrl" in r)).toBe(false);
		expect(out.mix[0]).toEqual({ ...s.mix[0], localUrl: undefined });
		expect(out.mix[0].IS_LOCAL).toBe(true);
		expect(out.mix.map((r) => r.videoId)).toEqual(s.mix.map((r) => r.videoId));
		expect(out.position).toBe(1);
		// the local state is untouched (the C1 copy keeps its URLs)
		expect(s.mix[0].localUrl).toBe("/aud/abc");
		expect(s.mix[2]._offlineUrl).toBe("/vp?u=signed");
	});
	it("returns the same object when nothing had to be removed", () => {
		const s = stateOf(3, 0);
		expect(stripDeviceUrls(s)).toBe(s);
		expect(stripDeviceUrls(null)).toBeNull();
	});
	it("is applied by fitResumeState (the remote payload builder)", () => {
		const out = fitResumeState(withUrls())!;
		expect(out.mix.length).toBe(4);
		expect(JSON.stringify(out)).not.toMatch(/localUrl|_offlineUrl/);
	});
});

describe("fitResumeState", () => {
	it("keeps a small state as is", () => {
		const s = stateOf(10, 3);
		expect(fitResumeState(s)).toBe(s);
	});
	it("cuts a long queue around the cursor under the limit", () => {
		const s = stateOf(500, 300, 400);
		expect(JSON.stringify(s).length).toBeGreaterThan(64 * 1024);
		const cut = fitResumeState(s)!;
		expect(JSON.stringify(cut).length).toBeLessThanOrEqual(64 * 1024);
		expect(cut.mix.length).toBeGreaterThan(1);
		expect(cut.mix[cut.position].title).toBe(s.mix[300].title);
	});
	it("null for an empty or impossible state", () => {
		expect(fitResumeState(null)).toBeNull();
		expect(fitResumeState(stateOf(3, 0, 2000), 100)).toBeNull();
	});
});

describe("shouldOfferRemote (40A)", () => {
	const now = 50_000_000;
	const remote = (over: Record<string, unknown> = {}) => ({
		deviceId: "other",
		deviceName: "iPhone",
		position: 42,
		payload: {},
		updatedAt: now,
		...over,
	});
	const local = (over: Partial<Parameters<typeof shouldOfferRemote>[0]> = {}) => ({ deviceId: "me", savedAt: 0, ...over });
	it("offers another device's position newer by more than 10 s", () => {
		expect(shouldOfferRemote(local({ savedAt: now - 10_001 }), remote(), now)).toBe(true);
		expect(shouldOfferRemote(local({ savedAt: now - 10_000 }), remote(), now)).toBe(false);
		expect(shouldOfferRemote(local({ savedAt: null }), remote(), now)).toBe(true);
	});
	it("never offers this device's own row, an older row or a broken one", () => {
		expect(shouldOfferRemote(local(), remote({ deviceId: "me" }), now)).toBe(false);
		expect(shouldOfferRemote(local({ savedAt: now + 60_000 }), remote(), now)).toBe(false);
		expect(shouldOfferRemote(local(), remote({ updatedAt: 0 }), now)).toBe(false);
		expect(shouldOfferRemote(local(), remote({ deviceId: "" }), now)).toBe(false);
		expect(shouldOfferRemote(local(), null, now)).toBe(false);
	});
	it("while this device plays, the local state is now", () => {
		const r = remote({ updatedAt: now - 5_000 });
		expect(shouldOfferRemote(local({ savedAt: now - 60_000 }), r, now)).toBe(true);
		expect(shouldOfferRemote(local({ savedAt: now - 60_000, playing: true }), r, now)).toBe(false);
		expect(shouldOfferRemote(local({ playing: true }), remote({ updatedAt: now + 11_000 }), now)).toBe(true);
	});
	it("keeps the J3 consumed rule", () => {
		expect(shouldOfferRemote(local({ consumed: consumedMarker("other", now - 15_000) }), remote(), now)).toBe(false);
		expect(shouldOfferRemote(local({ consumed: consumedMarker("other", now - REMOTE_NEWER_MS) }), remote(), now)).toBe(true);
	});
});

describe("makeRemoteRefresher (40A)", () => {
	it("runs at most once per 20 s, force skips the throttle", async () => {
		let t = 1_000_000;
		const load = vi.fn(async () => {});
		const refresh = makeRemoteRefresher({ load, now: () => t });
		expect(await refresh()).toBe(true);
		t += REMOTE_REFRESH_THROTTLE_MS - 1;
		expect(await refresh()).toBe(false);
		expect(await refresh(true)).toBe(true);
		t += REMOTE_REFRESH_THROTTLE_MS;
		expect(await refresh()).toBe(true);
		expect(load).toHaveBeenCalledTimes(3);
	});
	it("one run at a time and a failing load is swallowed", async () => {
		let release: () => void = () => {};
		const load = vi.fn(() => new Promise<void>((r) => (release = r)));
		const refresh = makeRemoteRefresher({ load, throttleMs: 0 });
		const first = refresh();
		expect(await refresh(true)).toBe(false);
		release();
		expect(await first).toBe(true);
		const failing = makeRemoteRefresher({ load: () => Promise.reject(new Error("x")) });
		expect(await failing()).toBe(true);
	});
	it("wireForegroundRefresh: visible, focus and pageshow refresh; hidden does not", () => {
		const win = new EventTarget() as unknown as Window;
		const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" }) as unknown as Document & {
			visibilityState: string;
		};
		const refresh = vi.fn();
		const unwire = wireForegroundRefresh(refresh, { win, doc });
		doc.dispatchEvent(new Event("visibilitychange"));
		expect(refresh).not.toHaveBeenCalled();
		(doc as { visibilityState: string }).visibilityState = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		win.dispatchEvent(new Event("focus"));
		win.dispatchEvent(new Event("pageshow"));
		expect(refresh).toHaveBeenCalledTimes(3);
		unwire();
		win.dispatchEvent(new Event("focus"));
		expect(refresh).toHaveBeenCalledTimes(3);
	});
});

describe("restoreRemoteResume", () => {
	const offer = () => ({ state: stateOf(3, 1), deviceId: "other", updatedAt: 777, deviceName: "iPhone" });
	const makeDeps = (over: Partial<Omit<RestoreRemoteDeps, "storage">> = {}) => {
		const storage = memStorage();
		const calls: string[] = [];
		const deps: RestoreRemoteDeps & { storage: ReturnType<typeof memStorage>; calls: string[] } = {
			storage,
			calls,
			restoreInFlight: () => null,
			restoreResumeState: async () => {
				calls.push("restore");
				return true;
			},
			notify: vi.fn(),
			now: () => 5000,
			...over,
		};
		return deps;
	};
	it("waits for the in-flight startup restoration, then restores exactly once", async () => {
		const d = makeDeps();
		const inflight = new Promise<boolean>((resolve) =>
			setTimeout(() => {
				d.calls.push("inflight-done");
				resolve(true);
			}, 50),
		);
		d.restoreInFlight = () => inflight;
		expect(await restoreRemoteResume(offer(), d)).toBe(true);
		expect(d.calls).toEqual(["inflight-done", "restore"]);
		const saved = JSON.parse(d.storage.m.get(RESUME_KEY)!);
		expect(saved.savedAt).toBe(5000);
		expect(saved.position).toBe(1);
		expect(saved.mix[1].title).toBe("T1");
		expect(d.storage.m.get(REMOTE_CONSUMED_KEY)).toBe("other|777");
		expect(d.notify).not.toHaveBeenCalled();
	});
	it("restores once with no restoration in flight", async () => {
		const d = makeDeps();
		expect(await restoreRemoteResume(offer(), d)).toBe(true);
		expect(d.calls).toEqual(["restore"]);
	});
	it("ignores a rejected in-flight restoration and still restores ours", async () => {
		const d = makeDeps({ restoreInFlight: () => Promise.reject(new Error("startup failed")) });
		expect(await restoreRemoteResume(offer(), d)).toBe(true);
		expect(d.calls).toEqual(["restore"]);
	});
	it("on failure: toast, the previous local state is back, nothing consumed", async () => {
		const d = makeDeps({ restoreResumeState: async () => false });
		const before = JSON.stringify(stateOf(2, 0));
		d.storage.setItem(RESUME_KEY, before);
		expect(await restoreRemoteResume(offer(), d)).toBe(false);
		expect(d.storage.m.get(RESUME_KEY)).toBe(before);
		expect(d.storage.m.has(REMOTE_CONSUMED_KEY)).toBe(false);
		expect(d.notify).toHaveBeenCalledTimes(1);
		expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("iPhone"), "error");
	});
	it("a throwing restoration is a failure too; a device without saved state stays without", async () => {
		const d = makeDeps({
			restoreResumeState: async () => {
				throw new Error("boom");
			},
		});
		expect(await restoreRemoteResume(offer(), d)).toBe(false);
		expect(d.storage.m.has(RESUME_KEY)).toBe(false);
		expect(d.storage.m.has(REMOTE_CONSUMED_KEY)).toBe(false);
		expect(d.notify).toHaveBeenCalledTimes(1);
	});
	it("fails cleanly without storage", async () => {
		const d = makeDeps();
		expect(await restoreRemoteResume(offer(), { ...d, storage: undefined })).toBe(false);
		expect(d.calls).toEqual([]);
		expect(d.notify).toHaveBeenCalledTimes(1);
	});
});

describe("makeNowPlayingPusher", () => {
	const mk = (over: Partial<NowPlayingPusherDeps> = {}) => {
		const put = vi.fn(async (_body: NowPlayingBody, _keepalive: boolean) => 200);
		let snap: ReturnType<NowPlayingPusherDeps["snapshot"]> = {
			list: { mix: [track(0), track(1), { ...track(2), localUrl: "/aud/x" }], position: 0, currentMixType: "local" },
			currentTime: 0,
			duration: 200,
		};
		const push = makeNowPlayingPusher({
			device: { deviceId: "me", deviceName: "Mac" },
			snapshot: () => snap,
			loggedIn: async () => true,
			put,
			...over,
		});
		return { push, put, set: (s: Partial<typeof snap>) => (snap = { ...snap, ...s }) };
	};
	it("two pushes without progress = one PUT", async () => {
		const { push, put } = mk();
		expect(await push()).toBe("sent");
		expect(await push()).toBe("skipped");
		expect(put).toHaveBeenCalledTimes(1);
		expect(put).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "me", deviceName: "Mac", position: 0 }), false);
		expect(JSON.stringify(put.mock.calls)).not.toMatch(/localUrl/);
	});
	it("pushes again only when the position moved more than 10 s", async () => {
		const { push, put, set } = mk();
		await push();
		set({ currentTime: 10 });
		expect(await push()).toBe("skipped");
		set({ currentTime: 10.5 });
		expect(await push()).toBe("sent");
		expect(put).toHaveBeenCalledTimes(2);
		expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ position: 10.5 }), false);
	});
	it("pushes on a queue / cursor change at the same position", async () => {
		const { push, put, set } = mk();
		await push();
		set({ list: { mix: [track(0), track(1)], position: 1, currentMixType: "local" } });
		expect(await push()).toBe("sent");
		expect(put).toHaveBeenCalledTimes(2);
	});
	it("retries at the next push after a failed PUT", async () => {
		const put = vi.fn(async (_body: NowPlayingBody, _keepalive: boolean) => 0);
		const { push } = mk({ put });
		expect(await push()).toBe("skipped");
		put.mockResolvedValue(200);
		expect(await push()).toBe("sent");
		expect(await push()).toBe("skipped");
		expect(put).toHaveBeenCalledTimes(2);
	});
	it("sends nothing for an anonymous profile, offline or with an empty queue", async () => {
		const anon = mk({ loggedIn: async () => false });
		expect(await anon.push()).toBe("skipped");
		expect(anon.put).not.toHaveBeenCalled();
		const off = mk({ online: () => false });
		expect(await off.push()).toBe("skipped");
		expect(off.put).not.toHaveBeenCalled();
		const empty = mk();
		empty.set({ list: { mix: [], position: 0 } });
		expect(await empty.push()).toBe("skipped");
		expect(empty.put).not.toHaveBeenCalled();
	});
	it("uses keepalive for a hidden page", async () => {
		const { push, put } = mk();
		await push(true);
		expect(put).toHaveBeenCalledWith(expect.anything(), true);
	});
});

describe("Continuer ici (40A)", () => {
	const snapOf = (t: number) => ({
		list: { mix: [track(0), track(1)], position: 0, currentMixType: "local" as const },
		currentTime: t,
		duration: 200,
	});
	it("a 409 pauses once (onTaken) and stops overwriting the row", async () => {
		let t = 0;
		const put = vi.fn(async (_b: NowPlayingBody, _k: boolean) => ({ status: 409, takenBy: "phone", deviceName: "iPhone de Camille" }));
		const onTaken = vi.fn();
		const push = makeNowPlayingPusher({
			device: { deviceId: "mac", deviceName: "Mac" },
			snapshot: () => snapOf(t),
			loggedIn: async () => true,
			put,
			onTaken,
		});
		expect(await push()).toBe("taken");
		expect(onTaken).toHaveBeenCalledWith({ deviceId: "phone", deviceName: "iPhone de Camille" });
		expect(push.lostTo()).toEqual({ deviceId: "phone", deviceName: "iPhone de Camille" });
		t = 60;
		expect(await push()).toBe("skipped");
		expect(put).toHaveBeenCalledTimes(1);
		expect(onTaken).toHaveBeenCalledTimes(1);
	});
	it("claim (play pressed here again) takes the row back with takenBy, even without progress", async () => {
		const put = vi.fn(async (_b: NowPlayingBody, _k: boolean): Promise<number | { status: number }> => ({ status: 409 }));
		const push = makeNowPlayingPusher({
			device: () => ({ deviceId: "mac", deviceName: "Mac" }),
			snapshot: () => snapOf(30),
			loggedIn: async () => true,
			put,
			now: () => 1234,
		});
		await push();
		expect(push.lostTo()).not.toBeNull();
		put.mockResolvedValue(200);
		push.claim();
		expect(await push()).toBe("sent");
		expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: "mac", takenBy: "mac", takenAt: 1234 }), false);
		expect(push.lostTo()).toBeNull();
		// back to plain pushes: no takenBy, J6 dedupe again
		expect(await push()).toBe("skipped");
	});
	it("a plain push never carries takenBy; markLost / markOwner", async () => {
		const put = vi.fn(async (_b: NowPlayingBody, _k: boolean) => 200);
		const onTaken = vi.fn();
		const push = makeNowPlayingPusher({
			device: { deviceId: "mac", deviceName: "Mac" },
			snapshot: () => snapOf(0),
			loggedIn: async () => true,
			put,
			onTaken,
		});
		await push();
		expect(put.mock.calls[0][0].takenBy).toBeUndefined();
		push.markLost({ deviceId: "phone", deviceName: "iPhone" });
		push.markLost({ deviceId: "phone", deviceName: "iPhone" });
		expect(onTaken).toHaveBeenCalledTimes(1);
		push.markOwner();
		expect(push.lostTo()).toBeNull();
	});
	it("takenAway: another device's live take only", () => {
		const now = 100_000_000;
		const row = (over: Record<string, unknown> = {}) => ({
			deviceId: "phone",
			deviceName: "iPhone de Camille",
			position: 1,
			payload: {},
			updatedAt: now,
			takenBy: "phone",
			takenAt: now - 1000,
			...over,
		});
		expect(takenAway(row(), "mac", now)).toEqual({ deviceId: "phone", deviceName: "iPhone de Camille" });
		expect(takenAway(row(), "phone", now)).toBeNull();
		expect(takenAway(row({ takenBy: undefined }), "mac", now)).toBeNull();
		expect(takenAway(row({ takenAt: now - TAKE_GUARD_MS - 1 }), "mac", now)).toBeNull();
		expect(takenAway(null, "mac", now)).toBeNull();
	});
	it("takenToast names the device in French", () => {
		expect(takenToast("iPhone de Camille")).toBe("Lecture reprise sur iPhone de Camille");
		expect(takenToast("  ")).toBe("Lecture reprise sur un autre appareil");
	});
	it("takeRemoteResume plays the restored queue, then PUTs the take with the offer state", async () => {
		const calls: string[] = [];
		const put = vi.fn(async (_b: NowPlayingBody) => {
			calls.push("put");
			return 200;
		});
		const offer = { state: { ...stateOf(3, 1), currentTime: 77 }, deviceId: "mac", updatedAt: 5, deviceName: "Mac" };
		const ok = await takeRemoteResume(offer, {
			restore: async (o) => {
				calls.push("restore:" + o.autoplay);
				return true;
			},
			device: () => ({ deviceId: "phone", deviceName: "iPhone de Camille" }),
			put,
			markOwner: () => calls.push("owner"),
			now: () => 999,
		});
		expect(ok).toBe(true);
		expect(calls).toEqual(["restore:true", "owner", "put"]);
		expect(put).toHaveBeenCalledWith(
			expect.objectContaining({ deviceId: "phone", deviceName: "iPhone de Camille", takenBy: "phone", takenAt: 999, position: 77 }),
		);
	});
	it("takeRemoteResume takes nothing when the restoration failed", async () => {
		const put = vi.fn(async () => 200);
		const ok = await takeRemoteResume(
			{ state: stateOf(2, 0), deviceId: "mac", updatedAt: 5 },
			{ restore: async () => false, device: () => ({ deviceId: "phone", deviceName: "x" }), put },
		);
		expect(ok).toBe(false);
		expect(put).not.toHaveBeenCalled();
	});
	it("restoreRemoteResume forwards autoplay (paused by default)", async () => {
		const seen: Array<boolean | undefined> = [];
		const deps = (): RestoreRemoteDeps => ({
			storage: memStorage(),
			restoreInFlight: () => null,
			restoreResumeState: async (o) => {
				seen.push(o.autoplay);
				return true;
			},
			notify: vi.fn(),
		});
		const offer = { state: stateOf(2, 0), deviceId: "mac", updatedAt: 5 };
		await restoreRemoteResume(offer, deps());
		await restoreRemoteResume(offer, deps(), { autoplay: true });
		expect(seen).toEqual([false, true]);
	});
});

describe("clockLabel", () => {
	it("formats m:ss", () => {
		expect(clockLabel(750)).toBe("12:30");
		expect(clockLabel(5.9)).toBe("0:05");
		expect(clockLabel(NaN)).toBe("0:00");
	});
});

describe("wireProfileChannel (L14, audit v7)", () => {
	const fakeChannel = (): ProfileChannelLike & { close: ReturnType<typeof vi.fn> } => ({
		onmessage: null,
		close: vi.fn(),
	});

	it("fires onProfileChanged for any message on the channel", () => {
		const channel = fakeChannel();
		const onProfileChanged = vi.fn();
		wireProfileChannel(channel, onProfileChanged);
		expect(channel.onmessage).toBeTypeOf("function");
		channel.onmessage?.({ data: { at: 123 } } as unknown as MessageEvent);
		expect(onProfileChanged).toHaveBeenCalledTimes(1);
		// A second, unrelated message still resets it (payload is never inspected).
		channel.onmessage?.({ data: "anything" } as unknown as MessageEvent);
		expect(onProfileChanged).toHaveBeenCalledTimes(2);
	});

	it("the returned cleanup detaches the handler and closes the channel", () => {
		const channel = fakeChannel();
		const onProfileChanged = vi.fn();
		const cleanup = wireProfileChannel(channel, onProfileChanged);
		cleanup();
		expect(channel.onmessage).toBeNull();
		expect(channel.close).toHaveBeenCalledTimes(1);
	});
});
