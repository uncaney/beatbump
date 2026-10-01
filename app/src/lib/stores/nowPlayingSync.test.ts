import { describe, expect, it } from "vitest";
import {
	DEVICE_ID_KEY,
	REMOTE_NEWER_MS,
	clockLabel,
	deviceNameFromUA,
	fitResumeState,
	getDeviceId,
	remoteResumeOffer,
} from "./nowPlayingSync";
import { buildResumeState } from "./resumeState";

const track = (i: number, pad = 0) => ({
	videoId: "0123456789" + (i % 10),
	title: "T" + i + "x".repeat(pad),
	playlistId: "PL",
});
const stateOf = (n: number, position = 0, pad = 0) =>
	buildResumeState({ mix: Array.from({ length: n }, (_, i) => track(i, pad)), position, currentMixType: "local" }, 30, 200, 1000)!;

const memStorage = () => {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
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
	it("is not offered again once consumed", () => {
		expect(remoteResumeOffer(remote(), "me", 0, String(now))).toBeNull();
		expect(remoteResumeOffer(remote(), "me", 0, String(now - 1))).not.toBeNull();
	});
	it("rejects missing / corrupt rows", () => {
		expect(remoteResumeOffer(null, "me", 0, null)).toBeNull();
		expect(remoteResumeOffer(remote({ payload: { v: 1, mix: [] } }), "me", 0, null)).toBeNull();
		expect(remoteResumeOffer(remote({ payload: "not json" }), "me", 0, null)).toBeNull();
		expect(remoteResumeOffer(remote({ updatedAt: 0 }), "me", 0, null)).toBeNull();
		expect(remoteResumeOffer(remote({ deviceId: "" }), "me", 0, null)).toBeNull();
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

describe("clockLabel", () => {
	it("formats m:ss", () => {
		expect(clockLabel(750)).toBe("12:30");
		expect(clockLabel(5.9)).toBe("0:05");
		expect(clockLabel(NaN)).toBe("0:00");
	});
});
