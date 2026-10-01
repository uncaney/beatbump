import { describe, expect, it, vi } from "vitest";
import {
	DEVICE_ID_KEY,
	REMOTE_CONSUMED_KEY,
	REMOTE_NEWER_MS,
	clockLabel,
	consumedMarker,
	deviceNameFromUA,
	fitResumeState,
	getDeviceId,
	remoteResumeOffer,
	restoreRemoteResume,
	stripDeviceUrls,
	type RestoreRemoteDeps,
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
	it("needs more than 2 minutes over the local state", () => {
		expect(remoteResumeOffer(remote(), "me", now - REMOTE_NEWER_MS, null)).toBeNull();
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

describe("restoreRemoteResume", () => {
	const offer = () => ({ state: stateOf(3, 1), deviceId: "other", updatedAt: 777, deviceName: "iPhone" });
	const makeDeps = (over: Partial<RestoreRemoteDeps> = {}) => {
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

describe("clockLabel", () => {
	it("formats m:ss", () => {
		expect(clockLabel(750)).toBe("12:30");
		expect(clockLabel(5.9)).toBe("0:05");
		expect(clockLabel(NaN)).toBe("0:00");
	});
});
